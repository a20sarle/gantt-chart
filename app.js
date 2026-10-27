const STORAGE_KEY = 'simple-gantt-tasks';
const DAY = 86400000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// With Firebase set up (firebase-config.js), you sign in and have two kinds of
// projects: online ones, opened as ?p=<id> (collab.js loads and saves them),
// and ones kept on this computer only, opened as ?local=<id> (saved in this
// browser, see "Projects on this computer" below). Without Firebase, the one
// project lives in this browser.
const CLOUD = !!window.GANTT_FIREBASE;
// Test mode (start page → Test mode, only at localhost): example data instead of
// Firebase (test-cloud.js), and its own place for projects on this computer
const TEST_MODE = CLOUD && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  && (() => { try { return localStorage.getItem('worknest-test-mode') === '1'; } catch { return false; } })();
const params = new URLSearchParams(location.search);
const LOCAL_ID = CLOUD ? params.get('local') : null;
const ONLINE_ID = CLOUD && !LOCAL_ID ? params.get('p') : null;
let readOnly = false;  // set by collab.js when viewing someone else's project: comments only
let cloudSave = null;  // set by collab.js for the owner: sends the project's changes online
// per-device settings, kept per project
const perProject = key => ONLINE_ID ? `${key}:${ONLINE_ID}` : LOCAL_ID ? `${key}:local:${LOCAL_ID}` : key;

// ---- Projects on this computer (with Firebase set up) ----
// The list is in LOCAL_LIST_KEY ([{ id, name, updated }]) and each project in
// `simple-gantt-local:<id>` ({ name, tasks, groupColors }). The one project
// kept in the browser from before (STORAGE_KEY etc.) joins the list once.
const LOCAL_LIST_KEY = TEST_MODE ? 'worknest-test:local-projects' : 'simple-gantt-local-projects';
const localKey = id => TEST_MODE ? `worknest-test:local:${id}` : `simple-gantt-local:${id}`;
const readJson = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
function listLocal() {
  if (!TEST_MODE && !readJson('simple-gantt-local-migrated')) {
    const old = readJson(STORAGE_KEY);
    try { localStorage.setItem('simple-gantt-local-migrated', 'true'); } catch {}
    if (Array.isArray(old) && old.length) {
      writeLocal('browser', { name: localStorage.getItem('simple-gantt-name') || 'My project', tasks: old,
        groupColors: readJson('simple-gantt-group-colors') || {} }, 0);
    }
  }
  return (readJson(LOCAL_LIST_KEY) || []).filter(p => readJson(localKey(p.id)));
}
const readLocal = id => readJson(localKey(id));
function writeLocal(id, data, updated = Date.now()) {
  localStorage.setItem(localKey(id), JSON.stringify(data));
  const list = (readJson(LOCAL_LIST_KEY) || []).filter(p => p.id !== id);
  list.push({ id, name: data.name, updated }); // (0: not known)
  localStorage.setItem(LOCAL_LIST_KEY, JSON.stringify(list));
}
function deleteLocal(id) {
  try {
    localStorage.removeItem(localKey(id));
    localStorage.setItem(LOCAL_LIST_KEY, JSON.stringify((readJson(LOCAL_LIST_KEY) || []).filter(p => p.id !== id)));
  } catch {}
}
const localProject = LOCAL_ID ? readLocal(LOCAL_ID) : null; // (null: not on this computer)

const COLORS_KEY = 'simple-gantt-group-colors';
let tasks = CLOUD ? (localProject ? localProject.tasks || [] : []) : load();
let groupColors = CLOUD ? (localProject ? localProject.groupColors || {} : {}) : loadGroupColors();

// ---- Project name (click the heading to rename) ----
const NAME_KEY = 'simple-gantt-name';
const DEFAULT_NAME = 'My project';
const nameEl = document.getElementById('projectName');
let projectName = localProject ? localProject.name : CLOUD ? 'Loading…' : (() => { try { return localStorage.getItem(NAME_KEY) || DEFAULT_NAME; } catch { return DEFAULT_NAME; } })();
function showProjectName() {
  nameEl.textContent = projectName;
  document.title = `${projectName} · WorkNest`;
}
function setProjectName(name) {
  const before = projectName;
  projectName = name.trim().replace(/\s+/g, ' ') || DEFAULT_NAME;
  if (projectName !== before) save(); // (a change like any other: saved with Save)
  showProjectName();
}
nameEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
  if (e.key === 'Escape') { nameEl.textContent = projectName; nameEl.blur(); }
});
nameEl.addEventListener('blur', () => {
  setProjectName(nameEl.textContent);
  if (CLOUD) nameEl.contentEditable = 'false'; // (back to a plain chip)
});
// With Firebase, the name is the edit chip's text: "Rename…" in the chip's menu
// makes it editable (Enter saves, Esc cancels). Without, click it to rename.
nameEl.contentEditable = CLOUD ? 'false' : 'plaintext-only';
if (!CLOUD) nameEl.title = 'Click to rename the project';
function startProjectRename() {
  if (readOnly) return;
  nameEl.contentEditable = 'plaintext-only';
  nameEl.focus();
  getSelection().selectAllChildren(nameEl);
}
showProjectName();

// ---- The project's colour on All projects: the dot after its name ----
// Saved with the project (so it's the same for everyone who sees it). Without
// one, the project takes its label's colour there (grey without a label). Click
// the dot to pick a colour: a swatch, any colour, or a hex code.
const COLOR_KEY = 'simple-gantt-color';
const NO_COLOR = '#9a9aa0';
let projectColor = localProject ? localProject.color || '' : CLOUD ? '' : (() => { try { return localStorage.getItem(COLOR_KEY) || ''; } catch { return ''; } })();
const colorBtn = document.getElementById('colorBtn'), colorPop = document.getElementById('colorPop');
const colorHex = document.getElementById('colorHex'), colorNative = document.getElementById('colorNative');
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const normHex = v => { let h = v.trim().replace(/^#/, '').toLowerCase(); if (h.length === 3) h = [...h].map(c => c + c).join(''); return '#' + h; };
function drawProjectColor() {
  const label = window.collab?.labelColor?.() || '';
  const shown = projectColor || label || NO_COLOR;
  colorBtn.style.setProperty('--dot', shown);
  document.querySelector('.edit-chip')?.style.setProperty('--label', shown); // (the edit chip, in the same colour)
  colorBtn.classList.toggle('unset', !projectColor);
  colorBtn.title = readOnly ? "This project's colour on All projects (its owner chooses it)"
    : `This project's colour on All projects${projectColor ? '' : label ? " (its label's colour)" : ' (none chosen yet)'}. Click to change it`;
  colorBtn.setAttribute('aria-label', colorBtn.title);
  for (const b of colorPop.querySelectorAll('[data-color]')) b.classList.toggle('on', b.dataset.color === projectColor);
  if (document.activeElement !== colorHex) colorHex.value = projectColor;
  colorNative.value = shown.length === 7 ? shown : NO_COLOR;
  // "Colour from the label": always there, ticked while the project follows its label
  // (it has no colour of its own); click it to go back to the label's colour
  const reset = document.getElementById('colorReset');
  reset.hidden = false;
  reset.classList.toggle('on', !projectColor);
  reset.setAttribute('aria-pressed', !projectColor);
  reset.textContent = `${projectColor ? '' : '✓ '}${label ? 'Colour from the label' : 'No colour'}`;
  reset.title = projectColor ? (label ? "Go back to the label's colour" : 'Remove the colour') : (label ? "In use: the project takes its label's colour" : 'In use: no colour chosen');
}
function setProjectColor(c) {
  if (readOnly || c === projectColor) return;
  projectColor = c;
  drawProjectColor();
  save(); // (a change like any other: saved with Save)
}
function showColorPop(open) {
  if (open && readOnly) return;
  colorPop.hidden = !open;
  colorBtn.setAttribute('aria-expanded', open);
  document.getElementById('colorError').textContent = '';
  if (open) { drawProjectColor(); (colorPop.querySelector('.on') || colorHex).focus(); }
}
colorBtn.addEventListener('click', () => showColorPop(colorPop.hidden));
colorPop.addEventListener('click', e => {
  const sw = e.target.closest('[data-color]');
  if (sw) { setProjectColor(sw.dataset.color); return showColorPop(false); }
  if (e.target.closest('#colorReset')) { setProjectColor(''); showColorPop(false); }
});
colorNative.addEventListener('input', () => { setProjectColor(colorNative.value.toLowerCase()); colorHex.value = projectColor; });
colorHex.addEventListener('input', () => {
  const ok = HEX.test(colorHex.value.trim());
  document.getElementById('colorError').textContent = ok || colorHex.value.trim().length < 4 ? '' : 'Use a hex code like #4f8ff7';
  if (ok) setProjectColor(normHex(colorHex.value));
});
colorHex.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (HEX.test(colorHex.value.trim())) showColorPop(false); } });
document.addEventListener('pointerdown', e => { if (!colorPop.hidden && !e.target.closest('.project-dot-wrap')) showColorPop(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !colorPop.hidden) { showColorPop(false); colorBtn.focus(); } });
drawProjectColor();

const chartEl = document.getElementById('chart');

// ---- Storage ----
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw) || [];
  } catch { return null; }
}
// ---- Changes, Undo / Redo and Save ----
// Changes are a draft until you click Save. Each change calls save() (below):
// it records a step for Undo and keeps the draft in this browser, so it
// survives a reload or a crash and is offered back when the project opens
// again. Save (the button, or Ctrl+S) stores it where the project lives:
// online, on this computer, or in this browser. Leaving with unsaved changes
// asks first. Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) step through every change
// since the page opened, saved or not.
const DRAFT_KEY = `${TEST_MODE ? 'worknest-test:' : ''}worknest-draft:${ONLINE_ID ? `p:${ONLINE_ID}` : LOCAL_ID ? `local:${LOCAL_ID}` : 'browser'}`;
const stateJSON = () => JSON.stringify({ name: projectName, color: projectColor || '', tasks, groupColors });
let savedState = null; // (the project as last saved or loaded; null until loaded)
let lastState = null;  // (the project after the last recorded change)
const undoStack = [], redoStack = [];
let savingNow = false;
const isDirty = () => savedState !== null && stateJSON() !== savedState;

// Each subtask has a number within its task (1, 2, 3…), so it can be referred to
// in the task's comments ("see 2"). A number is kept for good: a new subtask gets
// the next one, and deleting one doesn't renumber the others.
function numberSubtasks() {
  for (const t of tasks) {
    const subs = t.subtasks || [];
    let next = Math.max(0, ...subs.map(s => s.no || 0)) + 1;
    for (const s of subs) if (!s.no) s.no = next++;
  }
}
function tidyAfterChange() {
  numberSubtasks();
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
}

// A change was made: a step for Undo, and the draft kept in this browser
function save() {
  if (readOnly) return;
  tidyAfterChange();
  const now = stateJSON();
  if (lastState !== null && now !== lastState) {
    undoStack.push(lastState);
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
  }
  lastState = now;
  keepDraft();
  drawSaveState();
}
function keepDraft() {
  try {
    if (isDirty()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ state: stateJSON(), base: savedState }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {}
}
// Puts the project back to a recorded state (Undo / Redo, or a kept draft)
function applyState(json) {
  const s = JSON.parse(json);
  tasks = s.tasks || []; groupColors = s.groupColors || {};
  projectName = s.name || DEFAULT_NAME; projectColor = s.color || '';
  showProjectName(); drawProjectColor();
  lastState = json;
  render();
  if (sheet.open) drawSheet();
  keepDraft();
  drawSaveState();
}
function undo() {
  if (readOnly || !undoStack.length) return;
  redoStack.push(stateJSON());
  applyState(undoStack.pop());
}
function redo() {
  if (readOnly || !redoStack.length) return;
  undoStack.push(stateJSON());
  applyState(redoStack.pop());
}
// Save: stores the project where it lives
async function saveProject() {
  if (readOnly || savingNow || !isDirty()) return;
  tidyAfterChange();
  savingNow = true; drawSaveState();
  let ok = true;
  if (LOCAL_ID && localProject) { // a project on this computer
    try { writeLocal(LOCAL_ID, { name: projectName, tasks, groupColors, color: projectColor }); } catch { ok = false; }
  } else if (CLOUD) {
    ok = cloudSave ? await cloudSave() : false; // (collab.js: sends it online)
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      localStorage.setItem(COLORS_KEY, JSON.stringify(groupColors));
      localStorage.setItem(NAME_KEY, projectName);
      projectColor ? localStorage.setItem(COLOR_KEY, projectColor) : localStorage.removeItem(COLOR_KEY);
    } catch { ok = false; }
  }
  savingNow = false;
  if (ok) { markSaved(); window.collab?.colorSaved?.(projectColor); } // (its chip on All projects takes its saved colour)
  else drawSaveState();
}
// The project as it is now counts as saved (after Save, or when it's loaded:
// then a kept draft stays until restoreDraft has looked at it)
function markSaved(loading = false) {
  tidyAfterChange();
  savedState = lastState = stateJSON();
  if (!loading) keepDraft();
  drawSaveState();
}
// Opening the project: unsaved changes kept from last time come back (Undo goes back to the saved version)
function restoreDraft() {
  const d = readJson(DRAFT_KEY);
  if (!d || typeof d.state !== 'string' || d.state === savedState || readOnly) return keepDraft();
  undoStack.push(savedState);
  applyState(d.state);
  const b = document.getElementById('saveBtn');
  b.classList.add('restored');
  b.title = 'Your unsaved changes from last time are back. Save them, or Undo to go back to the saved version';
}
const saveBtn = document.getElementById('saveBtn');
function drawSaveState() {
  const dirty = isDirty();
  saveBtn.classList.toggle('dirty', dirty);
  saveBtn.textContent = savingNow ? 'Saving…' : dirty ? 'Save' : 'Saved';
  if (!dirty) { saveBtn.classList.remove('restored'); saveBtn.title = 'All changes are saved'; }
  else if (!saveBtn.classList.contains('restored')) saveBtn.title = 'You have unsaved changes. Save them (Ctrl+S)';
  document.getElementById('undoBtn').disabled = !undoStack.length;
  document.getElementById('redoBtn').disabled = !redoStack.length;
  // Viewing someone else's project: the same buttons in the same places, but greyed out
  saveBtn.disabled = readOnly;
  if (readOnly) {
    saveBtn.textContent = 'Save';
    for (const b of [saveBtn, document.getElementById('undoBtn'), document.getElementById('redoBtn')]) b.title = 'View only: only the project\'s owner can change it';
  } else {
    document.getElementById('undoBtn').title = 'Undo (Ctrl+Z)';
    document.getElementById('redoBtn').title = 'Redo (Ctrl+Shift+Z)';
  }
}
saveBtn.addEventListener('click', saveProject);
document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || readOnly) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); return saveProject(); }
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="plaintext-only"], [contenteditable="true"]');
  if (typing || document.querySelector('dialog[open]:not(.sheet)')) return; // (their own undo while typing)
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
});
addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

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
    if (!names.has(g) || !groupColorOf(groupColors[g])) delete groupColors[g];
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
// - with linked tasks (an arrow from it, and the rest of their chain): a simple
//   yes / no — move them all by the same number of days (their lengths stay the
//   same, nothing before it moves), or only this task (one left starting too
//   early gets a red arrow);
// - otherwise, other tasks that start later (not linked): move those in the same
//   group, in all groups, or don't move.
// `task` can also stand for a whole group that was dragged ({ isGroup: true });
// `exclude` holds the ids of tasks that already moved.
// The move itself is shown but only saved once it's decided: `undo` puts it
// back if the dialog is cancelled. Resolves with false when cancelled.
async function offerToShiftFollowing(before, task, exclude = new Set([task.id]), undo = null) {
  const delta = daysBetween(parse(before.end), parse(task.end));
  if (!delta) { save(); return true; }
  const movedIds = [...exclude];
  const linked = downstreamOf(movedIds).filter(t => !exclude.has(t.id))
    .sort((a, b) => a.start.localeCompare(b.start));
  const linkedIds = new Set(linked.map(t => t.id));
  const later = tasks
    .filter(t => !exclude.has(t.id) && !linkedIds.has(t.id) && t.start > before.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!linked.length && !later.length) { save(); return true; }
  const sameGroup = later.filter(t => (t.group || '') === task.group);
  const pushPlan = planPush(movedIds);

  const choice = await askShift(task, delta, { linked, pushPlan, later, sameGroup, before });
  if (choice.cancel) { undo?.(); render(); return false; } // (Cancel: back where it was, nothing saved)

  if (choice.linked === 'push') pushPlan.forEach((days, id) => shiftTask(tasks.find(t => t.id === id), days));
  if (choice.linked === 'gap') linked.forEach(t => shiftTask(t, delta));
  const others = choice.others === 'group' ? sameGroup : choice.others === 'all' ? later : [];
  others.forEach(t => shiftTask(t, delta));
  save(); render();
  return true;
}

// What changed, in words: moved (same length), made longer / shorter (same
// start), or both
function whatHappened(task, before, delta) {
  const days = n => `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;
  const name = `${task.isGroup ? 'The group ' : ''}<i>${esc(task.name)}</i>`;
  const moved = before && before.start && task.start ? daysBetween(parse(before.start), parse(task.start)) : delta;
  if (moved === delta) return `${name} has been rescheduled ${days(delta)} ${delta > 0 ? 'later' : 'earlier'}.`;
  if (!moved) return `${name}'s duration is now ${days(delta)} ${delta > 0 ? 'longer' : 'shorter'}, so it finishes ${days(delta)} ${delta > 0 ? 'later' : 'earlier'}.`;
  return `${name} now finishes ${days(delta)} ${delta > 0 ? 'later' : 'earlier'}.`;
}

// Shows the "Move the tasks that come after?" dialog. Resolves with
// { linked: 'gap' | 'none', others: 'group' | 'all' | 'none' }, or { cancel: true }.
function askShift(task, delta, { linked, pushPlan, later, sameGroup, before }) {
  const dlg = document.getElementById('shiftDialog');
  const daysText = n => `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;
  const dir = delta > 0 ? 'later' : 'earlier';
  const option = (name, value, label, detail, checked) =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}>
       <span><b>${label}</b><small>${detail}</small></span></label>`;
  const names = list => `<ul>${list.map(t => `<li>${esc(t.name)}</li>`).join('')}</ul>`;
  let html = '';

  // Linked tasks: just two answers, as buttons
  const actions = dlg.querySelector('.actions.reverse'); // (Apply / Cancel under the old dialog, not the Cancel inside the answers)
  actions.hidden = !!linked.length;
  if (linked.length) {
    // In project-management terms, about the task that was moved (the
    // predecessor): its successor tasks (finish-to-start dependencies, the rest
    // of the chain included) are rescheduled with it, or keep their dates
    const nm = n => `<i>${esc(n)}</i>`; // (a task's name in the answers: in italics, so it reads as a name)
    const who = task.isGroup ? `The group ${nm(task.name)}` : nm(task.name);
    const one = linked.length === 1, names = linked.map(t => nm(t.name)).join(', ');
    const clash = linked.filter(t => pushPlan.has(t.id));
    document.getElementById('shiftTitle').textContent = one ? 'Reschedule the successor task?' : `Reschedule the ${linked.length} successor tasks?`;
    document.getElementById('shiftText').innerHTML = `${whatHappened(task, before, delta)} ${one
      ? `It has a successor task: ${names}.` : `It has ${linked.length} successor tasks: ${names}.`}`;
    document.getElementById('shiftList').innerHTML = `<div class="choice-btns">
      <button value="gap" class="choice-btn primary-choice"><b>Yes, reschedule ${one ? 'the successor' : 'all successors'}</b>
        <small>${one ? nm(linked[0].name) + ' moves' : 'They move'} ${daysText(delta)} ${dir} with ${who.replace('The group', 'the group')}. Durations and dependencies stay the same; predecessor tasks aren't affected.</small></button>
      <button value="none" class="choice-btn"><b>No, only reschedule ${task.isGroup ? 'this group' : nm(task.name)}</b>
        <small>${one ? 'The successor keeps its dates' : 'The successors keep their dates'}.${clash.length
          ? ` ${clash.length === 1 ? nm(clash[0].name) + ' would then start' : `${clash.length} of them would then start`} before ${who.replace('The group', 'the group')} finishes: a dependency conflict (shown with a red arrow).` : ''}</small></button>
    </div>
    <div class="actions choice-cancel"><button value="cancel">Cancel</button></div>`;
    return new Promise(resolve => {
      dlg.returnValue = '';
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'gap' || dlg.returnValue === 'none'
        ? { linked: dlg.returnValue, others: 'none' } : { cancel: true }), { once: true }); // (Cancel or Escape: undo the move)
      dlg.showModal();
      dlg.querySelector('.choice-btn').focus();
    });
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
    html += `<section><h3>Tasks that come after</h3>${lists}
      ${sameGroup.length ? option('others', 'group', hasOtherGroups ? 'Only this group' : 'Move them', count(sameGroup.length), true) : ''}
      ${hasOtherGroups ? option('others', 'all', sameGroup.length ? 'All groups' : 'Move them', count(later.length), !sameGroup.length) : ''}
      ${option('others', 'none', "Don't move", 'They stay where they are', false)}
    </section>`;
  }

  document.getElementById('shiftTitle').textContent = 'Move the tasks that come after?';
  document.getElementById('shiftText').innerHTML =
    whatHappened(task, before, delta);
  document.getElementById('shiftList').innerHTML = html;

  return new Promise(resolve => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'apply') return resolve({ cancel: true }); // (Cancel or Escape: undo the move)
      const picked = name => dlg.querySelector(`input[name="${name}"]:checked`)?.value || 'none';
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

// "+ New task" (no longer a button: tasks are made by dragging across the chart):
// a task from today to two days from now, opened in its sheet with the name ready
// to type over. Closing the sheet without changing it removes it again.
document.getElementById('newTaskBtn')?.addEventListener('click', () => {
  const today = todayString();
  const t = { id: uid(), name: 'New task', group: '', start: today, end: fmt(new Date(+parse(today) + 2 * DAY)), milestone: '' };
  tasks.push(t);
  save(); render();
  openTaskSheet(t.id, { isNew: true });
});

function removeTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  tasks.forEach(t => { if (t.after) t.after = t.after.filter(a => a !== id); }); // drop its links
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
const TURNED_HEAD = 0, TURNED_DATES = 58;        // no header; date column width (matches styles.css)
const timeLength = () => turnedOn() ? turnedEl.clientHeight - TURNED_HEAD : chartEl.clientWidth - labelsW();
const getTimeScroll = () => turnedOn() ? turnedEl.scrollTop : chartEl.scrollLeft;
const setTimeScroll = px => { if (turnedOn()) turnedEl.scrollTop = px; else chartEl.scrollLeft = px; };
// The (fractional) day at the start of the visible timeline, and scrolling to a
// day (minus `offset` px). The turned chart has its own day <-> position map.
const useTurnedMap = () => turnedOn() && turnedMap;
const getScrollDay = () => useTurnedMap() ? turnedDayAtY(turnedEl.scrollTop + TURNED_STICKY) : dayNumber(chartStart) + chartEl.scrollLeft / renderedDayW;
function scrollToDay(day, offset = 0) {
  if (useTurnedMap()) turnedEl.scrollTop = Math.min(turnedYOfDay(day), turnedRowTop(Math.floor(day)) - TURNED_STICKY) - offset;
  else chartEl.scrollLeft = (day - dayNumber(chartStart)) * renderedDayW - offset;
}
// The zoom (px per day) that fits `days` days from `startDay` on screen
// (in the turned chart, the bands for new weeks/months/quarters take room too)
// (in the turned chart, the bands for new weeks/months/quarters take room too,
// and the first day starts below the pinned quarter / month / week labels)
const fitZoom = (startDay, days) => (timeLength() - (turnedOn()
  ? Math.max(TURNED_STICKY, turnedBandsBetween(startDay, startDay)) + turnedBandsBetween(startDay + 1, startDay + days - 1)
  : 2 * EDGE_NAV)) / days; // (on a computer: between ‹ and › at the ends of the date header)
const edgeOffset = () => turnedOn() ? 0 : EDGE_NAV; // (the first day shown starts just right of ‹)
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
  setZoom(fitZoom(dayNumber(parse(p.start)), days), { keepView: true });
  scrollToDay(dayNumber(parse(p.start)), edgeOffset());
  tidyHeaderLabels();
}

// Click a quarter, month, week or day in the date header to show just that
// period (the labels carry data-view and data-date; on a phone too)
function openHeaderPeriod(e) {
  const el = e.target.closest('[data-view][data-date]');
  if (!el || drag) return false;
  if (overviewReturn) overviewReturn = null; // (leaving the overview)
  openView(el.dataset.view, el.dataset.date);
  render();
  return true;
}
chartEl.addEventListener('click', e => { if (e.target.closest('.track > .head')) openHeaderPeriod(e); });

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
  scrollToDay(dayNumber(parse(todayString())), timeLength() / 4);
}
// Today: today's period in Day / Week / Month / Quarter, otherwise scroll to today
document.getElementById('todayBtn')?.addEventListener('click', () => {
  view ? openView(view, todayString()) : scrollToToday();
  window.collab?.alignOverview?.(); // (the overview above: the same zoom, its days right above these)
});

// Overview: zoom so the whole project (first start to last end, plus a day on
// each side) fits the visible width, and scroll to the top. Clicking again goes
// back to the zoom and position from before.
let overviewReturn = null; // { dayW, leftDay, top } while the overview is showing
// (the button says Fit: with Firebase it also fits the projects in the overview above)
document.getElementById('overviewBtn').onclick = () => {
  if (overviewReturn) {
    const back = overviewReturn;
    setZoom(back.dayW); // also clears overviewReturn
    scrollToDay(back.leftDay);
    chartEl.scrollTop = back.top;
    render(); // refresh the button
    return window.collab?.alignOverview?.();
  }
  const others = window.collab?.overviewSpan?.() || []; // (the projects in the overview above, ms)
  if (!tasks.length && !others.length) return;
  const back = { dayW: renderedDayW, leftDay: getScrollDay(), top: chartEl.scrollTop };
  const first = Math.min(...tasks.map(t => +parse(t.start)), ...others), last = Math.max(...tasks.map(t => +parse(t.end)), ...others);
  const days = daysBetween(first, last) + 1 + 2; // everything plus a day either side
  setZoom(fitZoom(dayNumber(first) - 1, days)); // setZoom keeps it within the zoom limits
  scrollToDay(dayNumber(first) - 1, edgeOffset());
  chartEl.scrollTop = 0;
  overviewReturn = back;
  render(); // refresh the button
  window.collab?.alignOverview?.(); // (the overview above: the same zoom, its days right above these)
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
  const phoneClasses = ['phone-chart'].filter(c => document.documentElement.classList.contains(c));
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

// The mouse wheel over the date header moves through time (sideways); over the
// tasks it still scrolls up and down. Sideways trackpad swipes are left alone.
chartEl.addEventListener('wheel', e => {
  if (e.ctrlKey || drag || !e.target.closest('.track > .head')) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? timeLength() : 1; // lines/pages -> px
  chartEl.scrollLeft += e.deltaY * unit;
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

// ---- Export menu: Image (.png), Calendar (.ics), JSON ----
// Opens on click; closes when an item is picked, on a click elsewhere, or with Esc.
const exportMenuBtn = document.getElementById('exportMenuBtn');
const exportMenu = document.getElementById('exportMenu');
function showExportMenu(open) {
  exportMenu.hidden = !open;
  exportMenuBtn.setAttribute('aria-expanded', open);
  if (open) [...exportMenu.querySelectorAll('button')].find(b => b.offsetParent)?.focus(); // (the first one shown)
}
exportMenuBtn.onclick = () => showExportMenu(exportMenu.hidden);
exportMenu.addEventListener('click', e => { if (e.target.closest('button')) showExportMenu(false); });
document.addEventListener('pointerdown', e => {
  if (!exportMenu.hidden && !e.target.closest('.menu-wrap')) showExportMenu(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !exportMenu.hidden) { showExportMenu(false); exportMenuBtn.focus(); }
});

// ---- Phones: the Chart turned ----
// On narrow screens the Gantt chart is turned a quarter, so it scrolls
// downwards through time (see renderTurned). A class on <html> switches the
// layout (styles.css).
const phoneQuery = matchMedia('(max-width: 640px)');
try { localStorage.removeItem('simple-gantt-phone-view'); } catch {} // from the old Schedule | Chart choice

function applyPhoneLayout() {
  document.documentElement.classList.toggle('phone-chart', phoneQuery.matches);
}
phoneQuery.addEventListener('change', () => { applyPhoneLayout(); applyListWidth(); render(); });

// ---- Phones: the Chart turned a quarter (time runs down) ----
// On a phone, Chart shows the Gantt chart turned: dates run down the left side
// (staying in place while scrolling sideways) and each task is a vertical bar
// in its own column with its name written inside; each group has a thin column
// with a line over the group's dates. Swiping up/down moves through time.
// Wherever a quarter, month or week begins, a band shows that information
// stacked ("Q4 · Oct 2026 · Week 40"); every day row is tall enough for its
// label, so the days aren't evenly spaced: turnedMap translates between days
// and positions. Tap a bar to open the task sheet; press and hold an empty
// spot, then drag, to create a task.
const TURNED_MIN_ROW = 16, BAND_LINE = 14, GROUP_COL = 16;
const TURNED_STICKY = 3 * BAND_LINE; // the quarter, month and week labels pinned at the top
let turnedMap = null;  // { startDay, rowTop: [], bandTop: [], H, height }
let turnedCols = [];   // [{ x, w, g }] for creating tasks

// The lines of the band above a day: Q (quarter starts), month (month starts), week (Mondays)
function turnedBandLines(d, first) {
  const lines = [], day1 = d.getUTCDate() === 1;
  if (first || (day1 && d.getUTCMonth() % 3 === 0)) lines.push(`<b>Q${Math.floor(d.getUTCMonth() / 3) + 1}</b>`);
  if (first || day1) lines.push(d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }));
  if (first || d.getUTCDay() === 1) lines.push(`Week ${isoWeek(d)}`);
  return lines;
}
const bandHeight = n => n ? n * BAND_LINE + 6 : 0;
// Total band height between two days (both included), for fitting a period on screen
function turnedBandsBetween(a, b) {
  let h = 0;
  for (let n = a; n <= b; n++) h += bandHeight(turnedBandLines(new Date(n * DAY), false).length);
  return h;
}

// Day number (may be fractional) <-> position from the top of the chart.
// A whole day maps to the top of its band, so scrolling to it shows its band.
function turnedYOfDay(day) {
  const m = turnedMap, i = Math.max(0, Math.min(m.rowTop.length - 1, Math.floor(day - m.startDay))), f = day - m.startDay - i;
  return f <= 0 ? m.bandTop[i] : m.rowTop[i] + Math.min(1, f) * m.H;
}
function turnedDayAtY(y) {
  const m = turnedMap;
  let lo = 0, hi = m.rowTop.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m.bandTop[mid] <= y) lo = mid; else hi = mid - 1; }
  return m.startDay + lo + Math.max(0, Math.min(1, (y - m.rowTop[lo]) / m.H));
}
const turnedRowTop = day => turnedMap.rowTop[Math.max(0, Math.min(turnedMap.rowTop.length - 1, day - turnedMap.startDay))];

function renderTurned(min, totalDays, zoomH, todayDate) {
  if (!turnedOn() || exportOpts) return;
  const H = Math.max(TURNED_MIN_ROW, zoomH);
  syncGroupColors();
  const colour = g => g ? groupColorOf(groupColors[g]) || UNGROUPED_COLOR : UNGROUPED_COLOR;
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));
  const groups = new Map();
  for (const t of sorted) { const g = t.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  const order = [...displayedGroups.filter(g => groups.has(g)), ...(groups.has('') ? [''] : [])];
  const hasGroups = displayedGroups.length > 0;

  // Rows: a band (if a quarter/month/week begins) then the day itself
  const rowTop = [], bandTop = [], bandLines = [];
  let yPos = 0;
  for (let i = 0; i < totalDays; i++) {
    const lines = turnedBandLines(new Date(+min + i * DAY), i === 0);
    bandTop.push(yPos); bandLines.push(lines);
    yPos += bandHeight(lines.length);
    rowTop.push(yPos);
    yPos += H;
  }
  turnedMap = { startDay: dayNumber(min), rowTop, bandTop, H, height: yPos };
  const topOf = s => turnedRowTop(dayNumber(parse(s)));
  const bottomOf = s => turnedRowTop(dayNumber(parse(s))) + H;

  // Columns: per group a thin column with its line, then a column per task
  // (a collapsed group shows only its line)
  const groupCols = hasGroups ? order.length : 0;
  const taskCols = order.reduce((n, g) => n + (hasGroups && collapsed.has(g) ? 0 : groups.get(g).length), 0);
  const colW = Math.max(36, Math.min(72, Math.floor((turnedEl.clientWidth - TURNED_DATES - groupCols * GROUP_COL) / Math.max(1, taskCols))));
  let x = TURNED_DATES, bars = '';
  turnedCols = [];
  for (const g of order) {
    const list = groups.get(g), c = colour(g);
    if (hasGroups) {
      const s = list[0].start, e = list.reduce((m, t) => t.end > m ? t.end : m, list[0].end);
      bars += `<div class="t-gline" data-toggle="${esc(g)}" style="left:${x + 5}px;top:${topOf(s)}px;height:${bottomOf(e) - topOf(s)}px;--bar:${c.bg}"
        title="${esc(groupLabel(g))}: ${s} → ${e}${collapsed.has(g) ? ` (${list.length} tasks hidden)` : ''}"></div>`;
      turnedCols.push({ x, w: GROUP_COL, g });
      x += GROUP_COL;
      if (collapsed.has(g)) continue;
    }
    for (const t of list) {
      const pct = progressOf(t), done = pct === 100 ? ' done' : '';
      const comments = window.collab?.count(t.id) || 0;
      const extras = [(t.subtasks || []).length ? `${pct}%` : '', (t.links || []).length ? '📎' : '', comments ? `💬${comments}` : ''].filter(Boolean).join(' ');
      bars += `<div class="t-bar${done}" data-id="${t.id}" style="left:${x + 4}px;width:${colW - 8}px;top:${topOf(t.start)}px;height:${bottomOf(t.end) - topOf(t.start)}px;--bar:${c.bg}"
        title="${esc(t.name)}: ${t.start} → ${t.end}">
        <span class="t-progress" style="height:${pct}%"></span>
        <span class="t-label">${esc(t.name)}${extras ? `<small> ${extras}</small>` : ''}</span>
        ${t.milestone ? `<i class="t-ms ${t.milestone}"></i>` : ''}</div>`;
      turnedCols.push({ x, w: colW, g });
      x += colW;
    }
  }

  // Bands, day rows (weekends shaded) and their labels in the date column
  let dates = '', rows = '';
  const periods = [[], [], []]; // where each quarter / month / week begins: { i, line, text }
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(+min + i * DAY), dow = d.getUTCDay(), weekend = dow === 0 || dow === 6 ? ' weekend' : '';
    if (bandLines[i].length) {
      const kind = bandLines[i][0].startsWith('<b>Q') ? ' q' : d.getUTCDate() === 1 ? ' m' : '';
      rows += `<div class="t-band${kind}" style="top:${bandTop[i]}px;height:${rowTop[i] - bandTop[i]}px"></div>`;
      bandLines[i].forEach((text, line) => {
        const level = text.startsWith('<b>Q') ? 0 : text.startsWith('Week') ? 2 : 1;
        periods[level].push({ i, line, text });
      });
    }
    rows += `<div class="t-row${weekend}" style="top:${rowTop[i]}px;height:${H}px"></div>`;
    dates += `<div class="t-date${weekend}" data-view="day" data-date="${fmt(d)}" style="top:${rowTop[i]}px;height:${H}px">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}</div>`;
  }
  // Each quarter / month / week label sits in a box as tall as its period and
  // sticks to the top while you scroll through it (quarter, month, then week
  // under each other), until the next one pushes it away
  periods.forEach((list, level) => list.forEach((p, k) => {
    const top = bandTop[p.i], end = k + 1 < list.length ? bandTop[list[k + 1].i] : yPos;
    const v = ['quarter', 'month', 'week'][level], from = periodOf(v, fmt(new Date(+min + p.i * DAY))).start;
    dates += `<div class="t-period" style="top:${top}px;height:${end - top}px">` +
      `<span class="t-period-label l${level}" data-view="${v}" data-date="${from}" style="margin-top:${3 + p.line * BAND_LINE}px;top:${level * BAND_LINE}px">${p.text}</span></div>`;
  }));
  const todayAt = daysBetween(min, todayDate);
  const today = todayAt >= 0 && todayAt < totalDays ? `<div class="t-today" style="top:${rowTop[todayAt] + H / 2 - 1}px"></div>` : '';

  turnedEl.innerHTML = `<div class="t-canvas" style="width:${x}px">
    <div class="t-body" style="height:${yPos}px">
      <div class="t-dates">${dates}</div>${rows}${today}${bars}
    </div></div>`;
}

// Tap a bar: the task sheet. Tap a group's line: collapse or expand the group.
turnedEl.addEventListener('click', e => {
  if (turnedPress?.done) { turnedPress = null; return; } // the end of a press-and-drag isn't a tap
  if (e.target.closest('.t-dates') && openHeaderPeriod(e)) return; // (a quarter, month, week or day: show it)
  const line = e.target.closest('.t-gline[data-toggle]');
  if (line) return toggleGroup(line.dataset.toggle);
  const bar = e.target.closest('.t-bar[data-id]');
  if (bar) openTaskSheet(bar.dataset.id);
});
turnedEl.addEventListener('contextmenu', e => e.preventDefault()); // a long press shouldn't open the phone's menu

// Press and hold an empty spot, then drag up/down: create a task over those days.
// Moving before the hold is complete is an ordinary scroll.
const HOLD_MS = 450;
let turnedPress = null; // { x, y, timer, active, done, day0, day1, g, colX, colW, created }
const turnedBodyTop = () => turnedEl.querySelector('.t-body').getBoundingClientRect().top;
const turnedDayAtClientY = clientY => Math.floor(turnedDayAtY(clientY - turnedBodyTop()));

function drawTurnedGhost() {
  const p = turnedPress, a = Math.min(p.day0, p.day1), b = Math.max(p.day0, p.day1);
  p.created = { start: dayString(a), end: dayString(b) };
  let ghost = turnedEl.querySelector('.t-ghost');
  if (!ghost) { ghost = document.createElement('div'); ghost.className = 't-ghost'; turnedEl.querySelector('.t-body').appendChild(ghost); }
  ghost.style.left = p.colX + 2 + 'px';
  ghost.style.width = Math.max(30, p.colW - 4) + 'px';
  ghost.style.top = turnedRowTop(a) + 'px';
  ghost.style.height = turnedRowTop(b) + turnedMap.H - turnedRowTop(a) + 'px';
  ghost.innerHTML = `<span>${shortDate(p.created.start)}${a === b ? '' : ` → ${shortDate(p.created.end)}`}</span>`;
}

turnedEl.addEventListener('touchstart', e => {
  if (readOnly) return; // viewing: tapping a task opens it, nothing is created
  if (turnedPress) { clearTimeout(turnedPress.timer); turnedPress.active && turnedEl.querySelector('.t-ghost')?.remove(); turnedPress = null; }
  if (e.touches.length !== 1 || e.target.closest('.t-bar, .t-gline')) return;
  const t = e.touches[0];
  const p = turnedPress = { x: t.clientX, y: t.clientY, active: false, done: false };
  p.timer = setTimeout(() => {
    if (turnedPress !== p) return;
    p.active = true;
    navigator.vibrate?.(20);
    const xIn = p.x - turnedEl.querySelector('.t-canvas').getBoundingClientRect().left;
    const col = turnedCols.find(c => xIn >= c.x && xIn < c.x + c.w) || turnedCols[turnedCols.length - 1];
    p.g = col ? col.g : null;
    p.colX = col ? col.x : TURNED_DATES;
    p.colW = col ? col.w : 40;
    p.day0 = p.day1 = turnedDayAtClientY(p.y);
    drawTurnedGhost();
  }, HOLD_MS);
}, { passive: true });

turnedEl.addEventListener('touchmove', e => {
  const p = turnedPress;
  if (!p) return;
  const t = e.touches[0];
  if (!p.active) { // moved before the hold: it's a scroll
    if (e.touches.length > 1 || Math.hypot(t.clientX - p.x, t.clientY - p.y) > 8) { clearTimeout(p.timer); turnedPress = null; }
    return;
  }
  e.preventDefault(); // creating: the finger draws, the chart doesn't scroll
  const r = turnedEl.getBoundingClientRect(), EDGE = 40;
  if (t.clientY > r.bottom - EDGE) turnedEl.scrollTop += 12;        // near the edges, scroll along
  else if (t.clientY < r.top + EDGE) turnedEl.scrollTop -= 12;
  p.day1 = turnedDayAtClientY(t.clientY);
  drawTurnedGhost();
}, { passive: false });

turnedEl.addEventListener('touchend', () => {
  const p = turnedPress;
  if (!p) return;
  clearTimeout(p.timer);
  if (!p.active) { turnedPress = null; return; }
  p.done = true; // so the click that may follow isn't taken as a tap
  setTimeout(() => { if (turnedPress === p) turnedPress = null; }, 400);
  turnedEl.querySelector('.t-ghost')?.remove();
  createTaskFromDrag({ created: p.created, rowGroup: p.g || null });
});
turnedEl.addEventListener('touchcancel', () => {
  if (!turnedPress) return;
  clearTimeout(turnedPress.timer);
  turnedEl.querySelector('.t-ghost')?.remove();
  turnedPress = null;
});

// Pinch to zoom, keeping the day between the fingers in place
let turnedPinch = null;
turnedEl.addEventListener('touchstart', e => {
  if (e.touches.length !== 2) return;
  const [a, b] = e.touches;
  turnedPinch = { gap: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), H: turnedMap ? turnedMap.H : renderedDayW };
}, { passive: true });
turnedEl.addEventListener('touchmove', e => {
  if (!turnedPinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const offset = (a.clientY + b.clientY) / 2 - turnedEl.getBoundingClientRect().top;
  const day = turnedDayAtY(turnedEl.scrollTop + offset);
  setZoom(turnedPinch.H * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / turnedPinch.gap);
  turnedEl.scrollTop = turnedYOfDay(day) - offset;
}, { passive: false });
turnedEl.addEventListener('touchend', e => { if (e.touches.length < 2) turnedPinch = null; });

// ---- Task sheet (phones) ----
// Everything about one task in a sheet that slides up: name, done or progress,
// dates, group, milestone, links, and its subtasks (each with a tick box, a
// name, its own links and ✕), plus adding subtasks and deleting the task.
// It opens showing the information; tap something to change it. Changes are
// saved straight away.
const sheet = document.getElementById('taskSheet');
const sheetBody = document.getElementById('sheetBody');
let sheetTaskId = null;
let sheetLinksFor = null; // the subtask whose links are shown under it
let sheetAdding = null;   // what is being added: 'sub', 'link:task' or 'link:<subtask id>'

let sheetOpenedAt = 0;
let sheetNew = null; // a just-created task, as it was, to remove it if the sheet closes unchanged
function openTaskSheet(id, { isNew = false, comments = false } = {}) {
  sheetTaskId = id;
  sheetLinksFor = null;
  sheetAdding = null;
  sheetPop = null;
  sheetNew = isNew ? JSON.stringify(tasks.find(t => t.id === id)) : null;
  window.collab?.openThread(id);
  drawSheet();
  if (!sheet.open) { sheet.showModal(); sheetOpenedAt = Date.now(); }
  sheetBody.scrollTop = 0;
  if (isNew) { const n = sheetBody.querySelector('.sheet-name'); n.focus(); n.select(); } // type the name straight away
  else sheetBody.focus({ preventScroll: true }); // just the information: nothing selected, no keyboard
  if (comments) window.collab?.showThread(); // from a task's 💬: straight to its comments
}
sheet.addEventListener('close', () => {
  const t = tasks.find(x => x.id === sheetTaskId);
  if (sheetNew && t && JSON.stringify(t) === sheetNew) removeTask(t.id);
  sheetNew = null;
  window.collab?.closeThread();
});

function sheetLinks(links, owner) {
  const adding = sheetAdding === `link:${owner}`;
  return `<ul class="sheet-links">${(links || []).map((l, i) => `<li>${CLIP_ICON}
      <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l.url))}</a>
      ${readOnly ? '' : `<button type="button" class="sheet-link-del" data-owner="${owner}" data-index="${i}" title="Remove link">✕</button>`}</li>`).join('')}</ul>
    ${readOnly ? (links || []).length ? '' : '<p class="sheet-none">None</p>' : adding ? `<form class="sheet-add-link" data-owner="${owner}">
        <input type="text" inputmode="url" autocomplete="off" placeholder="Paste a link (Google Doc, website…)">
        <button class="primary">Add</button>
      </form><div class="error"></div>`
      : `<button type="button" class="sheet-adder" data-add="link:${owner}">+ Add link</button>`}`;
}

// The task sheet. At the top, a strip in the group's colour; then the done circle
// (or the progress ring, with subtasks), the name with its group in small text under
// it (just text), ⋯ (Delete task) and ✕. Under that, its details as chips: the dates (with a ◆
// on each side: a milestone at the start or at the end), its links and "Add link".
// A chip opens a small picker (the dates, a new link) right under it.
// Then the subtasks, and the comments in their own grey area at the bottom.
let sheetPop = null; // the open picker: 'dates', 'link' or 'more' (⋯)
let sheetDurUnit = 'days'; // (the dates picker's duration: in days or weeks)
const ICON_CAL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_DIAMOND = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// "15 Oct – 22 Oct" (with the year when it isn't this year's)
function sheetDateText(t) {
  const thisYear = todayString().slice(0, 4);
  const short = s => parse(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(s.slice(0, 4) !== thisYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  return `${short(t.start)} – ${short(t.end)}`;
}

// The head, the chips and the subtasks heading: the same for editing and viewing
function sheetTop(t, subs, pct, edit) {
  const doneSubs = subs.filter(s => s.done).length;
  const len = daysBetween(parse(t.start), parse(t.end)) + 1;
  const days = `<span class="sheet-muted">· ${len} day${len > 1 ? 's' : ''}</span>`;
  const msText = { start: 'Milestone at start', end: 'Milestone at end' }[t.milestone];
  const circle = subs.length
    ? `<span class="sheet-ring" style="--pct:${pct}" role="img" aria-label="${doneSubs} of ${subs.length} subtasks done" title="${doneSubs}/${subs.length} subtasks done (${pct}%)"></span>`
    : edit ? `<button type="button" class="sheet-done-btn${t.done ? ' checked' : ''}" aria-pressed="${!!t.done}" title="${t.done ? 'Done. Click to mark as not done' : 'Click to mark as done'}">${t.done ? '✓' : ''}</button>`
    : subTick(t.done, true);
  const links = (t.links || []).map((l, i) => `<span class="sheet-chip sheet-link-chip">${CLIP_ICON}<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l.url))}</a>${edit
    ? `<button type="button" class="sheet-link-del" data-owner="task" data-index="${i}" title="Remove link" aria-label="Remove link">✕</button>` : ''}</span>`).join('');
  // A ◆ on each side of the dates: a milestone at the start or at the end (one at a time)
  const msBtn = where => {
    const on = t.milestone === where;
    return `<button type="button" class="sheet-ms-btn${on ? ' on' : ''}" data-ms="${where}" aria-pressed="${on}"
      title="${on ? `A milestone at the ${where}. Click to remove it` : `Put a milestone at the ${where}`}" aria-label="Milestone at the ${where}">${ICON_DIAMOND}</button>`;
  };
  const durN = sheetDurUnit === 'weeks' && len % 7 === 0 ? len / 7 : len;
  const durUnit = durN === len ? 'days' : 'weeks';
  return `
    <div class="sheet-strip" aria-hidden="true"></div>
    <div class="sheet-head">
      ${circle}
      <div class="sheet-titles">
        ${edit ? `<input class="sheet-name" value="${esc(t.name)}" aria-label="Task name" autocomplete="off">` : `<h2 class="sheet-title">${esc(t.name)}</h2>`}
        <span class="sheet-group-line${t.group ? '' : ' empty'}"><span class="sheet-dot"></span>${t.group ? esc(t.group) : 'No group'}</span>
      </div>
      ${edit ? `<button type="button" class="sheet-icon sheet-more" data-pop="more" aria-expanded="${sheetPop === 'more'}" title="More" aria-label="More">${ICON_MORE}</button>` : ''}
      <button type="button" class="sheet-icon sheet-close" title="Close" aria-label="Close">✕</button>
      ${sheetPop === 'more' ? `<div class="sheet-pop sheet-more-pop" role="menu"><button type="button" class="sheet-delete" role="menuitem">Delete task</button></div>` : ''}
    </div>
    <div class="sheet-chips">
      ${edit
        ? `<span class="sheet-dates">${msBtn('start')}<button type="button" class="sheet-chip" data-pop="dates" aria-expanded="${sheetPop === 'dates'}" title="Change the dates">${ICON_CAL}${sheetDateText(t)}${days}</button>${msBtn('end')}</span>
           ${links}
           <button type="button" class="sheet-chip dashed" data-pop="link" aria-expanded="${sheetPop === 'link'}">${CLIP_ICON}Add link</button>`
        : `<span class="sheet-chip">${ICON_CAL}${sheetDateText(t)}${days}</span>
           ${t.milestone ? `<span class="sheet-chip">${ICON_DIAMOND}${msText}</span>` : ''}
           ${links}`}
      ${sheetPop === 'dates' ? `<div class="sheet-pop" data-for="dates">
          <label>Start<input type="date" class="sheet-start" value="${t.start}"></label>
          <label>End<input type="date" class="sheet-end" value="${t.end}"></label>
          <label>Or a duration<span class="sheet-dur-row"><input type="number" class="sheet-dur" min="1" max="999" value="${durN}" aria-label="Duration">
            <select class="sheet-dur-unit" aria-label="Days or weeks">${['days', 'weeks'].map(u => `<option value="${u}"${u === durUnit ? ' selected' : ''}>${durN === 1 ? u.slice(0, -1) : u}</option>`).join('')}</select></span></label>
          <div class="error sheet-date-error"></div>
        </div>` : ''}
      ${sheetPop === 'link' ? `<div class="sheet-pop sheet-link-pop" data-for="link">
          <form class="sheet-add-link" data-owner="task"><input type="text" inputmode="url" autocomplete="off" placeholder="Paste a link (Google Doc, website…)"><button class="primary">Add</button></form><div class="error"></div>
        </div>` : ''}
    </div>
    ${edit ? `<h3 class="sheet-sec">Notes</h3><textarea class="sheet-notes" rows="2" placeholder="Notes and instructions…" aria-label="Notes and instructions">${esc(t.notes || '')}</textarea>`
      : t.notes ? `<h3 class="sheet-sec">Notes</h3><div class="sheet-notes sheet-notes-view">${esc(t.notes)}</div>` : ''}
    <h3 class="sheet-sec">Subtasks${subs.length ? `<span class="sheet-muted"> · ${doneSubs} of ${subs.length} · ${pct}%</span>` : ''}</h3>
    ${subs.length ? `<div class="sheet-progress"><span style="width:${pct}%"></span></div>` : ''}`;
}

function drawSheet() {
  const t = tasks.find(x => x.id === sheetTaskId);
  if (!t) { if (sheet.open) sheet.close(); return; }
  syncGroupColors();
  const c = t.group ? groupColorOf(groupColors[t.group]) || UNGROUPED_COLOR : UNGROUPED_COLOR;
  const subs = t.subtasks || [], pct = progressOf(t);
  sheetBody.style.setProperty('--bar', c.bg);
  if (readOnly) return drawSheetViewOnly(t, subs, pct);
  sheetBody.innerHTML = `${sheetTop(t, subs, pct, true)}
    <ul class="sheet-subs">${subs.map(s => `<li data-sub="${s.id}">
        <div class="sheet-sub-row">
          <input type="checkbox" class="sheet-sub-done" ${s.done ? 'checked' : ''} aria-label="Done">
          <span class="sheet-sub-no" title="Subtask ${s.no}">${s.no}</span>
          <input class="sheet-sub-name${s.done ? ' sub-checked' : ''}" value="${esc(s.name)}" aria-label="Subtask name" autocomplete="off">
          <button type="button" class="sheet-sub-links${(s.links || []).length ? ' has-links' : ''}${sheetLinksFor === s.id ? ' open' : ''}" title="Links">${CLIP_ICON}${(s.links || []).length ? `<small>${s.links.length}</small>` : ''}</button>
          <button type="button" class="sheet-sub-del" title="Delete subtask">✕</button>
        </div>
        ${sheetLinksFor === s.id ? `<div class="sheet-sub-linkbox">${sheetLinks(s.links, s.id)}</div>` : ''}
      </li>`).join('')}</ul>
    ${sheetAdding === 'sub'
      ? `<form class="sheet-add-sub"><input autocomplete="off" placeholder="New subtask"><button class="primary">Add</button></form>`
      : `<button type="button" class="sheet-adder" data-add="sub">${ICON_PLUS}Add subtask</button>`}
    <div class="sheet-thread-slot"></div>`;
  placeSheetPop();
  window.collab?.placeThread(sheetBody.querySelector('.sheet-thread-slot')); // the comments (kept across redraws)
}

// A picker opens right under its chip (and stays inside the sheet)
function placeSheetPop() {
  const pop = sheetBody.querySelector('.sheet-pop[data-for]');
  if (!pop) return;
  const chip = sheetBody.querySelector(`[data-pop="${pop.dataset.for}"]`), box = pop.parentElement;
  pop.style.top = `${chip.offsetTop + chip.offsetHeight + 6}px`;
  pop.style.left = `${Math.max(0, Math.min(chip.offsetLeft, box.clientWidth - pop.offsetWidth))}px`;
}

// A done / not done mark that only shows (viewing someone else's project): a
// small square like the subtask tick box, but not a box you can tick
const subTick = (done, round) => `<span class="sub-tick${done ? ' on' : ''}${round ? ' round' : ''}" role="img" aria-label="${done ? 'Done' : 'Not done yet'}"
  title="${done ? 'Done' : 'Not done yet'} (only the project's owner can change this)">${done ? '✓' : ''}</span>`;

// The sheet when viewing someone else's project: the same layout, with nothing
// that looks like it could be changed, a note saying so, and the comments
function drawSheetViewOnly(t, subs, pct) {
  sheetBody.innerHTML = `${sheetTop(t, subs, pct, false)}
    ${subs.length ? `<ul class="sheet-subs">${subs.map(s => `<li data-sub="${s.id}">
        <div class="sheet-sub-row">
          ${subTick(s.done)}
          <span class="sheet-sub-no" title="Subtask ${s.no}">${s.no}</span>
          <span class="sheet-sub-text${s.done ? ' sub-checked' : ''}">${esc(s.name)}</span>
          ${(s.links || []).length ? `<button type="button" class="sheet-sub-links has-links${sheetLinksFor === s.id ? ' open' : ''}" title="Links">${CLIP_ICON}<small>${s.links.length}</small></button>` : ''}
        </div>
        ${sheetLinksFor === s.id ? `<div class="sheet-sub-linkbox">${sheetLinks(s.links, s.id)}</div>` : ''}
      </li>`).join('')}</ul>` : '<p class="sheet-none">None</p>'}
    <p class="sheet-ro-note">${'<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>'}View only: you can read this task and write comments. Only the project's owner can change it.</p>
    <div class="sheet-thread-slot"></div>`;
  window.collab?.placeThread(sheetBody.querySelector('.sheet-thread-slot'));
}

const sheetTask = () => tasks.find(x => x.id === sheetTaskId);
const sheetOwner = owner => owner === 'task' ? sheetTask() : sheetTask().subtasks.find(s => s.id === owner);
function sheetCommit(focusSel) {
  save(); render(); drawSheet();
  if (focusSel) sheetBody.querySelector(focusSel)?.focus();
}

sheetBody.addEventListener('click', async e => {
  const t = sheetTask();
  if (e.target.closest('.sheet-close')) return sheet.close();
  const popBtn = e.target.closest('[data-pop]');
  if (popBtn && !readOnly) { // a chip's picker (or ⋯): open it, or close it again
    sheetPop = sheetPop === popBtn.dataset.pop ? null : popBtn.dataset.pop;
    drawSheet();
    return sheetBody.querySelector('.sheet-pop input')?.focus();
  }
  if (sheetPop && !e.target.closest('.sheet-pop')) { sheetPop = null; drawSheet(); } // a click elsewhere closes it
  if (e.target.closest('.sheet-done-btn') && !readOnly) { t.done = !t.done; return sheetCommit(); } // (its done circle)
  const msBtn = e.target.closest('.sheet-ms-btn');
  if (msBtn && !readOnly) { t.milestone = t.milestone === msBtn.dataset.ms ? '' : msBtn.dataset.ms; return sheetCommit(); }
  const adder = e.target.closest('.sheet-adder');
  if (adder) { // "+ Add link" / "+ Add subtask": show the field, ready to type
    sheetAdding = adder.dataset.add;
    drawSheet();
    return sheetBody.querySelector(sheetAdding === 'sub' ? '.sheet-add-sub input' : `.sheet-add-link[data-owner="${sheetAdding.slice(5)}"] input`)?.focus();
  }
  const linkDel = e.target.closest('.sheet-link-del');
  if (linkDel) { sheetOwner(linkDel.dataset.owner).links.splice(+linkDel.dataset.index, 1); return sheetCommit(); }
  const li = e.target.closest('.sheet-subs li');
  if (e.target.closest('.sheet-sub-links')) { sheetLinksFor = sheetLinksFor === li.dataset.sub ? null : li.dataset.sub; return drawSheet(); }
  if (e.target.closest('.sheet-sub-del')) { t.subtasks = t.subtasks.filter(s => s.id !== li.dataset.sub); return sheetCommit(); }
  if (e.target.closest('.sheet-delete')) {
    if (await askConfirm('Delete task?', `<b>${esc(t.name)}</b> and its subtasks and links will be removed.`, 'Delete')) {
      sheet.close(); removeTask(t.id);
    }
  }
});

sheetBody.addEventListener('change', e => {
  if (readOnly || e.target.closest('.thread')) return;
  const t = sheetTask(), el = e.target, li = el.closest('.sheet-subs li');
  if (el.matches('.sheet-name')) { t.name = el.value.trim() || t.name; return sheetCommit(); }
  if (el.matches('.sheet-done')) { t.done = el.checked; return sheetCommit(); }
  if (el.matches('.sheet-notes')) { t.notes = el.value.trim() ? el.value : ''; return sheetCommit(); }
  if (el.matches('.sheet-sub-done')) { t.subtasks.find(s => s.id === li.dataset.sub).done = el.checked; return sheetCommit(); }
  if (el.matches('.sheet-sub-name')) { const s = t.subtasks.find(s => s.id === li.dataset.sub); s.name = el.value.trim() || s.name; return sheetCommit(); }
  if (el.matches('.sheet-start, .sheet-end, .sheet-dur, .sheet-dur-unit')) {
    // (a duration sets the end date: counted from the start, the start day included)
    if (el.matches('.sheet-dur-unit')) sheetDurUnit = el.value;
    const start = sheetBody.querySelector('.sheet-start').value;
    let end = sheetBody.querySelector('.sheet-end').value;
    if (el.matches('.sheet-dur, .sheet-dur-unit') && start) {
      const n = Math.max(1, Math.round(+sheetBody.querySelector('.sheet-dur').value || 1));
      end = fmt(new Date(+parse(start) + (n * (sheetDurUnit === 'weeks' ? 7 : 1) - 1) * DAY));
    }
    if (!start || !end || end < start) { sheetBody.querySelector('.sheet-date-error').textContent = 'The end date must be on or after the start date.'; return; }
    const before = { ...t };
    Object.assign(t, { start, end });
    render(); drawSheet();
    offerToShiftFollowing(before, t, undefined, () => Object.assign(t, { start: before.start, end: before.end })).then(drawSheet);
  }
});

sheetBody.addEventListener('submit', e => {
  e.preventDefault();
  if (readOnly) return;
  const f = e.target, input = f.querySelector('input'), t = sheetTask();
  if (f.matches('.sheet-add-sub')) {
    const name = input.value.trim();
    if (!name) { sheetAdding = null; return drawSheet(); } // Enter on an empty field: done adding
    (t.subtasks ||= []).push({ id: uid(), name, done: false });
    return sheetCommit('.sheet-add-sub input'); // ready for the next one
  }
  if (f.matches('.sheet-add-link')) {
    const url = normalizeUrl(input.value);
    if (!url) { f.nextElementSibling.textContent = 'That doesn\'t look like a web link.'; return; }
    (sheetOwner(f.dataset.owner).links ||= []).push({ url });
    sheetAdding = null;
    sheetPop = null;
    sheetCommit();
  }
});
// Esc closes an open picker first, then the sheet
sheet.addEventListener('cancel', e => { if (sheetPop) { e.preventDefault(); sheetPop = null; drawSheet(); } });
// Tap outside the sheet closes it (but not the second click of a double-click that opened it)
sheet.addEventListener('click', e => { if (e.target === sheet && Date.now() - sheetOpenedAt > 500) sheet.close(); });

// ---- "Coming up" notice ----
// When the app opens (and again after midnight if it stays open), a notice
// lists the unfinished tasks that start today and later this week (weeks run
// Monday to Sunday). OK hides it until the next day.
const NOTICE_KEY = perProject('simple-gantt-notice-seen'); // the day the notice was last closed
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
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WorkNest//EN', 'CALSCALE:GREGORIAN',
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
  const blob = new Blob([JSON.stringify({ name: projectName, color: projectColor || undefined, tasks, groupColors }, null, 2)], { type: 'application/json' });
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
    if (!Array.isArray(data) && typeof data.color === 'string' && HEX.test(data.color)) { projectColor = normHex(data.color); drawProjectColor(); }
    if (!Array.isArray(data) && data.name) setProjectName(String(data.name));
    if (!Array.isArray(data)) data = data.tasks;
    if (!Array.isArray(data)) throw 0;
    tasks = data.map(t => ({
      id: t.id || uid(), name: t.name, group: t.group || '', start: t.start, end: t.end,
      milestone: t.milestone || '', done: !!t.done,
      after: Array.isArray(t.after) ? t.after.map(String) : [],
      links: cleanLinks(t.links),
      subtasks: Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ id: s.id || uid(), name: String(s.name), done: !!s.done, links: cleanLinks(s.links) })) : [],
      ...(typeof t.notes === 'string' && t.notes ? { notes: t.notes } : {}),
      ...(t.from && typeof t.from === 'object' ? { from: t.from } : {}), // (placed from an activity group)
    }));
    save(); render();
  } catch { alert('Could not read that file.'); }
  e.target.value = '';
};

// ---- Group colours (bar fill + readable text colour) ----
const PALETTE = [ // (soft colours from the logo's family; the text on them is worked out)
  { bg: '#9C95E6', fg: '#fff' },    // lavender
  { bg: '#E9806B', fg: '#fff' },    // coral
  { bg: '#5FB3A1', fg: '#fff' },    // teal
  { bg: '#E8B04A', fg: '#2a2540' }, // honey
  { bg: '#7194DE', fg: '#fff' },    // blue
  { bg: '#EE9A63', fg: '#2a2540' }, // apricot
  { bg: '#6CB8E2', fg: '#2a2540' }, // sky
  { bg: '#E7C65A', fg: '#2a2540' }, // butter
];
const UNGROUPED_COLOR = { bg: '#6E6E78', fg: '#fff' };
// A group's colour: one of the palette's (its number), or any colour (a hex code,
// chosen with the group's colour dot). null when it isn't a colour.
function groupColorOf(v) {
  if (typeof v === 'number' || /^\d+$/.test(v)) return PALETTE[+v] || null;
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return null;
  const n = parseInt(v.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return { bg: v, fg: (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#2a2540' : '#fff' }; // (dark text on light colours)
}

// ---- Collapsed groups (persisted) ----
const COLLAPSED_KEY = perProject('simple-gantt-collapsed');
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
// Collapse / expand all groups (the bar with a chevron above the task list, when there are groups)
chartEl.addEventListener('click', e => {
  const b = e.target.closest('[data-fold]');
  if (!b) return;
  collapsed = new Set(b.dataset.fold === 'collapse' ? tasks.map(t => t.group || '') : []);
  saveCollapsed(); render();
});
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
const EXPANDED_KEY = perProject('simple-gantt-expanded');
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
  const ok = await askConfirm('Remove the dependency?',
    `<b>${esc(to.name)}</b> will no longer be a successor of <b>${esc(from.name)}</b>, so it won't have to wait for it to finish.`, 'Remove dependency');
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
  const talk = e.target.closest('.cm-badge'); // a task's 💬: its comments
  if (talk) return openTaskSheet(talk.dataset.task, { comments: true });
  if (readOnly) { // viewing: open a task by clicking it; rings still show its subtasks
    const ring = e.target.closest('button.status.ring');
    if (ring) { expanded.has(ring.dataset.task) ? expanded.delete(ring.dataset.task) : expanded.add(ring.dataset.task); saveExpanded(); return render(); }
    const item = !e.target.closest('button') && e.target.closest('.bar, .labels .task-row');
    if (item) openTaskSheet(item.dataset.id);
    return;
  }
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
  if (readOnly) return render(); // (put the tick back)
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
  if (!readOnly) document.getElementById('linkInput').focus();
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
  if (readOnly) return;
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
  if (!btn || readOnly) return;
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
  openTaskSheet(owner.dataset.id);
});

// ---- Group order (persisted) ----
// Groups are shown by their earliest start date. Groups that start on the same
// day keep the order they had before, so this remembers the last order shown.
const GROUP_ORDER_KEY = perProject('simple-gantt-group-order');
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
const EDGE_NAV = 26;  // width of ‹ and › at the ends of the date header (matches .edge-nav in styles.css)
const HEAD_H = 77;    // height of the date header incl. its border (matches .head in styles.css)

// ---- The task list's width: drag its right edge ----
// Dragging the edge makes the list wider or narrower; dragging it almost shut
// folds it into a thin strip (the rows' colours still show), and dragging the
// strip out (or clicking it) opens it again. Double-click the edge to fold or
// open it. Remembered on this computer; not on phones (no list there).
const LIST_W_KEY = (TEST_MODE ? 'worknest-test:' : '') + 'simple-gantt-list-width';
const LIST_MIN = 120, LIST_FOLDED = 16, LIST_DEFAULT = 220;
let listW = LIST_DEFAULT, listFolded = false;
try {
  const saved = JSON.parse(localStorage.getItem(LIST_W_KEY));
  if (saved && saved.w >= LIST_MIN) listW = saved.w;
  if (saved) listFolded = !!saved.folded;
} catch {}
const listMax = () => Math.max(LIST_MIN, Math.min(640, (chartEl.clientWidth || 2000) - 160)); // (0 while the page is still hidden)
function applyListWidth() {
  const root = document.documentElement;
  if (phoneQuery.matches) { root.style.removeProperty('--labels-w'); root.classList.remove('list-folded'); return; }
  root.style.setProperty('--labels-w', (listFolded ? LIST_FOLDED : Math.min(listW, listMax())) + 'px');
  root.classList.toggle('list-folded', listFolded);
}
function saveListWidth() {
  try { localStorage.setItem(LIST_W_KEY, JSON.stringify({ w: listW, folded: listFolded })); } catch {}
}
function setListFolded(folded) {
  listFolded = folded;
  applyListWidth(); saveListWidth(); render();
}
applyListWidth();
chartEl.addEventListener('pointerdown', e => {
  if (!e.target.closest('.list-grip') || e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX, startW = labelsW(), wasW = listW;
  let moved = false;
  document.documentElement.classList.add('list-resizing');
  const move = ev => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    moved = true;
    const w = startW + ev.clientX - startX;
    listFolded = w < LIST_MIN * 0.6; // (dragged well past the narrowest: fold)
    if (!listFolded) listW = Math.max(LIST_MIN, Math.min(listMax(), w));
    applyListWidth();
    tidyHeaderLabels();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.documentElement.classList.remove('list-resizing');
    if (moved) { if (listFolded) listW = wasW; saveListWidth(); render(); } // (folded: it opens again at the width it had)
    else if (listFolded) setListFolded(false); // (a click on the folded strip opens it)
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});
chartEl.addEventListener('dblclick', e => { if (e.target.closest('.list-grip') && !listFolded) setListFolded(true); });
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
  if (readOnly || e.button !== 0 || e.target.closest('button, input, .renaming')) return; // (viewing: clicks only)
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
  // A click without dragging, on a bar or on a task's row (not its name): the task sheet
  if (!d.moved) return d.task && (d.kind === 'task' || d.kind === 'regroup') ? openTaskSheet(d.task.id) : undefined;

  if (d.kind === 'task' || d.kind === 'regroup') {
    const regroupTo = newGroupOf(d);
    const { start, end } = d.kind === 'task' ? draggedDates(d) : d.task;
    if (start === d.task.start && end === d.task.end && regroupTo === null) return render();
    const before = { ...d.task };
    Object.assign(d.task, { start, end }, regroupTo !== null ? { group: regroupTo } : {});
    render();
    offerToShiftFollowing(before, d.task, undefined, () => Object.assign(d.task, { start: before.start, end: before.end, group: before.group }));
  } else if (d.kind === 'group') {
    if (!d.days) return render();
    const members = tasks.filter(t => (t.group || '') === d.group);
    const before = {
      start: members.reduce((m, t) => t.start < m ? t.start : m, members[0].start),
      end: members.reduce((m, t) => t.end > m ? t.end : m, members[0].end),
    };
    const shift = s => fmt(new Date(+parse(s) + d.days * DAY));
    members.forEach(t => { t.start = shift(t.start); t.end = shift(t.end); });
    render();
    // Offer to move the tasks in other groups that come after this group
    const back = s => fmt(new Date(+parse(s) - d.days * DAY));
    offerToShiftFollowing(before, { name: groupLabel(d.group), group: d.group, end: shift(before.end), isGroup: true },
      new Set(members.map(t => t.id)), () => members.forEach(t => { t.start = back(t.start); t.end = back(t.end); }));
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
  numberSubtasks();
  const dayW = exportOpts ? exportOpts.dayW : zoom;
  // Tasks are always listed by start date (ties keep the order they were added)
  const sorted = [...tasks].sort((a, b) => a.start.localeCompare(b.start));

  // Remember which day is at the left edge of the view, so re-rendering
  // (after a change, a zoom or while dragging) doesn't jump the scroll position
  const leftDay = timelineEl() && chartStart ? getScrollDay() : null;
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

  const overviewBtn = document.getElementById('overviewBtn');
  overviewBtn.classList.toggle('active', !!overviewReturn);
  overviewBtn.setAttribute('aria-pressed', !!overviewReturn);
  const unit = { day: 'day', week: 'week', month: 'month', quarter: 'quarter' }[view] || 'screen';
  document.getElementById('prevBtn').title = `Previous ${unit}`;
  document.getElementById('nextBtn').title = `Next ${unit}`;
  // (› sits just left of the chart's scroll bar, if it has one)
  chartEl.parentElement.style.setProperty('--sbw', `${chartEl.offsetWidth - chartEl.clientWidth}px`);
  sbwWatch ||= new ResizeObserver(() => chartEl.parentElement.style.setProperty('--sbw', `${chartEl.offsetWidth - chartEl.clientWidth}px`));
  sbwWatch.disconnect(); sbwWatch.observe(chartEl); sbwWatch.observe(chartEl.querySelector('.track') || chartEl); // (the scrollbar can come or go later)

  // Header rows, top to bottom: quarter, month + year, ISO week, day number.
  // Quarter, month and week labels sit in a block as wide as their period and
  // stick to the left edge while you scroll, until the next one pushes them away.
  let grid = '', head = '';
  // (each label can be clicked to show just that period: data-view / data-date)
  const isShown = (cls, from) => view === cls && viewRange && viewRange.start === fmt(dateAt(from));
  const period = (cls, from, to, text, minPx, title = '') => {
    const w = (to - from) * dayW, plain = title || text.replace(/<[^>]+>/g, '');
    head += `<div class="hspan ${cls}${isShown(cls, from) ? ' shown' : ''}" data-view="${cls}" data-date="${fmt(dateAt(from))}" style="left:${from * dayW}px;width:${w}px" title="Show ${plain}">` +
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
        head += `<div class="day-label${dow === 0 || dow === 6 ? ' weekend' : ''}${fmt(d) === todayString() ? ' is-today' : ''}${view === 'day' && viewRange?.start === fmt(d) ? ' shown' : ''}" data-view="day" data-date="${fmt(d)}" title="Show ${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}" style="left:${i * dayW}px;width:${dayW}px">${fmt(d) === todayString() ? `<span class="today-pill">${label}</span>` : label}</div>`;
      }
    }
    if (i === 0) continue;
    if (last || d.getUTCDate() === 1) { // a month ends here
      const m = dateAt(monthFrom);
      period('month', monthFrom, i, m.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }), 64);
      monthFrom = i;
    }
    if (last || (d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0)) { // a quarter ends here (Jan, Apr, Jul, Oct)
      period('quarter', quarterFrom, i, `Q${Math.floor(dateAt(quarterFrom).getUTCMonth() / 3) + 1}`, 24, `Q${Math.floor(dateAt(quarterFrom).getUTCMonth() / 3) + 1} ${dateAt(quarterFrom).getUTCFullYear()}`);
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
  const groupColor = new Map(Object.entries(groupColors).map(([g, v]) => [g, groupColorOf(v) || UNGROUPED_COLOR]));

  // Collapse all / Expand all: above the task list, when there are groups
  // The list's heading, "∨ Tasks": with groups, its chevron (right above theirs)
  // collapses every group, and turns to › to expand them again
  const allShut = order.every(g => collapsed.has(g));
  const collapseAll = showHeaders ? `<button type="button" class="fold-all${allShut ? ' shut' : ''}" data-fold="${allShut ? 'expand' : 'collapse'}"
    title="${allShut ? 'Expand' : 'Collapse'} all groups" aria-expanded="${!allShut}"><svg class="chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Tasks</span></button>`
    : '<span class="list-title">Tasks</span>';

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
          <button class="toggle${isCollapsed ? ' shut' : ''}" data-toggle="${esc(g)}" title="${isCollapsed ? 'Expand' : 'Collapse'} group" aria-expanded="${!isCollapsed}"><svg class="chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          ${g && !readOnly ? `<button type="button" class="group-dot" data-group-color="${esc(g)}" title="Change the group's colour" aria-label="Change the colour of ${esc(g)}"></button>` : '<i class="group-dot" aria-hidden="true"></i>'}
          <span${g ? ` class="name" data-rename-group="${esc(g)}" title="Click to rename the group"` : ''}>${esc(groupLabel(g))}</span>
          ${isCollapsed ? `<small class="count">${list.length} task${list.length > 1 ? 's' : ''}</small>` : ''}
          ${g ? `<button type="button" class="preset-save" data-preset-group="${esc(g)}" title="Save as an activity group (to use again in any project)" aria-label="Save ${esc(g)} as an activity group"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 13l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>` : ''}
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
             title="${readOnly ? 'Click to see the task and its comments' : `Click the name to rename, double-click the row to edit dates and more${showHeaders ? ', drag onto another group to move it there' : ''}`}">
          ${subs.length
            // With subtasks: a thick two-tone ring that fills up with the progress.
            // Clicking it opens/closes the subtask list.
            ? `<button class="status ring" data-task="${t.id}" style="--pct:${pct}" aria-expanded="${open}"
                       title="${doneSubs}/${subs.length} subtasks done (${pct}%). Click to ${open ? 'hide' : 'show'} subtasks"></button>`
            // Without subtasks: a thin circle you click to mark the task done
            // (viewing: the same circle, but only showing it; it isn't a button)
            : readOnly ? `<span class="status${t.done ? ' checked' : ''}" role="img" aria-label="${t.done ? 'Done' : 'Not done yet'}"
                       title="${t.done ? 'Done' : 'Not done yet'} (only the project's owner can change this)">${t.done ? '✓' : ''}</span>`
            : `<button class="status${t.done ? ' checked' : ''}" data-task="${t.id}" aria-pressed="${!!t.done}"
                       title="${t.done ? 'Done. Click to mark as not done' : 'Click to mark as done'}">${t.done ? '✓' : ''}</button>`}
          ${t.milestone ? `<i class="ms-icon" title="Milestone at ${t.milestone}"></i>` : ''}
          <span class="name-wrap"><span class="name">${esc(t.name)}</span>${subs.length ? `<small class="sub-count" title="Subtasks done">(${doneSubs}/${subs.length})</small>` : ''}</span>
          ${linkButton(t.links, t.id)}
          <button class="sub-add-btn reveal" data-task="${t.id}" title="Add subtask">+</button>
          <button class="reveal" onclick="removeTask('${t.id}')" title="Delete">✕</button>
          ${window.collab?.badge(t.id) || ''}
        </div>`;

      rows += `<div class="row${grouped}" ${rowGroup} style="position:relative;height:${rowH}px;${colorVars}">
        <div class="bar${t.milestone ? ' ms-' + t.milestone : ''}${done}${open ? ' tall' : ''}" data-id="${t.id}" data-group="${esc(g)}" style="left:${left}px;width:${len * dayW}px;top:7px;height:${rowH - 14}px"
             title="${esc(t.name)}: ${t.start} → ${t.end} (${len} day${len > 1 ? 's' : ''})${subs.length ? ` · ${pct}% done` : ''}${t.milestone ? `\nMilestone at ${t.milestone}` : ''}${readOnly ? '\nClick to see the task and its comments' : '\nDouble-click to edit dates and more\nDrag to move (up/down to change group), drag edges to resize'}"
          ><span class="progress" style="width:${pct}%"></span><span class="handle" data-edge="start"></span><span class="label">${esc(t.name)}${subs.length ? ` · ${pct}%` : ''}</span><span class="handle" data-edge="end"></span>${t.milestone ? '<i class="diamond"></i>' : ''}<span class="link-dot" title="Drag onto another task to make it a successor of this one (it can only start after this one finishes)"></span></div>
      </div>`;

      // The subtask checklist in the list, one row per subtask (plus the line
      // being typed when adding one)
      if (open) {
        for (const s of subs) {
          labels += `<div class="row sub-row${grouped}${isSelected(t.id, s.id) ? ' selected' : ''}" data-task="${t.id}" data-sub="${s.id}" ${rowGroup} style="${colorVars}">
            ${readOnly ? subTick(s.done) : `<input type="checkbox" class="sub-done" data-task="${t.id}" data-sub="${s.id}" ${s.done ? 'checked' : ''}>`}
            <small class="sub-no" title="Subtask ${s.no} (refer to it in comments by its number)">${s.no}</small>
            <span class="name${s.done ? ' sub-checked' : ''}" data-task="${t.id}" data-sub="${s.id}"${readOnly ? '' : ' title="Click to rename"'}>${esc(s.name)}</span>
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
      <div class="labels"><div class="head">${collapseAll}</div>${labels}<div class="list-grip" title="${listFolded ? 'Click or drag to show the task list' : 'Drag to make the list wider or narrower (double-click to fold it away)'}"></div></div>
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
    if (leftDay !== null) scrollToDay(leftDay);
    chartEl.scrollTop = scrollTop;
  }
  applyDragVisual(); // re-apply an in-progress drag to the fresh elements
  if (!drag || !drag.moved) drawLinks();
  tidyHeaderLabels();
  if (sheet.open && !sheetBody.contains(document.activeElement)) drawSheet(); // keep an open task sheet up to date
  window.collab?.afterRender?.(); // (the overview above takes the same zoom and days)
}

// A quarter/month/week label that is being pushed out of view (its period is
// scrolling away behind the task list) is hidden rather than shown cut off.
function tidyHeaderLabels() {
  const visibleLeft = chartEl.getBoundingClientRect().left + labelsW() + EDGE_NAV;
  for (const span of chartEl.querySelectorAll('.hspan')) {
    const label = span.firstElementChild, r = span.getBoundingClientRect();
    label.style.visibility = r.right - Math.max(r.left, visibleLeft) < label.offsetWidth ? 'hidden' : '';
  }
  pinFirstLabels(visibleLeft);
}
// The first quarter / month / week in view is often only partly in view (a month
// rarely starts on a Monday), so its label doesn't fit in it and is hidden. It's
// shown anyway, at the left edge, so the three rows all start at the same point:
// shortened if needed ("Week 13" → "W13" → "13", "Apr 2026" → "Apr") to end
// before the next label. Clicking it shows that period, like the others.
var sbwWatch = null; // (keeps ›, at the chart's right edge, clear of its scrollbar)
function pinFirstLabels(visibleLeft) {
  const head = chartEl.querySelector('.track > .head');
  head?.querySelectorAll('.head-pin').forEach(el => el.remove());
  if (!head || exportOpts) return;
  const trackLeft = head.parentElement.getBoundingClientRect().left;
  for (const cls of ['quarter', 'month', 'week']) {
    const spans = [...head.querySelectorAll(`.hspan.${cls}`)];
    const k = spans.findIndex(sp => { const r = sp.getBoundingClientRect(); return r.left < visibleLeft - 1 && r.right > visibleLeft + 1; }); // (±1px: not a period that just touches the edge)
    if (k < 0 || spans[k].firstElementChild.style.visibility !== 'hidden') continue;
    const first = spans[k], next = spans[k + 1];
    const room = (next ? next.getBoundingClientRect().left + 4 : Infinity) - visibleLeft - 6;
    const full = first.title.replace(/^Show /, '');
    const n = full.match(/\d+$/)?.[0] || '';
    const texts = cls === 'week' ? [`Week ${n}`, `W${n}`, n] : cls === 'month' ? [full, full.split(' ')[0]] : [full.split(' ')[0]];
    const pin = document.createElement('div');
    pin.className = `hspan ${cls} head-pin${first.classList.contains('shown') ? ' shown' : ''}`;
    Object.assign(pin.dataset, { view: first.dataset.view, date: first.dataset.date });
    pin.title = first.title;
    pin.style.left = `${visibleLeft - trackLeft}px`;
    const inner = document.createElement('span');
    pin.append(inner);
    head.append(pin);
    for (const t of texts) { inner.textContent = t; if (inner.offsetWidth <= room) break; }
    if (inner.offsetWidth > room) pin.remove(); // (not even the shortest fits: no label, rather than one on top of the next)
  }
}
let tidyQueued = false;
chartEl.addEventListener('scroll', () => {
  window.collab?.followChart?.(); // (the overview above moves along)
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
    return { left: r.left - tr.left, right: r.right - tr.left, top: r.top - tr.top, bottom: r.bottom - tr.top, y: r.top - tr.top + 11 }; // y: the bar's first line
  };
  let out = '';
  for (const t of tasks) {
    for (const pid of t.after || []) {
      const a = box(pid), b = box(t.id), pred = tasks.find(x => x.id === pid);
      if (!a || !b || !pred) continue;
      const conflict = b.left < a.right - 1;
      const x1 = a.right, y1 = a.y, x2 = b.left, y2 = b.y;
      // Straight across and down into its start when there's room. A red one (it
      // starts before the first one has finished) loops back round between the rows
      // into its start, so the clash shows. Otherwise (it starts right after, with
      // no room) the arrow doesn't go back: it runs on a little from the first one's
      // end, then straight down (or up) onto the next bar.
      const room = x2 - x1 >= 16;
      const xm = Math.min(Math.max(x1 + 8, x2 + 8), Math.max(x1 + 8, b.right - 6)); // (on the bar where possible)
      const down = y2 > y1, edge = down ? b.top : b.bottom;
      const d = room ? `M${x1} ${y1} H${x1 + 8} V${y2} H${x2}`
        : conflict ? `M${x1} ${y1} H${x1 + 8} V${y2 + (down ? -ROW_H / 2 : ROW_H / 2)} H${x2 - 8} V${y2} H${x2}`
        : `M${x1} ${y1} H${xm} V${edge}`;
      const head = room || conflict ? `M${x2} ${y2} l-6 -4 v8 z` : `M${xm} ${edge} l-4 ${down ? -6 : 6} h8 z`;
      out += `<g class="link${conflict ? ' conflict' : ''}" data-from="${pid}" data-to="${t.id}">
        <title>${conflict ? `Dependency conflict: “${esc(t.name)}” starts before its predecessor “${esc(pred.name)}” finishes.`
          : `“${esc(t.name)}” is a successor of “${esc(pred.name)}”: it can only start after “${esc(pred.name)}” finishes.`}${readOnly ? '' : '\nClick to remove the dependency'}</title>
        <path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="10"/>
        <path class="line" d="${d}" fill="none" stroke="${conflict ? '#d94a3b' : '#6e6e73'}" stroke-width="1.5"/>
        <path class="head" d="${head}" fill="${conflict ? '#d94a3b' : '#6e6e73'}"/></g>`;
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}
}
applyPhoneLayout(); // phone or computer layout first, so the chart is positioned in the right one
render();
// A project kept in this browser is loaded now (an online one when it arrives, collab.js)
if (!CLOUD || localProject) { markSaved(true); restoreDraft(); } else drawSaveState();
// Open on the remembered Day / Week / Month / Quarter for today, or scroll to today
(() => {
  let v = null;
  try { v = localStorage.getItem(VIEW_KEY); } catch {}
  if (['day', 'week', 'month', 'quarter'].includes(v)) openView(v, todayString());
  else scrollToToday();
})();
checkComingUp();

// ---- Import Paste ----
// Cells copied from Google Sheets or Excel (a row or a column, tabs between the
// cells) become a group of deadlines: each date a one-day task, marked as a
// milestone. A cell of text next to a date (above it, in a row) is its name; text
// before the first date is the group's name. Opened from Export ▾ → Import Paste…,
// or by pasting (Ctrl+V) anywhere on the project page outside a field.
const PASTE_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12 };

// A date in a cell: 2026-10-18, 18/10/2026, 18.10.2026, 18 Oct, 18 Oct 2026,
// Oct 18, 2026, Sun, 18 Oct 2026 (Swedish month names too): { y, m, d } (y is
// missing when the cell has no year), or null when it isn't a date
function pasteParts(cell) {
  let s = String(cell || '').trim().replace(/^(mon|tue|wed|thu|fri|sat|sun|mån|tis|ons|tor|fre|lör|sön)[a-zåäö]*\.?,?\s+/i, ''); // (a weekday before it)
  if (!s) return null;
  let y, m, d, mt;
  if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = mt.map(Number);
  else if ((mt = s.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2}|\d{4}))?$/))) {
    [d, m, y] = [+mt[1], +mt[2], mt[3] && +mt[3]];
    if (m > 12 && d <= 12) [d, m] = [m, d]; // (month first, like 10/18/2026)
  } else if ((mt = s.match(/^(\d{1,2})\.?\s*([a-zåäö]+)\.?,?\s*(\d{4})?$/i))) [d, m, y] = [+mt[1], PASTE_MONTHS[mt[2].slice(0, 3).toLowerCase()], mt[3] && +mt[3]];
  else if ((mt = s.match(/^([a-zåäö]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/i))) [m, d, y] = [PASTE_MONTHS[mt[1].slice(0, 3).toLowerCase()], +mt[2], mt[3] && +mt[3]];
  else return null;
  if (!m || m > 12 || !d || d > 31) return null;
  if (y && y < 100) y += 2000;
  return { y: y || undefined, m, d };
}
// "YYYY-MM-DD", or null when there's no such day (31 Feb)
function pasteMake(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 ? fmt(t) : null; }
// The year that puts a day and month nearest today
function pasteNearestYear(m, d) {
  const now = +parse(todayString()), ty = new Date(now).getUTCFullYear();
  return [ty - 1, ty, ty + 1].filter(y => pasteMake(y, m, d))
    .sort((a, b) => Math.abs(+parse(pasteMake(a, m, d)) - now) - Math.abs(+parse(pasteMake(b, m, d)) - now))[0] || ty;
}

// The pasted text → { header, items: [{ name, start, end }], skipped: [cells],
// year }. Dates without a year get `year` (or, without one, the year that puts the
// first of them nearest today); `year` comes back as the year used (null when every
// date has its own). A list that runs past New Year (Dec, then Jan) goes on into
// the next year.
function readPaste(text, year) {
  const grid = String(text || '').replace(/\r/g, '').replace(/\n+$/, '').split('\n').map(line => line.split('\t'));
  const width = Math.max(0, ...grid.map(r => r.length));
  const parts = grid.map(r => r.map(pasteParts));
  const inRow = Math.max(0, ...parts.map(r => r.filter(Boolean).length));
  const inCol = Math.max(0, ...Array.from({ length: width }, (_, i) => parts.filter(r => r[i]).length));
  const across = inRow > inCol; // (a row of dates: each column is one deadline)
  const lines = across ? Array.from({ length: width }, (_, i) => grid.map(r => r[i] ?? '')) : grid;
  let header = '', y = year || null, firstYear = null, prev = null;
  const items = [], skipped = [];
  for (const cells of lines) {
    const found = [], words = [];
    for (const cell of cells) {
      const p = pasteParts(cell);
      let date = null;
      if (p && p.y) date = pasteMake(p.y, p.m, p.d);
      else if (p) {
        y ||= pasteNearestYear(p.m, p.d);
        firstYear ||= y;
        date = pasteMake(y, p.m, p.d);
        if (date && prev && +parse(date) < +parse(prev) - 60 * DAY) date = pasteMake(++y, p.m, p.d); // (past New Year)
      }
      if (date) { found.push(date); prev = date; }
      else if (cell.trim()) words.push(cell.trim());
    }
    found.sort();
    if (!found.length) {
      if (!items.length && !header && words.length) header = words[0]; // (a heading before the dates)
      else skipped.push(...words);
      continue;
    }
    items.push({ name: words[0] || '', start: found[0], end: found[found.length - 1] });
  }
  items.forEach((it, i) => { it.name ||= `Deadline ${i + 1}`; });
  return { header, items, skipped, year: firstYear };
}

const pasteDialog = document.getElementById('pasteDialog');
const pasteText = document.getElementById('pasteText');
const pasteGroup = document.getElementById('pasteGroup');
const pastePreview = document.getElementById('pastePreview');
const pasteNote = document.getElementById('pasteNote');
const pasteOk = document.getElementById('pasteOk');
const pasteYear = document.getElementById('pasteYear');
let pasteItems = [];

// A group name no group has yet ("Deadlines", "Deadlines 2", …)
function freeGroupName(base) {
  const used = new Set(tasks.map(t => t.group));
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
  return name;
}

function drawPaste(fromText) {
  if (fromText) {
    const r = readPaste(pasteText.value);
    pasteItems = r.items.map(it => ({ ...it, use: true }));
    pasteGroup.value = r.header || freeGroupName('Deadlines');
    pasteDialog.dataset.skipped = r.skipped.join(', ');
    // Dates without a year: the year to put them in (the nearest one to start with)
    pasteYear.closest('label').hidden = !r.year;
    if (r.year) {
      const ty = +todayString().slice(0, 4);
      pasteYear.innerHTML = [...new Set([ty - 1, ty, ty + 1, ty + 2, r.year])].sort()
        .map(v => `<option value="${v}"${v === r.year ? ' selected' : ''}>${v}</option>`).join('');
    }
  }
  const day = s => parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  pastePreview.innerHTML = pasteItems.map((it, i) => `<li data-i="${i}">
      <input type="checkbox" class="paste-use" ${it.use ? 'checked' : ''} aria-label="Import this one">
      <input class="paste-name" value="${esc(it.name)}" aria-label="Name" autocomplete="off">
      <span class="paste-when">${it.start === it.end ? day(it.start) : `${day(it.start)} – ${day(it.end)}`}</span>
    </li>`).join('');
  pastePreview.hidden = !pasteItems.length;
  const n = pasteItems.filter(it => it.use).length;
  const group = pasteGroup.value.trim();
  const exists = group && tasks.some(t => t.group === group);
  const skipped = pasteDialog.dataset.skipped;
  pasteNote.innerHTML = !pasteText.value.trim() ? ''
    : !pasteItems.length ? 'No dates found. Copy the cells with the dates in Google Sheets or Excel and paste them here.'
    : `${n} deadline${n === 1 ? '' : 's'} into ${exists ? 'the existing' : 'a new'} group <b>${esc(group || 'without a name')}</b>.${skipped ? ` Not dates (left out): ${esc(skipped)}.` : ''}`;
  pasteOk.disabled = !n;
  pasteOk.textContent = n ? `Import ${n}` : 'Import';
}

function openPaste(text = '') {
  if (readOnly) return;
  pasteText.value = text;
  pasteDialog.returnValue = '';
  drawPaste(true);
  pasteDialog.showModal();
  (text ? pasteGroup : pasteText).focus();
  if (text) pasteGroup.select();
}

pasteText.addEventListener('input', () => drawPaste(true));
// Another year: the same deadlines (names and ticks kept), moved to that year
pasteYear.addEventListener('change', () => {
  const r = readPaste(pasteText.value, +pasteYear.value);
  pasteItems = r.items.map((it, i) => ({ ...it, name: pasteItems[i]?.name ?? it.name, use: pasteItems[i]?.use ?? true }));
  drawPaste(false);
});
pasteGroup.addEventListener('input', () => drawPaste(false));
pastePreview.addEventListener('input', e => {
  const it = pasteItems[+e.target.closest('li').dataset.i];
  if (e.target.matches('.paste-name')) it.name = e.target.value;
});
pastePreview.addEventListener('change', e => {
  if (!e.target.matches('.paste-use')) return;
  pasteItems[+e.target.closest('li').dataset.i].use = e.target.checked;
  drawPaste(false);
});
pasteDialog.addEventListener('close', () => {
  if (pasteDialog.returnValue !== 'ok') return;
  const group = pasteGroup.value.trim();
  const milestone = document.getElementById('pasteMilestone').checked ? 'end' : '';
  const add = pasteItems.filter(it => it.use).map(it => ({
    id: uid(), name: it.name.trim() || 'Deadline', group, start: it.start, end: it.end, milestone, done: false,
  }));
  if (!add.length) return;
  tasks.push(...add);
  save(); render();
  scrollToDay(dayNumber(parse(add.map(t => t.start).sort()[0])), 80); // (to the first one)
});
document.getElementById('pasteImportBtn').onclick = () => openPaste();
// Pasting dates anywhere on the project page (not into a field) opens it, filled in
document.addEventListener('paste', e => {
  const root = document.documentElement;
  if (readOnly || (root.classList.contains('cloud') && !root.classList.contains('page-app'))) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text || !readPaste(text).items.length) return;
  e.preventDefault();
  openPaste(text);
});

// ---- The sidebar (your projects and presets), next to the chart ----
// Folded away by default; the button at the top left shows it (it pushes the
// chart over) or folds it away again. Remembered on this computer.
(() => {
  const btn = document.getElementById('sideToggle');
  if (!btn) return;
  const KEY = 'worknest-side-open';
  const set = open => {
    document.documentElement.classList.toggle('side-open', open);
    btn.setAttribute('aria-expanded', open);
    btn.title = btn.ariaLabel = open ? 'Hide your projects' : 'Show your projects';
  };
  let open = false;
  try { open = localStorage.getItem(KEY) === '1'; } catch {}
  set(open);
  btn.addEventListener('click', () => {
    open = !open;
    set(open);
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch {}
    requestAnimationFrame(() => render()); // (the chart's width changed)
  });
})();

// ---- A group's colour: its dot in the task list opens a picker (as the project's) ----
// One of the swatches, any colour, or a hex code. A change like any other (Save).
(() => {
  const pop = document.createElement('div');
  pop.className = 'menu color-pop group-color-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', "The group's colour");
  pop.hidden = true;
  pop.innerHTML = `<p class="color-pop-head">Group colour</p>
    <div class="color-swatches">${PALETTE.map((c, i) => `<button type="button" data-gcolor="${i}" style="--c:${c.bg}" aria-label="${c.bg}" title="${c.bg}"></button>`).join('')}</div>
    <div class="color-custom">
      <input type="color" class="gc-native" title="Pick any colour" aria-label="Pick any colour">
      <input class="gc-hex" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#4f8ff7" aria-label="Colour as a hex code" title="A hex code, like #4f8ff7">
    </div>
    <div class="error gc-error"></div>`;
  document.body.append(pop);
  const native = pop.querySelector('.gc-native'), hex = pop.querySelector('.gc-hex'), err = pop.querySelector('.gc-error');
  let group = null, anchor = null;

  function drawPop() {
    const v = groupColors[group], c = groupColorOf(v) || UNGROUPED_COLOR;
    for (const b of pop.querySelectorAll('[data-gcolor]')) b.classList.toggle('on', String(v) === b.dataset.gcolor);
    native.value = c.bg.toLowerCase();
    if (document.activeElement !== hex) hex.value = typeof v === 'string' && v.startsWith('#') ? v : c.bg.toLowerCase();
  }
  function open(g, dot) {
    group = g; anchor = dot;
    err.textContent = '';
    pop.hidden = false;
    drawPop();
    const r = dot.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left - 8, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`;
    (pop.querySelector('.on') || hex).focus();
  }
  function close() { if (!pop.hidden) { pop.hidden = true; group = null; } }
  function setColor(v) {
    if (readOnly || !group || groupColors[group] === v) return;
    groupColors[group] = v;
    save(); render();
    drawPop();
  }
  chartEl.addEventListener('click', e => {
    const dot = e.target.closest('.group-dot[data-group-color]');
    if (!dot || readOnly) return;
    e.stopPropagation();
    if (!pop.hidden && group === dot.dataset.groupColor) return close();
    open(dot.dataset.groupColor, dot);
  }, true);
  pop.addEventListener('click', e => {
    const sw = e.target.closest('[data-gcolor]');
    if (sw) { setColor(+sw.dataset.gcolor); close(); }
  });
  native.addEventListener('input', () => { setColor(native.value.toLowerCase()); hex.value = native.value.toLowerCase(); });
  hex.addEventListener('input', () => {
    const ok = HEX.test(hex.value.trim());
    err.textContent = ok || hex.value.trim().length < 4 ? '' : 'Use a hex code like #4f8ff7';
    if (ok) setColor(normHex(hex.value));
  });
  hex.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (HEX.test(hex.value.trim())) close(); } });
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !e.target.closest('.group-color-pop, .group-dot')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) close(); });
  chartEl.addEventListener('scroll', close, { passive: true });
})();
