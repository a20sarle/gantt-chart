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
const zoomEl = document.getElementById('zoom');

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
}

function startEdit(id) {
  const t = tasks.find(t => t.id === id);
  editingId = id;
  form.name.value = t.name; form.group.value = t.group || '';
  form.start.value = t.start; form.end.value = t.end;
  form.milestone.value = t.milestone || '';
  document.getElementById('submitBtn').textContent = 'Save';
  document.getElementById('cancelEdit').hidden = false;
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
// Zoom: Day / Week / Month set the day width (px per day) to a preset; the
// slider can set anything in between. The last zoom is remembered.
const VIEWS = { day: 28, week: 12, month: 4 };
const ZOOM_KEY = 'simple-gantt-zoom';
try { const z = +localStorage.getItem(ZOOM_KEY); if (z >= 2 && z <= 60) zoomEl.value = z; } catch {}
function setZoom(px) {
  overviewReturn = null; // any other zoom leaves the overview
  px = Math.min(60, Math.max(2, px));
  zoomEl.value = px;
  try { localStorage.setItem(ZOOM_KEY, px); } catch {}
  render();
}
zoomEl.oninput = () => setZoom(+zoomEl.value);
document.getElementById('viewBtns').onclick = e => {
  const btn = e.target.closest('[data-view]');
  if (btn) setZoom(VIEWS[btn.dataset.view]);
};

// Scrolls the chart so today sits a little in from the left edge of the timeline
function scrollToToday() {
  if (!timelineEl()) return;
  const x = daysBetween(chartStart, parse(fmt(new Date()))) * renderedDayW;
  chartEl.scrollLeft = Math.max(0, x - (chartEl.clientWidth - LABELS_W) / 4);
}
document.getElementById('todayBtn').onclick = scrollToToday;

// Overview: zoom so the whole project (first start to last end, plus a day on
// each side) fits the visible width, and scroll to the top. Clicking again goes
// back to the zoom and position from before.
let overviewReturn = null; // { dayW, leftDay, top } while the overview is showing
document.getElementById('overviewBtn').onclick = () => {
  if (overviewReturn) {
    const back = overviewReturn;
    setZoom(back.dayW); // also clears overviewReturn
    chartEl.scrollLeft = (back.leftDay - dayNumber(chartStart)) * renderedDayW;
    chartEl.scrollTop = back.top;
    return render(); // refresh the button
  }
  if (!tasks.length) return;
  const back = { dayW: renderedDayW, leftDay: dayNumber(chartStart) + chartEl.scrollLeft / renderedDayW, top: chartEl.scrollTop };
  const first = Math.min(...tasks.map(t => +parse(t.start))), last = Math.max(...tasks.map(t => +parse(t.end)));
  const days = daysBetween(first, last) + 1 + 2; // the project plus a day either side
  setZoom((chartEl.clientWidth - LABELS_W) / days); // setZoom keeps it within 2..60 px per day
  chartEl.scrollLeft = daysBetween(chartStart, first - DAY) * renderedDayW;
  chartEl.scrollTop = 0;
  overviewReturn = back;
  render(); // refresh the button
};

// ---- Sharing: print / PDF and image ----
// Both use a copy of the whole chart (just the project's dates, every row,
// always in light colours) with the project name and date above it.
let exportOpts = null; // { dayW, first, last } while rendering that copy
const PRINT_W = 1040;  // usable width of an A4 landscape page at 96 dpi (10 mm margins)
const IMAGE_W = 1600;  // width the image aims for
const longDate = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fileSlug = () => `${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gantt'}-${fmt(new Date())}`;

// Fills #exportArea with the title and a copy of the chart fitted to about
// `targetW` px wide. Returns the area (with the chart's width in px as
// `area.chartWidth`), or null when there are no tasks.
function buildExport(targetW) {
  if (!tasks.length) return null;
  const first = Math.min(...tasks.map(t => +parse(t.start))), last = Math.max(...tasks.map(t => +parse(t.end)));
  const days = daysBetween(first, last) + 3;
  const keep = { leftDay: dayNumber(chartStart) + chartEl.scrollLeft / renderedDayW, top: chartEl.scrollTop };
  // Draw the chart at the export size, copy it, then draw the normal view again
  // (all in one go, so the screen never shows the export version)
  const dayW = Math.min(28, Math.max(2, (targetW - LABELS_W) / days));
  exportOpts = { dayW, first, last };
  render();
  const chart = chartEl.querySelector('.chart').cloneNode(true);
  exportOpts = null;
  render();
  chartEl.scrollLeft = (keep.leftDay - dayNumber(chartStart)) * renderedDayW;
  chartEl.scrollTop = keep.top;

  chart.querySelectorAll('.hspan > span').forEach(l => { l.style.visibility = ''; }); // no scrolling in the copy
  const area = document.getElementById('exportArea');
  area.innerHTML = `<header class="export-title"><h1>${esc(projectName)}</h1>
    <p>Made ${longDate(Date.now())} · ${longDate(first)} – ${longDate(last)}</p></header>`;
  area.appendChild(chart);
  area.chartWidth = LABELS_W + days * dayW; // worked out, not measured: the area is hidden on screen
  return area;
}

document.getElementById('printBtn').onclick = () => {
  const area = buildExport(PRINT_W);
  if (!area) return;
  // Shrink to fit the page if the chart is still wider (very long projects)
  area.style.zoom = area.chartWidth > PRINT_W ? PRINT_W / area.chartWidth : '';
  window.print();
};
window.addEventListener('afterprint', () => {
  const area = document.getElementById('exportArea');
  area.innerHTML = ''; area.style.zoom = '';
});

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
  const btn = document.getElementById('imageBtn');
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
      'Saving an image needs an internet connection (it loads a small helper from cdnjs). Print / PDF works offline.', 'OK');
  } finally {
    area.classList.remove('capturing'); area.innerHTML = '';
    btn.disabled = false; btn.textContent = 'Save image';
  }
};

// ---- Zooming by pinching ----
// Only a pinch zooms (trackpad, phone, Safari on a Mac), around the day under the
// pointer or between the fingers. Ordinary scrolling is left to the browser:
// up/down scrolls the chart and list, sideways moves through time.
// Trackpad pinches arrive as Ctrl+wheel, so Ctrl + mouse wheel zooms as well.
const MIN_DAY_W = 2, MAX_DAY_W = 60;
let zoomPending = null; // { px, clientX }: applied once per animation frame

// Zooms to `px` per day, keeping the day under screen position `clientX` in place
function zoomTo(px, clientX) {
  px = Math.min(MAX_DAY_W, Math.max(MIN_DAY_W, px));
  if (!zoomPending) requestAnimationFrame(applyZoom);
  zoomPending = { px, clientX };
}
const zoomBy = (factor, clientX) => zoomTo((zoomPending ? zoomPending.px : renderedDayW) * factor, clientX);

function applyZoom() {
  const { px, clientX } = zoomPending;
  zoomPending = null;
  if (Math.abs(px - renderedDayW) < 0.01) return;
  const anchorX = clientX - (chartEl.getBoundingClientRect().left + LABELS_W); // from the timeline's visible left edge
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
      subtasks: Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ id: s.id || uid(), name: String(s.name), done: !!s.done })) : [],
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
const LABELS_W = 220; // width of the list column (matches .chart in styles.css)
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
  const r = { left: box.left + LABELS_W, right: box.left + chartEl.clientWidth, top: box.top + HEAD_H, bottom: box.top + chartEl.clientHeight };
  // Compare with the drawn days (the track), not scrollWidth: the dragged bar
  // itself can stick out past the last day and stretch the scroll area
  const atEnd = () => chartEl.scrollLeft + chartEl.clientWidth - LABELS_W >= chartEl.querySelector('.track').offsetWidth - 1;

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

chartEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button, input')) return;
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
  if (!d.moved) return d.task && d.kind !== 'link' ? startEdit(d.task.id) : undefined;

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
  const dayW = exportOpts ? exportOpts.dayW : +zoomEl.value;
  // Tasks are always listed by start date (ties keep the order they were added)
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));

  // Remember which day is at the left edge of the view, so re-rendering
  // (after a change, a zoom or while dragging) doesn't jump the scroll position
  const leftDay = timelineEl() && chartStart ? dayNumber(chartStart) + chartEl.scrollLeft / renderedDayW : null;
  const scrollTop = chartEl.scrollTop;

  // Range: the tasks' dates and today (or the next four weeks when there are no
  // tasks), plus one visible width of extra days on each side, so there's always
  // room to scroll and to zoom around any day under the pointer, plus any extra
  // days added while dragging past the ends.
  const todayDate = parse(fmt(new Date()));
  let min = Math.min(+todayDate, ...sorted.map(t => +parse(t.start)));
  let max = Math.max(+todayDate + (sorted.length ? 0 : 27 * DAY), ...sorted.map(t => +parse(t.end)));
  const pad = Math.max(2, Math.ceil((chartEl.clientWidth - LABELS_W) / dayW));
  min = new Date(min - (pad + viewExtra.left) * DAY); max = new Date(max + (pad + viewExtra.right) * DAY);
  if (exportOpts) { // printing / image: just the project, with a day either side
    min = new Date(exportOpts.first - DAY); max = new Date(exportOpts.last + DAY);
  }
  chartStart = min;
  renderedDayW = dayW;
  const totalDays = daysBetween(min, max) + 1;
  const width = totalDays * dayW;
  const compact = dayW < 18; // zoomed out (no day numbers): fainter day lines, tighter bars

  document.getElementById('overviewBtn').classList.toggle('active', !!overviewReturn);
  for (const [v, px] of Object.entries(VIEWS)) {
    document.querySelector(`#viewBtns [data-view="${v}"]`).classList.toggle('active', Math.abs(dayW - px) < 0.5);
  }

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
      if (dayW >= 18) head += `<div class="day-label${dow === 0 || dow === 6 ? ' weekend' : ''}" style="left:${i * dayW}px;width:${dayW}px">${d.getUTCDate()}</div>`;
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
          <span>${esc(groupLabel(g))}</span>
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
        <div class="row task-row${grouped}${done}" data-id="${t.id}" ${rowGroup} style="${colorVars}"
             title="${showHeaders ? 'Drag onto another group to move it there, click to edit' : 'Click to edit'}">
          ${subs.length
            // With subtasks: a thick two-tone ring that fills up with the progress.
            // Clicking it opens/closes the subtask list.
            ? `<button class="status ring" data-task="${t.id}" style="--pct:${pct}" aria-expanded="${open}"
                       title="${doneSubs}/${subs.length} subtasks done (${pct}%). Click to ${open ? 'hide' : 'show'} subtasks"></button>`
            // Without subtasks: a thin circle you click to mark the task done
            : `<button class="status${t.done ? ' checked' : ''}" data-task="${t.id}" aria-pressed="${!!t.done}"
                       title="${t.done ? 'Done. Click to mark as not done' : 'Click to mark as done'}">${t.done ? '✓' : ''}</button>`}
          ${t.milestone ? `<i class="ms-icon" title="Milestone at ${t.milestone}"></i>` : ''}
          <span>${esc(t.name)}</span>
          ${subs.length ? `<small class="sub-count" title="Subtasks done">${doneSubs}/${subs.length}</small>` : ''}
          <button class="sub-add-btn" data-task="${t.id}" title="Add subtask">+</button>
          <button onclick="removeTask('${t.id}')" title="Delete">✕</button>
        </div>`;

      rows += `<div class="row${grouped}" ${rowGroup} style="position:relative;height:${rowH}px;${colorVars}">
        <div class="bar${t.milestone ? ' ms-' + t.milestone : ''}${done}${open ? ' tall' : ''}" data-id="${t.id}" data-group="${esc(g)}" style="left:${left}px;width:${len * dayW}px;top:7px;height:${rowH - 14}px"
             title="${esc(t.name)}: ${t.start} → ${t.end} (${len} day${len > 1 ? 's' : ''})${subs.length ? ` · ${pct}% done` : ''}${t.milestone ? `\nMilestone at ${t.milestone}` : ''}\nDrag to move (up/down to change group), drag edges to resize, click to edit"
          ><span class="progress" style="width:${pct}%"></span><span class="handle" data-edge="start"></span><span class="label">${esc(t.name)}${subs.length ? ` · ${pct}%` : ''}</span><span class="handle" data-edge="end"></span>${t.milestone ? '<i class="diamond"></i>' : ''}<span class="link-dot" title="Drag onto another task: it can only start after this one has finished"></span></div>
      </div>`;

      // The subtask checklist in the list, one row per subtask (plus the line
      // being typed when adding one)
      if (open) {
        for (const s of subs) {
          labels += `<div class="row sub-row${grouped}" ${rowGroup} style="${colorVars}">
            <input type="checkbox" class="sub-done" data-task="${t.id}" data-sub="${s.id}" ${s.done ? 'checked' : ''}>
            <span class="${s.done ? 'sub-checked' : ''}">${esc(s.name)}</span>
            <button class="sub-remove" data-task="${t.id}" data-sub="${s.id}" title="Delete subtask">✕</button>
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

  if (!exportOpts) {
    if (leftDay !== null) chartEl.scrollLeft = (leftDay - dayNumber(min)) * dayW;
    chartEl.scrollTop = scrollTop;
  }
  applyDragVisual(); // re-apply an in-progress drag to the fresh elements
  if (!drag || !drag.moved) drawLinks();
  tidyHeaderLabels();
}

// A quarter/month/week label that is being pushed out of view (its period is
// scrolling away behind the task list) is hidden rather than shown cut off.
function tidyHeaderLabels() {
  const visibleLeft = chartEl.getBoundingClientRect().left + LABELS_W;
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
  const t0 = new Date(); t0.setUTCHours(0, 0, 0, 0);
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
render();
scrollToToday(); // open on today
