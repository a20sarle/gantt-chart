const STORAGE_KEY = 'simple-gantt-tasks';
const DAY = 86400000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const COLORS_KEY = 'simple-gantt-group-colors';
let tasks = load();
let groupColors = loadGroupColors();
let editingId = null;

// ---- Project name (click the heading to rename) ----
const NAME_KEY = 'simple-gantt-name';
const DEFAULT_NAME = 'My project';
const nameEl = document.getElementById('projectName');
let projectName = (() => { try { return localStorage.getItem(NAME_KEY) || DEFAULT_NAME; } catch { return DEFAULT_NAME; } })();
function showProjectName() {
  nameEl.textContent = projectName;
  document.title = `${projectName} · Simple Gantt`;
}
function setProjectName(name) {
  projectName = name.trim().replace(/\s+/g, ' ') || DEFAULT_NAME;
  try { localStorage.setItem(NAME_KEY, projectName); } catch {}
  showProjectName();
}
nameEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
  if (e.key === 'Escape') { nameEl.textContent = projectName; nameEl.blur(); }
});
nameEl.addEventListener('blur', () => setProjectName(nameEl.textContent));
showProjectName();

const form = document.getElementById('taskForm');
const errorEl = document.getElementById('error');
const chartEl = document.getElementById('chart');

// ---- Storage ----
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw) || [];
  } catch { return null; }
}
function save() {
  syncGroupColors();
  // Forget collapsed state of groups that no longer exist
  const names = new Set(tasks.map(t => t.group || ''));
  if ([...collapsed].some(g => !names.has(g))) {
    collapsed = new Set([...collapsed].filter(g => names.has(g)));
    saveCollapsed();
  }
  // Forget open subtask lists of tasks that no longer exist
  const ids = new Set(tasks.map(t => t.id));
  if ([...expanded].some(id => !ids.has(id))) {
    expanded = new Set([...expanded].filter(id => ids.has(id)));
    saveExpanded();
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    localStorage.setItem(COLORS_KEY, JSON.stringify(groupColors));
  } catch {}
}

// ---- Group colours: { groupName: paletteIndex }, kept so colours stay stable ----
function loadGroupColors() {
  try { return JSON.parse(localStorage.getItem(COLORS_KEY)); } catch { return null; }
}

// Gives every new group a random palette colour (preferring colours no other
// group is using) and forgets colours of groups that no longer exist.
function syncGroupColors() {
  const names = new Set(tasks.map(t => t.group).filter(Boolean));
  if (!groupColors) {
    // First run with saved tasks from before colours were stored:
    // keep the colours they already had (assigned in creation order).
    groupColors = {};
    [...names].forEach((g, i) => { groupColors[g] = i % PALETTE.length; });
  }
  for (const g of Object.keys(groupColors)) {
    if (!names.has(g) || !PALETTE[groupColors[g]]) delete groupColors[g];
  }
  for (const g of names) {
    if (g in groupColors) continue;
    const used = new Set(Object.values(groupColors));
    const free = PALETTE.map((_, i) => i).filter(i => !used.has(i));
    const pool = free.length ? free : PALETTE.map((_, i) => i);
    groupColors[g] = pool[Math.floor(Math.random() * pool.length)];
  }
}

// ---- Date helpers (all dates handled as UTC midnight to avoid DST drift) ----
const parse = s => new Date(s + 'T00:00:00Z');
const fmt = d => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((b - a) / DAY);
// Today's date as "YYYY-MM-DD" in the user's own time zone (not UTC)
const todayString = () => { const d = new Date(); return fmt(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); };

// ---- Form ----
form.addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (parse(data.end) < parse(data.start)) {
    errorEl.textContent = 'End date must be on or after the start date.';
    return;
  }
  errorEl.textContent = '';
  data.group = data.group.trim();
  let changed = null;
  if (editingId) {
    const task = tasks.find(t => t.id === editingId);
    changed = { before: { ...task }, task };
    Object.assign(task, data);
  } else {
    tasks.push({ id: uid(), ...data });
  }
  resetForm();
  save(); render();
  if (changed) await offerToShiftFollowing(changed.before, changed.task);
});

document.getElementById('cancelEdit').onclick = resetForm;

// ---- Links between tasks ----
// A link means "this task can't start until that one has finished". Each task
// stores the ids of the tasks it comes after in `after`.
const successorsOf = id => tasks.filter(t => (t.after || []).includes(id));

// Every task that comes after any of `ids`, directly or further down the chain
function downstreamOf(ids) {
  const seen = new Set(), queue = [...ids];
  while (queue.length) {
    for (const s of successorsOf(queue.shift())) {
      if (!seen.has(s.id)) { seen.add(s.id); queue.push(s.id); }
    }
  }
  ids.forEach(id => seen.delete(id));
  return tasks.filter(t => seen.has(t.id));
}

// Can `to` be linked to come after `from`? Not to itself, not twice, and not
// if `from` already comes after `to` somewhere (that would make a loop).
function canLink(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  const to = tasks.find(t => t.id === toId);
  if ((to.after || []).includes(fromId)) return false;
  return !downstreamOf([toId]).some(t => t.id === fromId);
}

// "Push only when needed": how many days each linked task must move so that
// none starts before a task it comes after has ended. Works through the chain
// on copies of the dates; the tasks just moved (`movedIds`) are not changed.
function planPush(movedIds) {
  const dates = new Map(tasks.map(t => [t.id, { start: t.start, end: t.end }]));
  const shifts = new Map();
  const fixed = new Set(movedIds), queue = [...movedIds];
  while (queue.length) {
    const pid = queue.shift(), p = dates.get(pid);
    for (const s of successorsOf(pid)) {
      if (fixed.has(s.id)) continue;
      const d = dates.get(s.id);
      const need = daysBetween(parse(d.start), parse(p.end)) + 1; // days to move so it starts the day after
      if (need > 0) {
        d.start = fmt(new Date(+parse(d.start) + need * DAY));
        d.end = fmt(new Date(+parse(d.end) + need * DAY));
        shifts.set(s.id, (shifts.get(s.id) || 0) + need);
        queue.push(s.id);
      }
    }
  }
  return shifts;
}

const shiftTask = (t, days) => {
  t.start = fmt(new Date(+parse(t.start) + days * DAY));
  t.end = fmt(new Date(+parse(t.end) + days * DAY));
};

// When a task's end date moves, ask what to do with the tasks that come after it:
// - linked tasks (and the rest of their chain): push only when needed, keep the
//   same gap, or don't move (a task left starting too early gets a red arrow);
// - other tasks that start later (not linked): move those in the same group,
//   in all groups, or don't move.
// `task` can also stand for a whole group that was dragged ({ isGroup: true });
// `exclude` holds the ids of tasks that already moved.
async function offerToShiftFollowing(before, task, exclude = new Set([task.id])) {
  const delta = daysBetween(parse(before.end), parse(task.end));
  if (!delta) return;
  const movedIds = [...exclude];
  const linked = downstreamOf(movedIds).filter(t => !exclude.has(t.id))
    .sort((a, b) => a.start.localeCompare(b.start));
  const linkedIds = new Set(linked.map(t => t.id));
  const later = tasks
    .filter(t => !exclude.has(t.id) && !linkedIds.has(t.id) && t.start > before.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!linked.length && !later.length) return;
  const sameGroup = later.filter(t => (t.group || '') === task.group);
  const pushPlan = planPush(movedIds);

  const choice = await askShift(task, delta, { linked, pushPlan, later, sameGroup });

  if (choice.linked === 'push') pushPlan.forEach((days, id) => shiftTask(tasks.find(t => t.id === id), days));
  if (choice.linked === 'gap') linked.forEach(t => shiftTask(t, delta));
  const others = choice.others === 'group' ? sameGroup : choice.others === 'all' ? later : [];
  others.forEach(t => shiftTask(t, delta));
  if (choice.linked !== 'gap' && !(choice.linked === 'push' && pushPlan.size) && !others.length) return;

  if (editingId) { // keep the form in sync if the task being edited moved
    const t = tasks.find(t => t.id === editingId);
    form.start.value = t.start; form.end.value = t.end;
  }
  save(); render();
}

// Shows the "Move the tasks that come after?" dialog. Resolves with
// { linked: 'push' | 'gap' | 'none', others: 'group' | 'all' | 'none' }.
function askShift(task, delta, { linked, pushPlan, later, sameGroup }) {
  const dlg = document.getElementById('shiftDialog');
  const daysText = n => `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;
  const dir = delta > 0 ? 'later' : 'earlier';
  const option = (name, value, label, detail, checked) =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}>
       <span><b>${label}</b><small>${detail}</small></span></label>`;
  const names = list => `<ul>${list.map(t => `<li>${esc(t.name)}</li>`).join('')}</ul>`;
  let html = '';

  if (linked.length) {
    const pushed = linked.filter(t => pushPlan.has(t.id));
    const pushDetail = pushed.length
      ? pushed.map(t => `${esc(t.name)} moves ${daysText(pushPlan.get(t.id))} later`).join(', ')
      : 'There is enough room, so nothing needs to move';
    const gapDetail = `${linked.length === 1 ? 'It moves' : linked.length === 2 ? 'Both move' : `All ${linked.length} move`} ${daysText(delta)} ${dir}`;
    const noneDetail = pushed.length
      ? `${pushed.length === 1 ? '1 task' : `${pushed.length} tasks`} will start too early (shown with a red arrow)`
      : 'They stay where they are';
    html += `<section><h3>Linked tasks</h3>${names(linked)}
      ${option('linked', 'push', 'Push only when needed', pushDetail, true)}
      ${option('linked', 'gap', 'Keep the same gap', gapDetail, false)}
      ${option('linked', 'none', "Don't move", noneDetail, false)}
    </section>`;
  }
  if (later.length) {
    const byGroup = new Map([[task.group, []]]);
    for (const t of later) {
      const g = t.group || '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(t);
    }
    const lists = [...byGroup].filter(([, l]) => l.length).map(([g, l]) =>
      `<h4>${esc(groupLabel(g))}${g === task.group ? ' (this group)' : ''}</h4>${names(l)}`).join('');
    const hasOtherGroups = later.length > sameGroup.length;
    const count = n => `${n} task${n > 1 ? 's move' : ' moves'} ${daysText(delta)} ${dir}`;
    html += `<section><h3>${linked.length ? 'Other tasks that come after (not linked)' : 'Tasks that come after'}</h3>${lists}
      ${sameGroup.length ? option('others', 'group', hasOtherGroups ? 'Only this group' : 'Move them', count(sameGroup.length), !linked.length) : ''}
      ${hasOtherGroups ? option('others', 'all', sameGroup.length ? 'All groups' : 'Move them', count(later.length), !linked.length && !sameGroup.length) : ''}
      ${option('others', 'none', "Don't move", 'They stay where they are', !!linked.length)}
    </section>`;
  }

  document.getElementById('shiftTitle').textContent = 'Move the tasks that come after?';
  document.getElementById('shiftText').innerHTML =
    `${task.isGroup ? 'The group ' : ''}<b>${esc(task.name)}</b> now ends ${daysText(delta)} ${dir}.`;
  document.getElementById('shiftList').innerHTML = html;

  return new Promise(resolve => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      const picked = name => dlg.returnValue === 'apply'
        ? (dlg.querySelector(`input[name="${name}"]:checked`)?.value || 'none') : 'none';
      resolve({ linked: picked('linked'), others: picked('others') });
    }, { once: true });
    dlg.showModal();
    dlg.querySelector('button[value="apply"]').focus();
  });
}

// A small yes/no dialog. Resolves with true if confirmed.
function askConfirm(title, html, okLabel) {
  const dlg = document.getElementById('confirmDialog');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').innerHTML = html;
  document.getElementById('confirmOk').textContent = okLabel;
  return new Promise(resolve => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

function resetForm() {
  editingId = null;
  form.reset();
  document.getElementById('submitBtn').textContent = 'Add task';
  document.getElementById('cancelEdit').hidden = true;
  showForm(false);
}

// On phones the form is folded away behind "+ New task" (styles.css); it opens
// when you tap that button or edit a task, and closes after saving or cancelling.
const formPanel = document.querySelector('.form-panel');
function showForm(open) {
  formPanel.classList.toggle('open', open);
  document.getElementById('newTaskBtn').textContent = open ? 'Close' : '+ New task';
}
document.getElementById('newTaskBtn').onclick = () => {
  const opening = !formPanel.classList.contains('open');
  if (!opening && editingId) return resetForm();
  showForm(opening);
  if (opening) form.name.focus();
};

function startEdit(id) {
  const t = tasks.find(t => t.id === id);
  editingId = id;
  form.name.value = t.name; form.group.value = t.group || '';
  form.start.value = t.start; form.end.value = t.end;
  form.milestone.value = t.milestone || '';
  document.getElementById('submitBtn').textContent = 'Save';
  document.getElementById('cancelEdit').hidden = false;
  showForm(true);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  form.start.focus();
}

function removeTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  tasks.forEach(t => { if (t.after) t.after = t.after.filter(a => a !== id); }); // drop its links
  if (editingId === id) resetForm();
  save(); render();
}

// ---- Toolbar ----
// Zoom is the width of one day, in px. Pinching zooms freely; the last zoom is
// remembered. A day can be as wide as the whole timeline (for the Day view).
const ZOOM_KEY = 'simple-gantt-zoom';
const MIN_DAY_W = 2;
// On a phone the Chart is turned (time runs down, see renderTurned); these
// measure and scroll along the time axis, whichever way it runs.
const turnedEl = document.getElementById('turned');
const turnedOn = () => document.documentElement.classList.contains('phone-chart');
const TURNED_HEAD = 110, TURNED_DATES = 58;      // header height and date column width (match styles.css)
const timeLength = () => turnedOn() ? turnedEl.clientHeight - TURNED_HEAD : chartEl.clientWidth - labelsW();
const getTimeScroll = () => turnedOn() ? turnedEl.scrollTop : chartEl.scrollLeft;
const setTimeScroll = px => { if (turnedOn()) turnedEl.scrollTop = px; else chartEl.scrollLeft = px; };
const maxDayW = () => Math.max(60, timeLength());
let zoom = 28;
try { const z = +localStorage.getItem(ZOOM_KEY); if (z >= MIN_DAY_W && z <= 5000) zoom = z; } catch {}
function setZoom(px, { keepView = false } = {}) {
  overviewReturn = null;                // any other zoom leaves the overview
  if (!keepView) showView(null);        // ...and pinching leaves Day / Week / Month / Quarter
  px = Math.min(maxDayW(), Math.max(MIN_DAY_W, px));
  zoom = px;
  try { localStorage.setItem(ZOOM_KEY, px); } catch {}
  render();
}

// ---- Day / Week / Month / Quarter, like a calendar app ----
// Each shows exactly one period across the timeline: the day, week (Monday to
// Sunday), month or quarter around the date you're looking at. ‹ and › step one
// period back or forward, Today jumps to today's period. The view is remembered.
const VIEW_KEY = 'simple-gantt-view';
let view = null;       // 'day' | 'week' | 'month' | 'quarter' | null (free zoom)
let viewDate = null;   // a date ("YYYY-MM-DD") inside the period shown
let viewRange = null;  // { start, end } of the period shown, kept inside the chart's range
function showView(v) {
  view = v;
  if (!v) viewRange = null;
  try { v ? localStorage.setItem(VIEW_KEY, v) : localStorage.removeItem(VIEW_KEY); } catch {}
}

// The period of a view that contains `date`: { start, end } (end included)
function periodOf(v, date) {
  const d = parse(date), y = d.getUTCFullYear(), m = d.getUTCMonth();
  const at = (yy, mm, dd) => fmt(new Date(Date.UTC(yy, mm, dd)));
  if (v === 'day') return { start: date, end: date };
  if (v === 'week') {
    const monday = new Date(+d - ((d.getUTCDay() || 7) - 1) * DAY);
    return { start: fmt(monday), end: fmt(new Date(+monday + 6 * DAY)) };
  }
  if (v === 'month') return { start: at(y, m, 1), end: at(y, m + 1, 0) };
  const q = m - m % 3;                                                       // quarter
  return { start: at(y, q, 1), end: at(y, q + 3, 0) };
}

// Shows view `v` for the period containing `date`
function openView(v, date) {
  const p = periodOf(v, date);
  showView(v);
  viewDate = date;
  viewRange = p;
  const days = daysBetween(parse(p.start), parse(p.end)) + 1;
  setZoom(timeLength() / days, { keepView: true });
  setTimeScroll(daysBetween(chartStart, parse(p.start)) * renderedDayW);
  tidyHeaderLabels();
}

document.getElementById('viewBtns').onclick = e => {
  const btn = e.target.closest('[data-view]');
  if (btn) openView(btn.dataset.view, view ? viewDate : todayString());
};

// ‹ and ›: one period back or forward (one screen when zoomed freely)
function step(dir) {
  if (!view) { setTimeScroll(getTimeScroll() + dir * timeLength()); return; }
  const d = parse(viewDate), y = d.getUTCFullYear(), m = d.getUTCMonth();
  const next = view === 'day' ? new Date(+d + dir * DAY)
    : view === 'week' ? new Date(+d + dir * 7 * DAY)
    : new Date(Date.UTC(y, m + dir * (view === 'month' ? 1 : 3), 1));
  openView(view, fmt(next));
}
document.getElementById('prevBtn').onclick = () => step(-1);
document.getElementById('nextBtn').onclick = () => step(1);

// Scrolls the chart so today sits a little in from the left edge of the timeline
function scrollToToday() {
  if (!timelineEl()) return;
  const x = daysBetween(chartStart, parse(todayString())) * renderedDayW;
  setTimeScroll(Math.max(0, x - timeLength() / 4));
}
// Today: today's period in Day / Week / Month / Quarter, otherwise scroll to today
document.getElementById('todayBtn').onclick = () =>
  document.documentElement.classList.contains('phone-schedule') ? scrollScheduleToThisWeek()
  : view ? openView(view, todayString()) : scrollToToday();

// Overview: zoom so the whole project (first start to last end, plus a day on
// each side) fits the visible width, and scroll to the top. Clicking again goes
// back to the zoom and position from before.
let overviewReturn = null; // { dayW, leftDay, top } while the overview is showing
document.getElementById('overviewBtn').onclick = () => {
  if (overviewReturn) {
    const back = overviewReturn;
    setZoom(back.dayW); // also clears overviewReturn
    setTimeScroll((back.leftDay - dayNumber(chartStart)) * renderedDayW);
    chartEl.scrollTop = back.top;
    return render(); // refresh the button
  }
  if (!tasks.length) return;
  const back = { dayW: renderedDayW, leftDay: dayNumber(chartStart) + getTimeScroll() / renderedDayW, top: chartEl.scrollTop };
  const first = Math.min(...tasks.map(t => +parse(t.start))), last = Math.max(...tasks.map(t => +parse(t.end)));
  const days = daysBetween(first, last) + 1 + 2; // the project plus a day either side
  setZoom(timeLength() / days); // setZoom keeps it within the zoom limits
  setTimeScroll(daysBetween(chartStart, first - DAY) * renderedDayW);
  chartEl.scrollTop = 0;
  overviewReturn = back;
  render(); // refresh the button
};

// ---- Sharing: save the chart as an image ----
// The image is made from a copy of the whole chart (just the project's dates,
// every row, always in light colours) with the project name and date above it.
let exportOpts = null; // { dayW, first, last } while rendering that copy
const IMAGE_W = 1600;  // width the image aims for
const longDate = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fileSlug = () => `${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gantt'}-${todayString()}`;

// Fills #exportArea with the title and a copy of the chart fitted to about
// `targetW` px wide. Returns the area, or null when there are no tasks.
function buildExport(targetW) {
  if (!tasks.length) return null;
  const first = Math.min(...tasks.map(t => +parse(t.start))), last = Math.max(...tasks.map(t => +parse(t.end)));
  const days = daysBetween(first, last) + 3;
  const keep = { leftDay: dayNumber(chartStart) + chartEl.scrollLeft / renderedDayW, top: chartEl.scrollTop };
  // The image always shows the normal chart with its list, also on a phone
  const phoneClasses = ['phone-schedule', 'phone-chart'].filter(c => document.documentElement.classList.contains(c));
  document.documentElement.classList.remove(...phoneClasses);
  // Draw the chart at the export size, copy it, then draw the normal view again
  // (all in one go, so the screen never shows the export version)
  const dayW = Math.min(28, Math.max(2, (targetW - labelsW()) / days));
  const listW = labelsW(); // the copy keeps this list width, whatever the screen does later
  exportOpts = { dayW, first, last };
  render();
  const chart = chartEl.querySelector('.chart').cloneNode(true);
  exportOpts = null;
  document.documentElement.classList.add(...phoneClasses);
  render();
  chartEl.scrollLeft = (keep.leftDay - dayNumber(chartStart)) * renderedDayW;
  chartEl.scrollTop = keep.top;

  chart.querySelectorAll('.hspan > span').forEach(l => { l.style.visibility = ''; }); // no scrolling in the copy
  const area = document.getElementById('exportArea');
  area.innerHTML = `<header class="export-title"><h1>${esc(projectName)}</h1>
    <p>Made ${longDate(Date.now())} · ${longDate(first)} – ${longDate(last)}</p></header>`;
  area.appendChild(chart);
  area.style.setProperty('--labels-w', listW + 'px');
  return area;
}

// The image library (html-to-image) is loaded from cdnjs the first time it's needed
let imageLib = null;
function loadImageLib() {
  return imageLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html-to-image/1.11.13/html-to-image.js';
    s.integrity = 'sha512-4W7+nCTcMQMFBnTRwvixN7il649NCqZiBfJ7WvzU7gxF12zOnaKwVYTSIzwrjy/cy+CPQxn2lAIVZIes+rPp2Q==';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.htmlToImage);
    s.onerror = () => { imageLib = null; reject(new Error('offline')); };
    document.head.appendChild(s);
  });
}

document.getElementById('imageBtn').onclick = async () => {
  const btn = document.getElementById('exportMenuBtn'); // shows "Saving…" while the image is made
  const area = buildExport(IMAGE_W);
  if (!area) return;
  btn.disabled = true; btn.textContent = 'Saving…';
  area.classList.add('capturing'); // laid out off-screen so it can be photographed
  try {
    const lib = await loadImageLib();
    const url = await lib.toPng(area, {
      pixelRatio: 2, backgroundColor: '#ffffff',
      style: { position: 'static', left: '0', top: '0' }, // the picture itself isn't off-screen
    });
    Object.assign(document.createElement('a'), { href: url, download: `${fileSlug()}.png` }).click();
  } catch {
    await askConfirm('Could not save the image',
      'Saving an image needs an internet connection (it loads a small helper from cdnjs).', 'OK');
  } finally {
    area.classList.remove('capturing'); area.innerHTML = '';
    btn.disabled = false; btn.textContent = 'Export ▾';
  }
};

// ---- Zooming by pinching ----
// Only a pinch zooms (trackpad, phone, Safari on a Mac), around the day under the
// pointer or between the fingers. Ordinary scrolling is left to the browser:
// up/down scrolls the chart and list, sideways moves through time.
// Trackpad pinches arrive as Ctrl+wheel, so Ctrl + mouse wheel zooms as well.
let zoomPending = null; // { px, clientX }: applied once per animation frame

// Zooms to `px` per day, keeping the day under screen position `clientX` in place
function zoomTo(px, clientX) {
  px = Math.min(maxDayW(), Math.max(MIN_DAY_W, px));
  if (!zoomPending) requestAnimationFrame(applyZoom);
  zoomPending = { px, clientX };
}
const zoomBy = (factor, clientX) => zoomTo((zoomPending ? zoomPending.px : renderedDayW) * factor, clientX);

function applyZoom() {
  const { px, clientX } = zoomPending;
  zoomPending = null;
  if (Math.abs(px - renderedDayW) < 0.01) return;
  const anchorX = clientX - (chartEl.getBoundingClientRect().left + labelsW()); // from the timeline's visible left edge
  const day = pointerDay(clientX);
  setZoom(px);
  chartEl.scrollLeft = (day - dayNumber(chartStart)) * renderedDayW - anchorX;
}

chartEl.addEventListener('wheel', e => {
  const tl = timelineEl();
  if (!e.ctrlKey || !tl || !tl.contains(e.target) || drag) return; // plain scrolling: left to the browser
  e.preventDefault(); // stop the browser zooming the whole page
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tl.clientWidth : 1; // lines/pages -> px
  // Pinches send small steps; a Ctrl + mouse-wheel notch sends ~100 (≈ 15% per notch)
  const dy = e.deltaY * unit;
  zoomBy(Math.exp(-dy * (Math.abs(dy) >= 50 ? 0.0015 : 0.01)), e.clientX);
}, { passive: false });

// Safari on a Mac reports trackpad pinches as gesture events instead
let gestureStartW = null;
chartEl.addEventListener('gesturestart', e => {
  if (!timelineEl()?.contains(e.target)) return;
  e.preventDefault();
  gestureStartW = renderedDayW;
});
chartEl.addEventListener('gesturechange', e => {
  if (gestureStartW === null) return;
  e.preventDefault();
  zoomTo(gestureStartW * e.scale, e.clientX);
});
chartEl.addEventListener('gestureend', () => { gestureStartW = null; });

// Phones and tablets: two-finger pinch on the timeline
let pinch = null;
const touchGap = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
chartEl.addEventListener('touchstart', e => {
  if (e.touches.length !== 2 || !timelineEl()?.contains(e.target)) return;
  cancelDrag(); // the first finger may have started a drag
  pinch = { gap: touchGap(e.touches[0], e.touches[1]), dayW: renderedDayW };
}, { passive: true });
chartEl.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  zoomTo(pinch.dayW * touchGap(a, b) / pinch.gap, (a.clientX + b.clientX) / 2);
}, { passive: false });
chartEl.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });

document.getElementById('clearBtn').onclick = async () => {
  if (tasks.length && await askConfirm('Delete all tasks?', 'Every task, group and link will be removed. Export first if you want a copy.', 'Delete all')) {
    tasks = []; save(); render();
  }
};
// ---- Export menu: Image (.png), Calendar (.ics), JSON ----
// Opens on click; closes when an item is picked, on a click elsewhere, or with Esc.
const exportMenuBtn = document.getElementById('exportMenuBtn');
const exportMenu = document.getElementById('exportMenu');
function showExportMenu(open) {
  exportMenu.hidden = !open;
  exportMenuBtn.setAttribute('aria-expanded', open);
  if (open) exportMenu.querySelector('button').focus();
}
exportMenuBtn.onclick = () => showExportMenu(exportMenu.hidden);
exportMenu.addEventListener('click', e => { if (e.target.closest('button')) showExportMenu(false); });
document.addEventListener('pointerdown', e => {
  if (!exportMenu.hidden && !e.target.closest('.menu-wrap')) showExportMenu(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !exportMenu.hidden) { showExportMenu(false); exportMenuBtn.focus(); }
});

// ---- Phones: Schedule view, or the Chart turned ----
// On narrow screens the app opens on a Schedule: weeks as headings and each
// task as a card, scrolled downwards through time (like Google Calendar's
// Schedule view). "Chart" switches to the Gantt chart turned a quarter, so it
// also scrolls downwards through time (see renderTurned).
// The choice is remembered. Classes on <html> switch the layout (styles.css).
const PHONE_VIEW_KEY = 'simple-gantt-phone-view';
const phoneQuery = matchMedia('(max-width: 640px)');
let phoneView = (() => { try { return localStorage.getItem(PHONE_VIEW_KEY) === 'chart' ? 'chart' : 'schedule'; } catch { return 'schedule'; } })();
const scheduleOpen = new Set(); // cards opened to show their details

function applyPhoneLayout() {
  const phone = phoneQuery.matches, root = document.documentElement;
  root.classList.toggle('phone-schedule', phone && phoneView === 'schedule');
  root.classList.toggle('phone-chart', phone && phoneView === 'chart');
  for (const b of document.querySelectorAll('#phoneViewBtns [data-phone]')) b.classList.toggle('active', b.dataset.phone === phoneView);
}
function setPhoneView(v) {
  phoneView = v;
  try { localStorage.setItem(PHONE_VIEW_KEY, v); } catch {}
  applyPhoneLayout();
  render();
  if (v === 'schedule') scrollScheduleToThisWeek();
  else if (view) openView(view, viewDate || todayString());
  else scrollToToday();
}
document.getElementById('phoneViewBtns').onclick = e => {
  const b = e.target.closest('[data-phone]');
  if (b) setPhoneView(b.dataset.phone);
};
phoneQuery.addEventListener('change', () => { applyPhoneLayout(); render(); });

const scheduleEl = document.getElementById('schedule');
const weekStartOf = s => fmt(new Date(+parse(s) - ((parse(s).getUTCDay() || 7) - 1) * DAY));
const shortRange = (a, b) => {
  const o = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (a === b) return parse(a).toLocaleDateString(undefined, o);
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return `${sameMonth ? parse(a).getUTCDate() : parse(a).toLocaleDateString(undefined, o)}–${parse(b).toLocaleDateString(undefined, o)}`;
};

function renderSchedule() {
  if (!document.documentElement.classList.contains('phone-schedule')) return;
  const today = todayString(), thisWeek = weekStartOf(today);
  syncGroupColors();
  const colour = g => g ? PALETTE[groupColors[g]] || UNGROUPED_COLOR : UNGROUPED_COLOR;
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));
  // Each task is listed in the week it starts; tasks still running from earlier
  // weeks are also listed at the top of this week.
  const weeks = new Map();
  const add = (w, t, ongoing) => { if (!weeks.has(w)) weeks.set(w, []); weeks.get(w).push({ t, ongoing }); };
  for (const t of sorted) {
    if (t.start < thisWeek && t.end >= thisWeek) add(thisWeek, t, true);
    add(weekStartOf(t.start), t, false);
  }
  if (!weeks.has(thisWeek)) weeks.set(thisWeek, []);

  const card = ({ t, ongoing }) => {
    const c = colour(t.group), subs = t.subtasks || [], pct = progressOf(t), open = scheduleOpen.has(t.id);
    const links = t.links || [];
    const status = subs.length
      ? `<button class="status ring" style="--pct:${pct}" data-task="${t.id}" title="${pct}% done"></button>`
      : `<button class="status${t.done ? ' checked' : ''}" data-task="${t.id}" title="${t.done ? 'Done' : 'Mark as done'}">${t.done ? '✓' : ''}</button>`;
    const meta = [
      ongoing ? `since ${shortRange(t.start, t.start)}, until ${shortRange(t.end, t.end)}` : shortRange(t.start, t.end),
      t.group || '', subs.length ? `${subs.filter(s => s.done).length}/${subs.length}` : '',
      links.length ? `📎${links.length > 1 ? links.length : ''}` : '',
    ].filter(Boolean).join(' · ');
    const details = !open ? '' : `<div class="sched-details">
      ${subs.map(s => `<label class="sched-sub"><input type="checkbox" class="sub-done" data-task="${t.id}" data-sub="${s.id}" ${s.done ? 'checked' : ''}>
        <span class="${s.done ? 'sub-checked' : ''}">${esc(s.name)}</span>
        ${(s.links || []).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(linkLabel(l.url))}</a>`).join('')}</label>`).join('')}
      ${links.map(l => `<a class="sched-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(linkLabel(l.url))}</a>`).join('')}
      <button class="sched-edit" data-task="${t.id}">Edit dates, group and more</button>
    </div>`;
    return `<article class="sched-card${pct === 100 ? ' done' : ''}${open ? ' open' : ''}" data-id="${t.id}" style="--bar:${c.bg}">
      <div class="sched-main">${status}
        <div class="sched-text"><div class="sched-name">${t.milestone ? '<i class="ms-icon"></i>' : ''}${esc(t.name)}</div>
        <div class="sched-meta">${esc(meta)}</div></div></div>${details}</article>`;
  };

  scheduleEl.innerHTML = [...weeks.keys()].sort().map(w => {
    const end = fmt(new Date(+parse(w) + 6 * DAY));
    return `<section class="sched-week${w === thisWeek ? ' current' : ''}" data-week="${w}">
      <h3>Week ${isoWeek(parse(w))} · ${shortRange(w, end)}${w === thisWeek ? ' · This week' : ''}</h3>
      ${weeks.get(w).map(card).join('') || '<p class="sched-empty">Nothing starts this week.</p>'}
    </section>`;
  }).join('') || '<p class="sched-empty">No tasks yet. Tap “+ New task” to add one.</p>';
}

document.getElementById('schedTodayBtn').onclick = () => scrollScheduleToThisWeek();
function scrollScheduleToThisWeek() {
  const cur = scheduleEl.querySelector('.sched-week.current');
  if (cur) scheduleEl.scrollTop = cur.offsetTop - scheduleEl.offsetTop;
}

scheduleEl.addEventListener('click', e => {
  if (e.target.closest('a, input, label')) return; // links open, tick boxes tick
  const status = e.target.closest('button.status');
  const edit = e.target.closest('.sched-edit');
  const cardEl = e.target.closest('.sched-card');
  if (!cardEl) return;
  const t = tasks.find(t => t.id === cardEl.dataset.id);
  if (edit) return startEdit(t.id);
  if (status && !status.classList.contains('ring')) { t.done = !t.done; save(); render(); return; }
  scheduleOpen.has(t.id) ? scheduleOpen.delete(t.id) : scheduleOpen.add(t.id); // tap a card (or its ring): details
  renderSchedule();
});
scheduleEl.addEventListener('change', e => {
  if (!e.target.matches('.sub-done')) return;
  const t = tasks.find(t => t.id === e.target.dataset.task);
  t.subtasks.find(s => s.id === e.target.dataset.sub).done = e.target.checked;
  save(); render();
});

// ---- Phones: the Chart turned a quarter (time runs down) ----
// On a phone, Chart shows the Gantt chart turned: dates run down the left side
// and each task is a vertical bar in its own column, so swiping up/down moves
// through time. The header (group names, task names written upwards) stays at
// the top and the dates stay at the left while scrolling. It uses the same
// zoom (the height of one day) and the same Day/Week/Month/Quarter, ‹ ›, Today
// and Overview buttons; a pinch zooms. Tap a bar or a name to edit the task,
// tap a group name to collapse or expand the group.
function renderTurned(min, totalDays, H, todayDate) {
  if (!turnedOn() || exportOpts) return;
  syncGroupColors();
  const colour = g => g ? PALETTE[groupColors[g]] || UNGROUPED_COLOR : UNGROUPED_COLOR;
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));
  const groups = new Map();
  for (const t of sorted) { const g = t.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  const order = [...displayedGroups.filter(g => groups.has(g)), ...(groups.has('') ? [''] : [])];
  const hasGroups = displayedGroups.length > 0;

  // One column per task; a collapsed group is a single column
  const cols = [];
  for (const g of order) {
    if (hasGroups && collapsed.has(g)) cols.push({ g, list: groups.get(g) });
    else groups.get(g).forEach(t => cols.push({ g, t }));
  }
  const colW = Math.max(36, Math.min(72, Math.floor((turnedEl.clientWidth - TURNED_DATES) / Math.max(1, cols.length))));
  const y = s => daysBetween(min, parse(s)) * H;

  let groupRow = '', nameRow = '', bars = '';
  for (let i = 0; i < cols.length;) {
    const g = cols[i].g;
    let n = 0;
    while (i + n < cols.length && cols[i + n].g === g) n++;
    const c = colour(g);
    groupRow += `<div class="t-group"${g ? ` data-toggle="${esc(g)}"` : ''} style="width:${n * colW}px;--bar:${c.bg};--bar-text:${c.fg}"
      title="${esc(groupLabel(g))}${g ? ' (tap to collapse or expand)' : ''}">${collapsed.has(g) ? '▸ ' : ''}${esc(groupLabel(g))}</div>`;
    i += n;
  }
  cols.forEach((col, i) => {
    const x = TURNED_DATES + i * colW, c = colour(col.g);
    if (col.t) {
      const t = col.t, pct = progressOf(t), done = pct === 100 ? ' done' : '';
      const len = daysBetween(parse(t.start), parse(t.end)) + 1;
      nameRow += `<div class="t-name${done}" data-id="${t.id}" style="width:${colW}px;--bar:${c.bg}"><span>${esc(t.name)}</span></div>`;
      bars += `<div class="t-bar${done}" data-id="${t.id}" style="left:${x + 4}px;width:${colW - 8}px;top:${y(t.start)}px;height:${len * H}px;--bar:${c.bg}"
        title="${esc(t.name)}: ${t.start} → ${t.end} (${len} day${len > 1 ? 's' : ''})${(t.subtasks || []).length ? ` · ${pct}%` : ''}">
        <span class="t-progress" style="height:${pct}%"></span>${t.milestone ? `<i class="t-ms ${t.milestone}"></i>` : ''}</div>`;
    } else { // a collapsed group: its whole span
      const s = col.list[0].start, e = col.list.reduce((m, t) => t.end > m ? t.end : m, col.list[0].end);
      nameRow += `<div class="t-name" style="width:${colW}px;--bar:${c.bg}"><span>${col.list.length} tasks</span></div>`;
      bars += `<div class="t-bar t-groupbar" style="left:${x + 4}px;width:${colW - 8}px;top:${y(s)}px;height:${(daysBetween(parse(s), parse(e)) + 1) * H}px;--bar:${c.bg}"></div>`;
    }
  });

  // Dates down the left: every day when there's room, otherwise weeks; months marked
  let dates = '', lines = '';
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(+min + i * DAY), dow = d.getUTCDay(), top = i * H, first = d.getUTCDate() === 1;
    if (dow === 0 || dow === 6) lines += `<div class="t-weekend" style="top:${top}px;height:${H}px"></div>`;
    if (dow === 1) lines += `<div class="t-week-line" style="top:${top}px"></div>`;
    if (first) lines += `<div class="t-month-line" style="top:${top}px"></div>`;
    let label = '';
    if (H >= 16) label = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', ...(first || i === 0 ? { month: 'short' } : {}), timeZone: 'UTC' });
    else if (first && H * 7 >= 14) label = `<b>${d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}</b>`;
    else if (dow === 1 && H * 7 >= 14) label = `W${isoWeek(d)}`;
    if (label) dates += `<div class="t-date${dow === 0 || dow === 6 ? ' weekend' : ''}" style="top:${top}px;height:${Math.max(H, 14)}px">${label}</div>`;
  }
  const todayAt = daysBetween(min, todayDate);
  const today = todayAt >= 0 && todayAt < totalDays ? `<div class="t-today" style="top:${todayAt * H + H / 2 - 1}px"></div>` : '';

  const width = TURNED_DATES + cols.length * colW;
  turnedEl.innerHTML = `<div class="t-canvas" style="width:${width}px">
    <div class="t-head" style="width:${width}px">
      <div class="t-corner"></div>
      <div class="t-cols">${hasGroups ? `<div class="t-groups">${groupRow}</div>` : ''}<div class="t-names">${nameRow}</div></div>
    </div>
    <div class="t-body${H >= 10 ? ' day-lines' : ''}" style="height:${totalDays * H}px;--day:${H}px">
      <div class="t-dates">${dates}</div>${lines}${today}${bars}
    </div></div>`;
}

turnedEl.addEventListener('click', e => {
  const group = e.target.closest('.t-group[data-toggle]');
  if (group) return toggleGroup(group.dataset.toggle);
  const item = e.target.closest('.t-bar[data-id], .t-name[data-id]');
  if (item) startEdit(item.dataset.id);
});

// Pinch to zoom, keeping the day between the fingers in place
let turnedPinch = null;
turnedEl.addEventListener('touchstart', e => {
  if (e.touches.length !== 2) return;
  const [a, b] = e.touches;
  turnedPinch = { gap: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), H: renderedDayW };
}, { passive: true });
turnedEl.addEventListener('touchmove', e => {
  if (!turnedPinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const offset = (a.clientY + b.clientY) / 2 - turnedEl.getBoundingClientRect().top - TURNED_HEAD;
  const day = dayNumber(chartStart) + (turnedEl.scrollTop + offset) / renderedDayW;
  setZoom(turnedPinch.H * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / turnedPinch.gap);
  turnedEl.scrollTop = (day - dayNumber(chartStart)) * renderedDayW - offset;
}, { passive: false });
turnedEl.addEventListener('touchend', e => { if (e.touches.length < 2) turnedPinch = null; });

// ---- "Coming up" notice ----
// When the app opens (and again after midnight if it stays open), a notice
// lists the unfinished tasks that start today and later this week (weeks run
// Monday to Sunday). OK hides it until the next day.
const NOTICE_KEY = 'simple-gantt-notice-seen'; // the day the notice was last closed
function checkComingUp() {
  const today = todayString();
  let seen = null;
  try { seen = localStorage.getItem(NOTICE_KEY); } catch {}
  const box = document.getElementById('notice');
  if (seen === today) { box.hidden = true; return; }
  const dow = parse(today).getUTCDay() || 7;                         // Monday = 1 … Sunday = 7
  const sunday = fmt(new Date(+parse(today) + (7 - dow) * DAY));
  const open = tasks.filter(t => progressOf(t) < 100).sort((a, b) => a.start.localeCompare(b.start));
  const startingToday = open.filter(t => t.start === today);
  const laterThisWeek = open.filter(t => t.start > today && t.start <= sunday);
  if (!startingToday.length && !laterThisWeek.length) { box.hidden = true; return; }
  const dayName = s => parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const item = (t, withDay) => `<li><b>${esc(t.name)}</b>${t.group ? ` · ${esc(t.group)}` : ''}${withDay ? ` · ${dayName(t.start)}` : ''}</li>`;
  box.innerHTML = `
    ${startingToday.length ? `<h2>Starting today</h2><ul>${startingToday.map(t => item(t, false)).join('')}</ul>` : ''}
    ${laterThisWeek.length ? `<h2>Later this week</h2><ul>${laterThisWeek.map(t => item(t, true)).join('')}</ul>` : ''}
    <div class="actions"><button class="primary" id="noticeOk">OK</button></div>`;
  box.hidden = false;
  document.getElementById('noticeOk').onclick = () => {
    try { localStorage.setItem(NOTICE_KEY, today); } catch {}
    box.hidden = true;
  };
}
setInterval(checkComingUp, 30 * 60 * 1000); // if the app stays open past midnight

// ---- Export calendar (.ics) ----
// A calendar file for Google Calendar, Outlook or Apple Calendar: every task is
// an all-day event from its start to its end date (finished tasks get a ✓), with
// its group, progress, subtasks and links in the description; every milestone
// is its own one-day event "◆ Name". Event ids stay the same between exports.
function buildCalendar() {
  const ymd = s => s.replace(/-/g, '');                                   // 2026-10-06 -> 20261006
  const nextDay = s => ymd(fmt(new Date(+parse(s) + DAY)));                // all-day DTEND is exclusive
  const text = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');   // 20261004T101500Z
  // "Google Doc: https://…" for Google links; other links are just their address
  const linkLine = url => linkLabel(url).startsWith('Google ') ? `${linkLabel(url)}: ${url}` : url;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Simple Gantt//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${text(projectName)}`];
  const event = (uid, start, endIncl, summary, description, group, attach = []) => lines.push(
    'BEGIN:VEVENT', `UID:${uid}@simple-gantt`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${nextDay(endIncl)}`,
    `SUMMARY:${text(summary)}`, `DESCRIPTION:${text(description)}`,
    ...(group ? [`CATEGORIES:${text(group)}`] : []), 'TRANSP:TRANSPARENT',
    // Links as attachments (shown by Outlook and Apple Calendar; Google ignores
    // them on import, so they're also written, clickable, in the description)
    ...attach.map(url => `ATTACH:${url}`),
    // A reminder at 09:00 on the day it starts (9 hours after the all-day event
    // begins); finished tasks (marked ✓) don't need one
    ...(summary.startsWith('✓ ') ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(summary)} starts today`, 'TRIGGER:PT9H', 'END:VALARM']),
    'END:VEVENT');

  for (const t of [...tasks].sort((a, b) => a.start.localeCompare(b.start))) {
    const subs = t.subtasks || [], pct = progressOf(t);
    const after = (t.after || []).map(id => tasks.find(x => x.id === id)?.name).filter(Boolean);
    const info = [
      `Project: ${projectName}`,
      t.group ? `Group: ${t.group}` : '',
      subs.length ? `Progress: ${pct}% (${subs.filter(s => s.done).length}/${subs.length} subtasks)` : (t.done ? 'Done' : ''),
      ...((t.links || []).length ? ['Links:', ...t.links.map(l => linkLine(l.url))] : []),
      ...(subs.length ? ['Subtasks:', ...subs.flatMap(s => [`${s.done ? '✓' : '☐'} ${s.name}`,
        ...(s.links || []).map(l => `    ${linkLine(l.url)}`)])] : []),
      after.length ? `Starts after: ${after.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const attach = [...(t.links || []), ...subs.flatMap(s => s.links || [])].map(l => l.url);
    event(t.id, t.start, t.end, `${pct === 100 ? '✓ ' : ''}${t.name}`, info, t.group, attach);
    if (t.milestone) {
      const day = t.milestone === 'start' ? t.start : t.end;
      event(`${t.id}-milestone`, day, day, `◆ ${t.name}`, `Milestone (${t.milestone} of ${t.name})\n${info}`, t.group);
    }
  }
  lines.push('END:VCALENDAR');

  // Lines longer than 75 bytes are folded onto the next line, starting with a space
  const enc = new TextEncoder();
  const fold = line => {
    const out = [];
    let cur = '';
    for (const ch of line) {
      if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
      cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  };
  return lines.map(fold).join('\r\n') + '\r\n';
}

document.getElementById('calendarBtn').onclick = () => {
  if (!tasks.length) return;
  const blob = new Blob([buildCalendar()], { type: 'text/calendar;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${fileSlug()}.ics` });
  a.click(); URL.revokeObjectURL(a.href);
};

document.getElementById('exportBtn').onclick = () => {
  syncGroupColors();
  const blob = new Blob([JSON.stringify({ name: projectName, tasks, groupColors }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${fileSlug()}.json` });
  a.click(); URL.revokeObjectURL(a.href);
};
document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
document.getElementById('importFile').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    let data = JSON.parse(await file.text());
    // Accepts { name, tasks, groupColors } or an older plain array of tasks
    groupColors = (!Array.isArray(data) && data.groupColors) || {};
    if (!Array.isArray(data) && data.name) setProjectName(String(data.name));
    if (!Array.isArray(data)) data = data.tasks;
    if (!Array.isArray(data)) throw 0;
    tasks = data.map(t => ({
      id: t.id || uid(), name: t.name, group: t.group || '', start: t.start, end: t.end,
      milestone: t.milestone || '', done: !!t.done,
      after: Array.isArray(t.after) ? t.after.map(String) : [],
      links: cleanLinks(t.links),
      subtasks: Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ id: s.id || uid(), name: String(s.name), done: !!s.done, links: cleanLinks(s.links) })) : [],
    }));
    save(); render();
  } catch { alert('Could not read that file.'); }
  e.target.value = '';
};

// ---- Group colours (bar fill + readable text colour) ----
const PALETTE = [
  { bg: '#7B1FD1', fg: '#fff' },    // purple
  { bg: '#F2214F', fg: '#fff' },    // coral red
  { bg: '#00A88C', fg: '#fff' },    // teal
  { bg: '#FFA21F', fg: '#3a2200' }, // amber
  { bg: '#2F5FE8', fg: '#fff' },    // royal blue
  { bg: '#FF5A0F', fg: '#fff' },    // orange
  { bg: '#0EA5FF', fg: '#fff' },    // sky blue
  { bg: '#FFCC14', fg: '#3a2c00' }, // yellow
];
const UNGROUPED_COLOR = { bg: '#6E6E78', fg: '#fff' };

// ---- Collapsed groups (persisted) ----
const COLLAPSED_KEY = 'simple-gantt-collapsed';
let collapsed = new Set((() => {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; }
})());

function saveCollapsed() {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {}
}
function toggleGroup(g) {
  collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g);
  saveCollapsed(); render();
}
document.getElementById('collapseAllBtn').onclick = () => {
  const groups = [...new Set(tasks.map(t => t.group || ''))];
  const allCollapsed = groups.every(g => collapsed.has(g));
  collapsed = new Set(allCollapsed ? [] : groups);
  saveCollapsed(); render();
};
chartEl.addEventListener('click', e => {
  const btn = e.target.closest('.toggle');
  if (btn) toggleGroup(btn.dataset.toggle);
});

// ---- Progress and subtasks ----
// A task with subtasks is as far along as the share of its subtasks that are
// ticked off. A task without subtasks is 0% or, once its checkbox is ticked, 100%.
function progressOf(t) {
  const subs = t.subtasks || [];
  if (!subs.length) return t.done ? 100 : 0;
  return Math.round(subs.filter(s => s.done).length / subs.length * 100);
}

// Tasks whose subtask list is open in the list (persisted)
const EXPANDED_KEY = 'simple-gantt-expanded';
let expanded = new Set((() => {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY)) || []; } catch { return []; }
})());
function saveExpanded() {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch {}
}

const subtaskOf = el => {
  const task = tasks.find(t => t.id === el.dataset.task);
  return { task, sub: task && (task.subtasks || []).find(s => s.id === el.dataset.sub) };
};

async function removeLinkAsk(fromId, toId) {
  const from = tasks.find(t => t.id === fromId), to = tasks.find(t => t.id === toId);
  const ok = await askConfirm('Remove link?',
    `<b>${esc(to.name)}</b> will no longer have to wait for <b>${esc(from.name)}</b> to finish.`, 'Remove link');
  if (!ok) return;
  to.after = to.after.filter(id => id !== fromId);
  save(); render();
}

// The task whose new subtask line is being typed (null when not adding)
let addingSubFor = null;

function startAddingSubtask(id) {
  addingSubFor = id;
  expanded.add(id); saveExpanded();
  render();
  chartEl.querySelector(`.sub-new[data-task="${id}"]`)?.focus();
}

// Ends typing a new subtask: saves it if it has a name, then either starts the
// next one (Enter) or stops (Esc, Enter on an empty line, clicking elsewhere).
let finishingSub = false; // ignores the focusout caused by our own re-render
function finishAddingSubtask(input, { keep, next }) {
  if (finishingSub) return;
  finishingSub = true;
  const task = tasks.find(t => t.id === input.dataset.task);
  const name = input.value.trim();
  if (keep && name) (task.subtasks ||= []).push({ id: uid(), name, done: false });
  addingSubFor = keep && name && next ? task.id : null;
  if (keep && name) save();
  render();
  finishingSub = false;
  if (addingSubFor) chartEl.querySelector(`.sub-new[data-task="${task.id}"]`)?.focus();
}

chartEl.addEventListener('click', e => {
  const clip = e.target.closest('.link-btn');
  if (clip) return openLinks({ task: clip.dataset.task, sub: clip.dataset.sub }, clip);
  const add = e.target.closest('.sub-add-btn');
  if (add) return startAddingSubtask(add.dataset.task);
  const link = e.target.closest('g.link');
  if (link) return removeLinkAsk(link.dataset.from, link.dataset.to);
  const ring = e.target.closest('button.status.ring'); // task with subtasks: open/close its list
  if (ring) {
    const id = ring.dataset.task;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    saveExpanded(); render();
    return;
  }
  const status = e.target.closest('button.status'); // task without subtasks: done / not done
  if (status) {
    const task = tasks.find(t => t.id === status.dataset.task);
    task.done = !task.done;
    save(); render();
    return;
  }
  const remove = e.target.closest('.sub-remove');
  if (remove) {
    const { task, sub } = subtaskOf(remove);
    task.subtasks = task.subtasks.filter(s => s !== sub);
    save(); render();
  }
});

chartEl.addEventListener('change', e => {
  if (!e.target.matches('.sub-done')) return;
  subtaskOf(e.target).sub.done = e.target.checked;
  save(); render();
});

chartEl.addEventListener('keydown', e => {
  if (!e.target.matches('.sub-new')) return;
  if (e.key === 'Enter') { e.preventDefault(); finishAddingSubtask(e.target, { keep: true, next: true }); }
  if (e.key === 'Escape') { e.stopPropagation(); finishAddingSubtask(e.target, { keep: false }); }
});
chartEl.addEventListener('focusout', e => {
  if (e.target.matches('.sub-new')) finishAddingSubtask(e.target, { keep: true, next: false });
});

// ---- Selected row (touch screens) ----
// Phones and tablets have no hover, so a row's 📎 + ✕ buttons appear when you
// tap the row; tapping elsewhere hides them again. (With a mouse, hovering does it.)
let selected = null; // { task, sub } of the tapped row
const isSelected = (task, sub) => !!selected && selected.task === task && (selected.sub || null) === (sub || null);
function selectRow(row) {
  selected = row.classList.contains('sub-row') ? { task: row.dataset.task, sub: row.dataset.sub } : { task: row.dataset.id };
  chartEl.querySelectorAll('.labels .row.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
}
document.addEventListener('pointerdown', e => {
  if (selected && !e.target.closest('.labels .task-row, .labels .sub-row, #linkPanel')) {
    selected = null;
    chartEl.querySelectorAll('.labels .row.selected').forEach(r => r.classList.remove('selected'));
  }
});

// ---- Links (attached to tasks and subtasks) ----
// Each task and subtask can have links (a Google Doc, a website, …), stored as
// `links: [{ url }]`. A paperclip button on the row shows them; it is always
// visible once there are links, and appears on hover otherwise. Only web links
// (http/https) are accepted.
const CLIP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M21.4 11.1l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// "docs.google.com/…" -> https://docs.google.com/… ; anything that isn't a web link -> null
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null; } catch { return null; }
}
const cleanLinks = list => Array.isArray(list)
  ? list.map(l => normalizeUrl(l && l.url)).filter(Boolean).map(url => ({ url })) : [];

// A short, readable name for a link
function linkLabel(url) {
  const u = new URL(url), host = u.hostname.replace(/^www\./, ''), path = u.pathname;
  if (host === 'docs.google.com') {
    if (path.startsWith('/document')) return 'Google Doc';
    if (path.startsWith('/spreadsheets')) return 'Google Sheet';
    if (path.startsWith('/presentation')) return 'Google Slides';
    if (path.startsWith('/forms')) return 'Google Form';
  }
  if (host === 'drive.google.com') return 'Google Drive file';
  const rest = path.replace(/\/$/, '');
  const label = host + (rest.length > 1 ? rest : '');
  return label.length > 42 ? label.slice(0, 40) + '…' : label;
}

function linkButton(links, taskId, subId) {
  const n = (links || []).length;
  return `<button class="link-btn reveal${n ? ' has-links' : ''}" data-task="${taskId}"${subId ? ` data-sub="${subId}"` : ''}
    title="${n ? `${n} link${n > 1 ? 's' : ''}` : 'Add a link'}">${CLIP_ICON}${n > 1 ? `<small>${n}</small>` : ''}</button>`;
}

// The links panel, opened from a row's paperclip
const linkPanel = document.getElementById('linkPanel');
let linkOwner = null; // { task, sub } whose links are shown
const ownerOf = key => {
  const t = tasks.find(t => t.id === key.task);
  return key.sub ? t.subtasks.find(s => s.id === key.sub) : t;
};

function openLinks(key, anchor) {
  linkOwner = key;
  drawLinkPanel();
  linkPanel.hidden = false;
  // Place it under the paperclip, kept inside the window
  const r = anchor.getBoundingClientRect(), w = linkPanel.offsetWidth, h = linkPanel.offsetHeight;
  linkPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  linkPanel.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  document.getElementById('linkInput').focus();
}
function closeLinks() { linkPanel.hidden = true; linkOwner = null; }

function drawLinkPanel() {
  const item = ownerOf(linkOwner), links = item.links || [];
  document.getElementById('linkTitle').textContent = `Links · ${item.name}`;
  document.getElementById('linkList').innerHTML = links.length
    ? links.map((l, i) => `<li>${CLIP_ICON}<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${esc(linkLabel(l.url))}</a>
        <button class="link-remove" data-index="${i}" title="Remove link">✕</button></li>`).join('')
    : '<li class="empty">No links yet</li>';
  document.getElementById('linkError').textContent = '';
}

document.getElementById('linkForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('linkInput');
  const url = normalizeUrl(input.value);
  if (!url) { document.getElementById('linkError').textContent = 'That doesn\'t look like a web link.'; return; }
  const item = ownerOf(linkOwner);
  (item.links ||= []).push({ url });
  input.value = '';
  save(); render(); drawLinkPanel();
});
document.getElementById('linkList').addEventListener('click', e => {
  const btn = e.target.closest('.link-remove');
  if (!btn) return;
  ownerOf(linkOwner).links.splice(+btn.dataset.index, 1);
  save(); render(); drawLinkPanel();
});
document.getElementById('linkClose').onclick = closeLinks;
document.addEventListener('pointerdown', e => {
  if (!linkPanel.hidden && !linkPanel.contains(e.target) && !e.target.closest('.link-btn')) closeLinks();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !linkPanel.hidden) closeLinks(); });

// ---- Renaming in place (in the list) ----
// Press on a name in the list (group, task or subtask) to rename it: Enter or
// clicking elsewhere saves, Esc cancels. Pressing another name saves the one
// being edited and moves straight on to the new one.
// Double-click a task's row or bar to open the form for dates, group and milestone.
let renaming = null; // { el, current, onSave, startedAt }

// Which item a name element belongs to, so it can be found again after a redraw
function nameKey(el) {
  if (el.dataset.renameGroup) return { group: el.dataset.renameGroup };
  if (el.dataset.sub) return { task: el.dataset.task, sub: el.dataset.sub };
  return { task: el.closest('.task-row')?.dataset.id };
}
function findName(key) {
  return [...chartEl.querySelectorAll('.labels .name')].find(el => {
    const k = nameKey(el);
    return key.group ? k.group === key.group : key.sub ? k.sub === key.sub : !k.sub && !k.group && k.task === key.task;
  });
}

function startRename(key) {
  const el = findName(key);
  if (!el) return;
  let current, onSave;
  if (key.group) {
    current = key.group;
    onSave = name => renameGroup(key.group, name); // redraws: the group's name is used everywhere
  } else if (key.sub) {
    const sub = tasks.find(t => t.id === key.task).subtasks.find(s => s.id === key.sub);
    current = sub.name;
    onSave = name => { sub.name = name; save(); el.textContent = name; };
  } else {
    const t = tasks.find(t => t.id === key.task);
    current = t.name;
    onSave = name => { // update the list and the bar in place (no redraw, so the next click isn't lost)
      t.name = name; save(); el.textContent = name;
      const label = chartEl.querySelector(`.bar[data-id="${t.id}"] .label`);
      if (label) label.textContent = name + ((t.subtasks || []).length ? ` · ${progressOf(t)}%` : '');
    };
  }
  renaming = { el, current, onSave, startedAt: Date.now() };
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; } // older browsers
  el.classList.add('renaming');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  getSelection().removeAllRanges(); getSelection().addRange(range);
}

function finishRename(keep) {
  if (!renaming) return;
  const { el, current, onSave } = renaming;
  renaming = null;
  const name = el.textContent.trim().replace(/\s+/g, ' ');
  el.removeAttribute('contenteditable');
  el.classList.remove('renaming');
  if (keep && name && name !== current) onSave(name);
  else el.textContent = current;
}

chartEl.addEventListener('keydown', e => {
  if (!renaming || e.target !== renaming.el) return;
  if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
  if (e.key === 'Escape') { e.stopPropagation(); finishRename(false); }
});
chartEl.addEventListener('focusout', e => {
  if (renaming && e.target === renaming.el) finishRename(true);
});

// Renames a group for all its tasks, keeping its colour, collapsed state and
// place. Renaming it to another group's name merges the two.
function renameGroup(oldName, newName) {
  const merging = tasks.some(t => t.group === newName);
  tasks.forEach(t => { if (t.group === oldName) t.group = newName; });
  if (!merging && groupColors && oldName in groupColors) groupColors[newName] = groupColors[oldName];
  if (groupColors) delete groupColors[oldName];
  if (collapsed.delete(oldName) && !merging) collapsed.add(newName);
  saveCollapsed();
  groupOrder = groupOrder.map(g => g === oldName ? newName : g);
  save(); render();
}

chartEl.addEventListener('dblclick', () => {
  const owner = lastPressed?.closest('.bar, .labels .task-row');
  if (!owner) return;
  // Clicking inside a name you're already editing (e.g. to place the cursor)
  // is just editing. Only a quick double-click, whose first click started the
  // editing a moment ago, opens the form.
  if (lastPressed.closest('.renaming') && Date.now() - renaming.startedAt > 450) return;
  finishRename(false);
  getSelection().removeAllRanges();
  startEdit(owner.dataset.id);
});

// ---- Group order (persisted) ----
// Groups are shown by their earliest start date. Groups that start on the same
// day keep the order they had before, so this remembers the last order shown.
const GROUP_ORDER_KEY = 'simple-gantt-group-order';
let groupOrder = (() => {
  try { return JSON.parse(localStorage.getItem(GROUP_ORDER_KEY)) || []; } catch { return []; }
})();

// ---- Drag & drop ----
// Task bars: drag the body to move (drag it up/down onto another group to move
//   it there), drag either edge to change start/end. A press without movement
//   opens the task for editing.
// Group summary bars: drag to move every task in the group.
// Task rows in the list: drag up/down onto another group to move the task there.
// Empty space in the chart: drag to create a new task over those days.
// Dates snap to whole days. Near the edge of the chart (or of the window) the
// view scrolls automatically, and the chart grows when you drag past its ends.
let drag = null;
let chartStart = null;              // first day shown in the chart, set by render()
let renderedDayW = null;            // day width used by the last render
let viewExtra = { left: 0, right: 0 }; // extra days added while dragging past the ends
let showsGroupHeaders = false;      // whether the last render had group header rows
let displayedGroups = [];           // group names in the order last shown

const ROW_H = 36;     // height of one row in the list and the chart (matches styles.css)
// Width of the list column, from styles.css (--labels-w; narrower on phones)
const labelsW = () => {
  const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--labels-w'));
  return Number.isNaN(w) ? 220 : w; // 0 is a real width (the list hidden on a phone)
};
const HEAD_H = 77;    // height of the date header incl. its border (matches .head in styles.css)
const timelineEl = () => chartEl.querySelector('.timeline');
const dayNumber = d => Math.round(d / DAY);
const dayString = n => fmt(new Date(n * DAY));
const groupLabel = g => g || 'Ungrouped';

// The (fractional) day under a screen x position, independent of scrolling
// (the track moves with the scroll, so its left edge is day 0 of the chart)
function pointerDay(clientX) {
  const r = chartEl.querySelector('.track').getBoundingClientRect();
  return dayNumber(chartStart) + (clientX - r.left) / renderedDayW;
}

function draggedDates({ task, mode, days }) {
  const shift = s => fmt(new Date(+parse(s) + days * DAY));
  let { start, end } = task;
  if (mode !== 'end') start = shift(start);
  if (mode !== 'start') end = shift(end);
  if (start > end) mode === 'start' ? (start = end) : (end = start); // never invert a task
  return { start, end };
}

// Days covered by a create-drag, from the day it started on to the day under the pointer
function createdDates(d) {
  const a = Math.floor(d.day0), b = Math.floor(pointerDay(d.lastX));
  return { start: dayString(Math.min(a, b)), end: dayString(Math.max(a, b)) };
}

const groupElements = g => [...chartEl.querySelectorAll('[data-group]')].filter(el => el.dataset.group === g);

// The group whose rows are under the pointer (null if none, or no groups shown)
function groupUnderPointer() {
  if (!showsGroupHeaders) return null;
  const el = document.elementFromPoint(drag.lastX, drag.lastY);
  const row = el && el.closest('[data-row-group]');
  return row ? row.dataset.rowGroup : null;
}

// The group a dragged task would move to, or null if it stays in its own group
function newGroupOf(d) {
  const canRegroup = d.kind === 'regroup' || (d.kind === 'task' && d.mode === 'move');
  return canRegroup && d.target !== null && d.target !== (d.task.group || '') ? d.target : null;
}

// Draws the drag at its current position. Called on every move and again after
// a re-render during the drag (the elements are re-created).
function applyDragVisual() {
  if (!drag || !drag.moved) return;
  const dayW = renderedDayW;
  const dy = drag.lastY + chartEl.scrollTop - drag.pageY0; // vertical distance moved, incl. scrolling

  // Highlight the header of the group a task is being moved to
  chartEl.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  const regroupTo = drag.task ? newGroupOf(drag) : null;
  if (regroupTo !== null) {
    chartEl.querySelectorAll('.ghead').forEach(el => {
      if (el.dataset.rowGroup === regroupTo) el.classList.add('drop-target');
    });
  }

  if (drag.kind === 'task') {
    const bar = chartEl.querySelector(`.bar[data-id="${drag.task.id}"]`);
    if (!bar) return;
    const { start, end } = draggedDates(drag);
    bar.classList.add('dragging');
    bar.style.left = daysBetween(chartStart, parse(start)) * dayW + 'px';
    bar.style.width = (daysBetween(parse(start), parse(end)) + 1) * dayW + 'px';
    bar.style.translate = regroupTo !== null ? `0 ${dy}px` : '';
    bar.querySelector('.label').textContent = `${shortDate(start)} → ${shortDate(end)}` +
      (regroupTo !== null ? ` (to ${groupLabel(regroupTo)})` : '');
  } else if (drag.kind === 'group') {
    for (const el of groupElements(drag.group)) {
      el.style.translate = `${drag.days * dayW}px 0`;
      if (el.matches('.bar, .group-bar')) el.classList.add('dragging');
    }
  } else if (drag.kind === 'regroup') {
    const row = chartEl.querySelector(`.labels .row[data-id="${drag.task.id}"]`);
    if (row) { row.classList.add('dragging'); row.style.translate = `0 ${dy}px`; }
  } else if (drag.kind === 'create') {
    const track = chartEl.querySelector('.track');
    let ghost = track.querySelector('.ghost-bar');
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'ghost-bar';
      track.appendChild(ghost);
    }
    const { start, end } = drag.created;
    ghost.style.top = drag.rowTop + 7 + 'px';
    ghost.style.left = daysBetween(chartStart, parse(start)) * dayW + 'px';
    ghost.style.width = (daysBetween(parse(start), parse(end)) + 1) * dayW + 'px';
    ghost.textContent = `${shortDate(start)} → ${shortDate(end)}`;
  } else if (drag.kind === 'link') {
    // Highlight the bar under the pointer if it can be linked
    chartEl.querySelectorAll('.link-target').forEach(el => el.classList.remove('link-target'));
    chartEl.querySelector(`.bar[data-id="${drag.task.id}"]`)?.classList.add('linking');
    const target = document.elementFromPoint(drag.lastX, drag.lastY)?.closest('.bar');
    drag.linkTo = target && canLink(drag.task.id, target.dataset.id) ? target.dataset.id : null;
    if (drag.linkTo) target.classList.add('link-target');
  }
  drawLinks(); // arrows follow the bars being dragged
}

function updateDrag() {
  drag.days = Math.round(pointerDay(drag.lastX) - drag.day0);
  drag.target = groupUnderPointer();
  if (drag.kind === 'create') drag.created = createdDates(drag);
  applyDragVisual();
}

function autoScroll() {
  if (!drag || !drag.moved) return;
  const EDGE = 48;
  const speed = dist => Math.ceil(Math.min(1, dist / EDGE) * 14); // px per frame, faster nearer the edge
  // The visible part of the timeline: right of the (pinned) task list, below the (pinned) dates
  const box = chartEl.getBoundingClientRect();
  const r = { left: box.left + labelsW(), right: box.left + chartEl.clientWidth, top: box.top + HEAD_H, bottom: box.top + chartEl.clientHeight };
  // Compare with the drawn days (the track), not scrollWidth: the dragged bar
  // itself can stick out past the last day and stretch the scroll area
  const atEnd = () => chartEl.scrollLeft + chartEl.clientWidth - labelsW() >= chartEl.querySelector('.track').offsetWidth - 1;

  if (drag.kind !== 'regroup') { // moving a row in the list only needs vertical scrolling
    if (drag.lastX > r.right - EDGE) {
      if (atEnd()) { viewExtra.right += 7; render(); }
      chartEl.scrollLeft += speed(drag.lastX - (r.right - EDGE));
      updateDrag();
    } else if (drag.lastX < r.left + EDGE) {
      if (chartEl.scrollLeft <= 0) { viewExtra.left += 7; render(); }
      chartEl.scrollLeft -= speed(r.left + EDGE - drag.lastX);
      updateDrag();
    }
  }
  if (drag.lastY < r.top + EDGE) { chartEl.scrollTop -= speed(r.top + EDGE - drag.lastY); updateDrag(); }
  else if (drag.lastY > r.bottom - EDGE) { chartEl.scrollTop += speed(drag.lastY - (r.bottom - EDGE)); updateDrag(); }

  requestAnimationFrame(autoScroll);
}

let lastPressed = null; // what the last press was on (double-clicks are read from it)
chartEl.addEventListener('pointerdown', e => {
  lastPressed = e.target;
  if (e.pointerType === 'touch') {
    const row = e.target.closest('.labels .task-row, .labels .sub-row');
    if (row && !row.classList.contains('selected')) {
      selectRow(row);
      if (e.target.closest('.name')) return; // first tap on a name only selects the row
    }
  }
  if (e.button !== 0 || e.target.closest('button, input, .renaming')) return;
  const name = e.target.closest('.labels .name');
  if (name) {
    e.preventDefault(); // keep focus where it is; we switch the editing over ourselves
    const key = nameKey(name);
    finishRename(true);  // save the name being edited, if any (a group rename redraws the list)
    startRename(key);
    return;
  }
  const dot = e.target.closest('.link-dot');            // drag from it onto another bar to link them
  const bar = !dot && e.target.closest('.bar');
  const groupBar = e.target.closest('.group-bar');
  const labelRow = e.target.closest('.labels .task-row');
  const emptyRow = !dot && !bar && !groupBar && e.target.closest('.timeline .row');
  if (!dot && !bar && !groupBar && !labelRow && !emptyRow) return;
  e.preventDefault();
  // Capture on the chart container (never re-rendered) so the drag survives re-renders
  chartEl.setPointerCapture(e.pointerId);
  const taskId = (dot ? dot.closest('.bar') : bar || labelRow)?.dataset.id;
  drag = {
    kind: dot ? 'link' : bar ? 'task' : groupBar ? 'group' : labelRow ? 'regroup' : 'create',
    task: taskId ? tasks.find(t => t.id === taskId) : null,
    group: groupBar ? groupBar.dataset.group : null,
    rowGroup: emptyRow ? (emptyRow.dataset.rowGroup ?? null) : null, // row a create-drag started on
    rowTop: emptyRow ? emptyRow.offsetTop : 0,
    mode: bar ? (e.target.dataset.edge || 'move') : dot ? 'link' : 'move',
    x0: e.clientX, y0: e.clientY, pageY0: e.clientY + chartEl.scrollTop, lastX: e.clientX, lastY: e.clientY,
    day0: pointerDay(e.clientX), days: 0, moved: false, target: null, created: null,
  };
});

chartEl.addEventListener('pointermove', e => {
  if (!drag) return;
  drag.lastX = e.clientX; drag.lastY = e.clientY;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    drag.moved = true;
    const cursor = drag.kind === 'create' || drag.kind === 'link' ? 'drag-create'
      : drag.mode === 'move' ? 'drag-move' : 'drag-resize';
    document.body.classList.add(cursor);
    requestAnimationFrame(autoScroll);
  }
  updateDrag();
});

function endDrag() {
  const d = drag;
  drag = null;
  viewExtra = { left: 0, right: 0 };
  document.body.classList.remove('drag-move', 'drag-resize', 'drag-create');
  return d;
}

chartEl.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = endDrag();
  if (!d.moved) return; // a click without dragging: nothing (double-click opens the form)

  if (d.kind === 'task' || d.kind === 'regroup') {
    const regroupTo = newGroupOf(d);
    const { start, end } = d.kind === 'task' ? draggedDates(d) : d.task;
    if (start === d.task.start && end === d.task.end && regroupTo === null) return render();
    const before = { ...d.task };
    Object.assign(d.task, { start, end }, regroupTo !== null ? { group: regroupTo } : {});
    if (editingId === d.task.id) {
      form.start.value = d.task.start; form.end.value = d.task.end; form.group.value = d.task.group;
    }
    save(); render();
    offerToShiftFollowing(before, d.task);
  } else if (d.kind === 'group') {
    if (!d.days) return render();
    const members = tasks.filter(t => (t.group || '') === d.group);
    const before = {
      start: members.reduce((m, t) => t.start < m ? t.start : m, members[0].start),
      end: members.reduce((m, t) => t.end > m ? t.end : m, members[0].end),
    };
    const shift = s => fmt(new Date(+parse(s) + d.days * DAY));
    members.forEach(t => { t.start = shift(t.start); t.end = shift(t.end); });
    if (editingId) { const t = tasks.find(t => t.id === editingId); form.start.value = t.start; form.end.value = t.end; }
    save(); render();
    // Offer to move the tasks in other groups that come after this group
    offerToShiftFollowing(before, { name: groupLabel(d.group), group: d.group, end: shift(before.end), isGroup: true },
      new Set(members.map(t => t.id)));
  } else if (d.kind === 'create') {
    render(); // removes the outline of the new task
    createTaskFromDrag(d);
  } else if (d.kind === 'link') {
    if (d.linkTo) {
      const to = tasks.find(t => t.id === d.linkTo);
      (to.after ||= []).push(d.task.id);
      save();
    }
    render();
  }
});

const cancelDrag = () => { if (drag) { endDrag(); render(); } };
chartEl.addEventListener('pointercancel', cancelDrag);
document.addEventListener('keydown', e => { if (e.key === 'Escape') cancelDrag(); });

// A task created by dragging goes into the group whose row the drag started on,
// if that group's dates cover the task's start date; otherwise into the topmost
// group that covers it; otherwise into a new group called "New group".
async function createTaskFromDrag(d) {
  const { start, end } = d.created;
  const spans = new Map(); // group -> { start, end } over all its tasks
  for (const t of tasks) {
    if (!t.group) continue;
    const s = spans.get(t.group);
    spans.set(t.group, s
      ? { start: t.start < s.start ? t.start : s.start, end: t.end > s.end ? t.end : s.end }
      : { start: t.start, end: t.end });
  }
  const covering = displayedGroups.filter(g => spans.has(g) && spans.get(g).start <= start && start <= spans.get(g).end);
  let group = covering.includes(d.rowGroup) ? d.rowGroup : covering[0];
  const isNewGroup = group === undefined;
  if (isNewGroup) {
    group = 'New group';
    for (let i = 2; spans.has(group); i++) group = `New group ${i}`;
  }

  const name = await askTaskName(start, end, group, isNewGroup);
  if (name === null) return;
  tasks.push({ id: uid(), name, group, start, end, milestone: '' });
  save(); render();
}

// Asks for the new task's name. Resolves with the name, or null if cancelled.
function askTaskName(start, end, group, isNewGroup) {
  const dlg = document.getElementById('nameDialog');
  const input = document.getElementById('nameInput');
  const days = daysBetween(parse(start), parse(end)) + 1;
  document.getElementById('nameText').innerHTML =
    `${shortDate(start)} → ${shortDate(end)} (${days} day${days > 1 ? 's' : ''}), ` +
    `in ${isNewGroup ? 'a new group' : 'the group'} <b>${esc(group)}</b>.`;
  input.value = 'New task';
  return new Promise(resolve => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () =>
      resolve(dlg.returnValue === 'ok' ? (input.value.trim() || 'New task') : null), { once: true });
    dlg.showModal();
    input.select();
  });
}

// ISO week number: weeks start on Monday, week 1 is the week with the year's first Thursday
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // the Thursday of this week
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

const shortDate = s => parse(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---- Render ----
function render() {
  const dayW = exportOpts ? exportOpts.dayW : zoom;
  // Tasks are always listed by start date (ties keep the order they were added)
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));

  // Remember which day is at the left edge of the view, so re-rendering
  // (after a change, a zoom or while dragging) doesn't jump the scroll position
  const leftDay = timelineEl() && chartStart ? dayNumber(chartStart) + getTimeScroll() / renderedDayW : null;
  const scrollTop = chartEl.scrollTop;

  // Range: the tasks' dates and today (or the next four weeks when there are no
  // tasks), plus one visible width of extra days on each side, so there's always
  // room to scroll and to zoom around any day under the pointer, plus any extra
  // days added while dragging past the ends.
  const todayDate = parse(todayString());
  let min = Math.min(+todayDate, ...sorted.map(t => +parse(t.start)), ...(viewRange ? [+parse(viewRange.start)] : []));
  let max = Math.max(+todayDate + (sorted.length ? 0 : 27 * DAY), ...sorted.map(t => +parse(t.end)), ...(viewRange ? [+parse(viewRange.end)] : []));
  const pad = Math.max(2, Math.ceil(timeLength() / dayW));
  min = new Date(min - (pad + viewExtra.left) * DAY); max = new Date(max + (pad + viewExtra.right) * DAY);
  if (exportOpts) { // the saved image: just the project, with a day either side
    min = new Date(exportOpts.first - DAY); max = new Date(exportOpts.last + DAY);
  }
  chartStart = min;
  renderedDayW = dayW;
  const totalDays = daysBetween(min, max) + 1;
  const width = totalDays * dayW;
  const compact = dayW < 18; // zoomed out (no day numbers): fainter day lines, tighter bars

  document.getElementById('overviewBtn').classList.toggle('active', !!overviewReturn);
  for (const b of document.querySelectorAll('#viewBtns [data-view]')) b.classList.toggle('active', b.dataset.view === view);
  const unit = { day: 'day', week: 'week', month: 'month', quarter: 'quarter' }[view] || 'screen';
  document.getElementById('prevBtn').title = `Previous ${unit}`;
  document.getElementById('nextBtn').title = `Next ${unit}`;

  // Header rows, top to bottom: quarter, month + year, ISO week, day number.
  // Quarter, month and week labels sit in a block as wide as their period and
  // stick to the left edge while you scroll, until the next one pushes them away.
  let grid = '', head = '';
  const period = (cls, from, to, text, minPx, title = '') => {
    const w = (to - from) * dayW;
    head += `<div class="hspan ${cls}" style="left:${from * dayW}px;width:${w}px"${title ? ` title="${title}"` : ''}>` +
      `<span>${w >= minPx ? text : ''}</span></div>`; // too narrow (a sliver at the chart's edge): no text
  };
  const dateAt = i => new Date(+min + i * DAY);
  let monthFrom = 0, quarterFrom = 0, weekFrom = 0;
  for (let i = 0; i <= totalDays; i++) {
    const d = dateAt(i), last = i === totalDays;
    if (!last) {
      const dow = d.getUTCDay();
      // Every day is its own column; week and month starts get a stronger line
      const cls = (dow === 0 || dow === 6 ? ' weekend' : '') + (dow === 1 ? ' week-start' : '') + (d.getUTCDate() === 1 ? ' month-start' : '');
      grid += `<div class="day${cls}" style="left:${i * dayW}px;width:${dayW}px"></div>`;
      if (dayW >= 18) {
        const label = dayW >= 70 ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }) : d.getUTCDate();
        head += `<div class="day-label${dow === 0 || dow === 6 ? ' weekend' : ''}" style="left:${i * dayW}px;width:${dayW}px">${label}</div>`;
      }
    }
    if (i === 0) continue;
    if (last || d.getUTCDate() === 1) { // a month ends here
      const m = dateAt(monthFrom);
      period('month', monthFrom, i, m.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }), 64);
      monthFrom = i;
    }
    if (last || (d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0)) { // a quarter ends here (Jan, Apr, Jul, Oct)
      period('quarter', quarterFrom, i, `Q${Math.floor(dateAt(quarterFrom).getUTCMonth() / 3) + 1}`, 24);
      quarterFrom = i;
    }
    if (last || d.getUTCDay() === 1) { // a week ends here (weeks run Monday to Sunday)
      const wk = isoWeek(dateAt(weekFrom)), w = (i - weekFrom) * dayW;
      period('week', weekFrom, i, w >= 64 ? `Week ${wk}` : `W${wk}`, 28, `Week ${wk}`);
      weekFrom = i;
    }
  }

  // Today marker
  const todayOffset = daysBetween(min, todayDate);
  const today = todayOffset >= 0 && todayOffset < totalDays
    ? `<div class="today" style="left:${todayOffset * dayW + dayW / 2}px" title="Today"></div>` : '';

  // Group tasks. Groups are ordered by their earliest start date; groups that
  // start on the same day keep their previous order. Ungrouped tasks come last.
  const groups = new Map();
  for (const t of sorted) {
    const g = t.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const rank = new Map(groupOrder.map((g, i) => [g, i]));
  const groupNames = [...groups.keys()].filter(Boolean).sort((a, b) =>
    groups.get(a)[0].start.localeCompare(groups.get(b)[0].start) ||
    (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  if (groupNames.join('\n') !== groupOrder.join('\n')) {
    groupOrder = groupNames;
    try { localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(groupOrder)); } catch {}
  }
  const order = [...groupNames, ...(groups.has('') ? [''] : [])];
  const showHeaders = groupNames.length > 0;
  showsGroupHeaders = showHeaders;
  displayedGroups = groupNames;

  document.getElementById('groupList').innerHTML =
    groupNames.map(g => `<option value="${esc(g)}">`).join('');

  syncGroupColors();
  const groupColor = new Map(Object.entries(groupColors).map(([g, i]) => [g, PALETTE[i]]));

  const collapseAllBtn = document.getElementById('collapseAllBtn');
  collapseAllBtn.hidden = !showHeaders;
  collapseAllBtn.textContent = order.every(g => collapsed.has(g)) ? 'Expand all' : 'Collapse all';

  let labels = '', rows = '';
  for (const g of order) {
    const list = groups.get(g);
    const c = g ? groupColor.get(g) : UNGROUPED_COLOR;
    const colorVars = `--bar:${c.bg};--bar-text:${c.fg}`;
    const rowGroup = showHeaders ? `data-row-group="${esc(g)}"` : '';
    const isCollapsed = showHeaders && collapsed.has(g);
    if (showHeaders) {
      const gStart = list[0].start; // list is sorted by start
      const gEnd = list.reduce((m, t) => t.end > m ? t.end : m, list[0].end);
      const gLeft = daysBetween(min, parse(gStart)) * dayW;
      const gLen = daysBetween(parse(gStart), parse(gEnd)) + 1;
      // When collapsed, the group row still shows its tasks' milestone diamonds
      const diamonds = !isCollapsed ? '' : list.filter(t => t.milestone).map(t => {
        const day = t.milestone === 'start' ? daysBetween(min, parse(t.start)) : daysBetween(min, parse(t.end)) + 1;
        return `<i class="group-ms" data-group="${esc(g)}" style="left:${day * dayW}px" title="${esc(t.name)} (milestone)"></i>`;
      }).join('');
      labels += `<div class="row group-row ghead" ${rowGroup} style="${colorVars}">
          <button class="toggle" data-toggle="${esc(g)}" title="${isCollapsed ? 'Expand' : 'Collapse'} group">${isCollapsed ? '▸' : '▾'}</button>
          <span${g ? ` class="name" data-rename-group="${esc(g)}" title="Click to rename the group"` : ''}>${esc(groupLabel(g))}</span>
          ${isCollapsed ? `<small class="count">${list.length} task${list.length > 1 ? 's' : ''}</small>` : ''}
        </div>`;
      rows += `<div class="row ghead" ${rowGroup} style="position:relative;${colorVars}">
        <div class="group-bar" data-group="${esc(g)}" style="left:${gLeft}px;width:${gLen * dayW}px"
             title="${esc(groupLabel(g))}: ${gStart} → ${gEnd}\nDrag to move the whole group"></div>${diamonds}
      </div>`;
    }
    if (isCollapsed) continue;
    const grouped = showHeaders ? ' grouped' : '';
    for (const t of list) {
      const left = daysBetween(min, parse(t.start)) * dayW;
      const len = daysBetween(parse(t.start), parse(t.end)) + 1; // inclusive
      const subs = t.subtasks || [];
      const doneSubs = subs.filter(s => s.done).length;
      const pct = progressOf(t);
      const done = pct === 100 ? ' done' : '';
      const adding = addingSubFor === t.id;
      const open = (expanded.has(t.id) && subs.length > 0) || adding;
      // When open, the task's chart row (and its bar) grows to hold one line per subtask
      const lines = open ? subs.length + (adding ? 1 : 0) : 0;
      const rowH = ROW_H * (1 + lines);

      labels += `
        <div class="row task-row${grouped}${done}${isSelected(t.id) ? ' selected' : ''}" data-id="${t.id}" ${rowGroup} style="${colorVars}"
             title="Click the name to rename, double-click the row to edit dates and more${showHeaders ? ', drag onto another group to move it there' : ''}">
          ${subs.length
            // With subtasks: a thick two-tone ring that fills up with the progress.
            // Clicking it opens/closes the subtask list.
            ? `<button class="status ring" data-task="${t.id}" style="--pct:${pct}" aria-expanded="${open}"
                       title="${doneSubs}/${subs.length} subtasks done (${pct}%). Click to ${open ? 'hide' : 'show'} subtasks"></button>`
            // Without subtasks: a thin circle you click to mark the task done
            : `<button class="status${t.done ? ' checked' : ''}" data-task="${t.id}" aria-pressed="${!!t.done}"
                       title="${t.done ? 'Done. Click to mark as not done' : 'Click to mark as done'}">${t.done ? '✓' : ''}</button>`}
          ${t.milestone ? `<i class="ms-icon" title="Milestone at ${t.milestone}"></i>` : ''}
          <span class="name">${esc(t.name)}</span>
          ${subs.length ? `<small class="sub-count" title="Subtasks done">${doneSubs}/${subs.length}</small>` : ''}
          ${linkButton(t.links, t.id)}
          <button class="sub-add-btn reveal" data-task="${t.id}" title="Add subtask">+</button>
          <button class="reveal" onclick="removeTask('${t.id}')" title="Delete">✕</button>
        </div>`;

      rows += `<div class="row${grouped}" ${rowGroup} style="position:relative;height:${rowH}px;${colorVars}">
        <div class="bar${t.milestone ? ' ms-' + t.milestone : ''}${done}${open ? ' tall' : ''}" data-id="${t.id}" data-group="${esc(g)}" style="left:${left}px;width:${len * dayW}px;top:7px;height:${rowH - 14}px"
             title="${esc(t.name)}: ${t.start} → ${t.end} (${len} day${len > 1 ? 's' : ''})${subs.length ? ` · ${pct}% done` : ''}${t.milestone ? `\nMilestone at ${t.milestone}` : ''}\nDouble-click to edit dates and more\nDrag to move (up/down to change group), drag edges to resize"
          ><span class="progress" style="width:${pct}%"></span><span class="handle" data-edge="start"></span><span class="label">${esc(t.name)}${subs.length ? ` · ${pct}%` : ''}</span><span class="handle" data-edge="end"></span>${t.milestone ? '<i class="diamond"></i>' : ''}<span class="link-dot" title="Drag onto another task: it can only start after this one has finished"></span></div>
      </div>`;

      // The subtask checklist in the list, one row per subtask (plus the line
      // being typed when adding one)
      if (open) {
        for (const s of subs) {
          labels += `<div class="row sub-row${grouped}${isSelected(t.id, s.id) ? ' selected' : ''}" data-task="${t.id}" data-sub="${s.id}" ${rowGroup} style="${colorVars}">
            <input type="checkbox" class="sub-done" data-task="${t.id}" data-sub="${s.id}" ${s.done ? 'checked' : ''}>
            <span class="name${s.done ? ' sub-checked' : ''}" data-task="${t.id}" data-sub="${s.id}" title="Click to rename">${esc(s.name)}</span>
            ${linkButton(s.links, t.id, s.id)}
            <button class="sub-remove reveal" data-task="${t.id}" data-sub="${s.id}" title="Delete subtask">✕</button>
          </div>`;
        }
        if (adding) {
          labels += `<div class="row sub-row${grouped}" ${rowGroup} style="${colorVars}">
            <input type="checkbox" disabled>
            <input class="sub-new" data-task="${t.id}" placeholder="New subtask" autocomplete="off"
                   title="Enter to add (and start the next one), Esc to stop">
          </div>`;
        }
      }
    }
  }

  // An empty row at the bottom, so there is always somewhere to drag out a new task
  labels += `<div class="row add-row"><span>${tasks.length ? 'Drag on the chart to add a task' : 'Drag on the chart to add your first task'}</span></div>`;
  rows += `<div class="row add-row" style="position:relative"></div>`;

  chartEl.innerHTML = `
    <div class="chart">
      <div class="labels"><div class="head"></div>${labels}</div>
      <div class="timeline">
        <div class="track${compact ? ' compact' : ''}" style="width:${width}px">
          ${grid}${today}
          <div class="head">${head}</div>
          ${rows}
        </div>
      </div>
    </div>`;

  renderTurned(min, totalDays, dayW, todayDate);
  if (!exportOpts) {
    if (leftDay !== null) setTimeScroll((leftDay - dayNumber(min)) * dayW);
    chartEl.scrollTop = scrollTop;
  }
  applyDragVisual(); // re-apply an in-progress drag to the fresh elements
  if (!drag || !drag.moved) drawLinks();
  tidyHeaderLabels();
  renderSchedule();
}

// A quarter/month/week label that is being pushed out of view (its period is
// scrolling away behind the task list) is hidden rather than shown cut off.
function tidyHeaderLabels() {
  const visibleLeft = chartEl.getBoundingClientRect().left + labelsW();
  for (const span of chartEl.querySelectorAll('.hspan')) {
    const label = span.firstElementChild, r = span.getBoundingClientRect();
    label.style.visibility = r.right - Math.max(r.left, visibleLeft) < label.offsetWidth ? 'hidden' : '';
  }
}
let tidyQueued = false;
chartEl.addEventListener('scroll', () => {
  if (tidyQueued) return;
  tidyQueued = true;
  requestAnimationFrame(() => { tidyQueued = false; tidyHeaderLabels(); });
}, { passive: true });

// Draws the link arrows (and, while linking, the line being dragged) in an SVG
// layer over the chart, measured from where the bars are actually drawn.
// Arrows run from the end of the first task to the start of the one after it;
// red means the later task starts before the first one has finished.
function drawLinks() {
  const track = chartEl.querySelector('.track');
  if (!track) return;
  let svg = track.querySelector('svg.links');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('links');
    track.appendChild(svg);
  }
  svg.setAttribute('width', track.offsetWidth);
  svg.setAttribute('height', track.offsetHeight);
  const tr = track.getBoundingClientRect();
  const box = id => {
    const bar = chartEl.querySelector(`.bar[data-id="${id}"]`);
    if (!bar) return null; // hidden in a collapsed group
    const r = bar.getBoundingClientRect();
    return { left: r.left - tr.left, right: r.right - tr.left, y: r.top - tr.top + 11 }; // y: the bar's first line
  };
  let out = '';
  for (const t of tasks) {
    for (const pid of t.after || []) {
      const a = box(pid), b = box(t.id), pred = tasks.find(x => x.id === pid);
      if (!a || !b || !pred) continue;
      const conflict = b.left < a.right - 1;
      const x1 = a.right, y1 = a.y, x2 = b.left, y2 = b.y;
      // Straight across and down when there's room; otherwise loop round between the rows
      const d = x2 - x1 >= 16
        ? `M${x1} ${y1} H${x1 + 8} V${y2} H${x2}`
        : `M${x1} ${y1} H${x1 + 8} V${y2 + (y2 > y1 ? -ROW_H / 2 : ROW_H / 2)} H${x2 - 8} V${y2} H${x2}`;
      out += `<g class="link${conflict ? ' conflict' : ''}" data-from="${pid}" data-to="${t.id}">
        <title>${esc(pred.name)} → ${esc(t.name)}${conflict ? ' (starts before it has finished)' : ''}. Click to remove</title>
        <path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="10"/>
        <path class="line" d="${d}" fill="none" stroke="${conflict ? '#d94a3b' : '#6e6e73'}" stroke-width="1.5"/>
        <path class="head" d="M${x2} ${y2} l-6 -4 v8 z" fill="${conflict ? '#d94a3b' : '#6e6e73'}"/></g>`;
      // (the attributes are a fallback for the saved image; on screen styles.css decides the look)
    }
  }
  if (drag && drag.kind === 'link' && drag.moved) {
    const a = box(drag.task.id);
    if (a) out += `<line class="link-draft" x1="${a.right + 12}" y1="${a.y}" x2="${drag.lastX - tr.left}" y2="${drag.lastY - tr.top}"/>`;
  }
  svg.innerHTML = out;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Seed with an example on first run so the chart isn't empty
if (tasks === null) {
  const t0 = parse(todayString());
  const at = n => fmt(new Date(+t0 + n * DAY));
  tasks = [
    { id: uid(), name: 'Research', group: 'Planning', start: at(-3), end: at(2), done: true },
    { id: uid(), name: 'Design', group: 'Planning', start: at(2), end: at(6) },
    { id: uid(), name: 'Review', group: 'Planning', start: at(9), end: at(10), milestone: 'end' },
    { id: uid(), name: 'Build', group: 'Delivery', start: at(8), end: at(20), subtasks: [
      { id: uid(), name: 'Backend', done: true },
      { id: uid(), name: 'Frontend', done: false },
      { id: uid(), name: 'Tests', done: false },
    ] },
    { id: uid(), name: 'Launch', group: 'Delivery', start: at(21), end: at(21), milestone: 'start' },
  ];
  // Example links: Build comes after Design, Launch comes after Build
  const byName = n => tasks.find(t => t.name === n);
  byName('Build').after = [byName('Design').id];
  byName('Launch').after = [byName('Build').id];
  save();
}
applyPhoneLayout(); // phone or computer layout first, so the chart is positioned in the right one
render();
// Open on the remembered Day / Week / Month / Quarter for today, or scroll to today
(() => {
  let v = null;
  try { v = localStorage.getItem(VIEW_KEY); } catch {}
  if (['day', 'week', 'month', 'quarter'].includes(v)) openView(v, todayString());
  else scrollToToday();
})();
scrollScheduleToThisWeek();
checkComingUp();
