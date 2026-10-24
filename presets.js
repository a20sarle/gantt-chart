// ---- Presets: groups you use again and again ----
// A preset is a group of activities around one key date (e.g. "Pink event": the
// event itself, and "Sponsor check-in" 2 days before). Drag it from the presets
// shelf onto the chart and drop it on the key date: the group is made with every
// activity in its place. Presets are yours (saved with your account when you're
// signed in, see collab.js; otherwise in this browser), usable in all your
// projects.
//
// A preset: { id, name, color (a PALETTE index), items: [{ id, name, offset (days
// from the key date to its start: -2 is 2 days before), len (days), milestone,
// key (the key date), after (ids of items it's linked after), subtasks (names) }] }
// Days are counted as every day (weekends too).
(() => {
  const PRESETS_KEY = 'worknest-presets';
  const shelf = document.getElementById('sidePresets'); // (in the sidebar)
  const dlg = document.getElementById('presetDialog');
  const body = document.getElementById('presetBody');

  // ---- Where they're kept: your account (collab.js), or this browser ----
  const api = () => window.collab?.presetsApi?.() || null;
  const storeState = () => api()?.state() || 'ok'; // 'loading' | 'ok' | 'error'
  function list() {
    const a = api();
    if (a) return a.list();
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; } catch { return []; }
  }
  async function store(next) {
    const a = api();
    if (a) return a.save(next);
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch {}
  }

  const colorOf = p => groupColorOf(p.color) || PALETTE[0];
  const activities = n => n === 1 ? '1 activity' : `${n} activities`;
  const keyItem = p => p.items.find(it => it.key) || p.items[0];
  const longDay = n => new Date(n * DAY).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  // ---- In the sidebar: one item per preset (drag it onto the chart; click to edit) ----
  function drawShelf() {
    if (!shelf) return;
    const state = storeState();
    const presets = state === 'ok' ? list() : [];
    shelf.innerHTML = `
      ${state === 'loading' ? '<p class="side-empty">Loading…</p>'
        : state === 'error' ? '<p class="side-empty">Your activity groups couldn\'t be loaded.</p>'
        : !presets.length ? '<p class="side-empty">Groups you use again and again, placed around a key date.</p>'
        : `<p class="side-empty">${useTurnedMap() ? 'Tap one to add it on a date.' : 'Drag one onto the chart, onto its key date.'}</p>`}
      ${presets.map(p => `<button type="button" class="preset-chip side-proj" data-preset="${esc(p.id)}" style="--dot:${colorOf(p).bg}"
          title="${esc(p.name)}: ${activities(p.items.length)}. Drag onto the chart and drop on the key date (${esc(keyItem(p).name)}); click to edit">
          <i aria-hidden="true"></i><span>${esc(p.name)}</span><small>${p.items.length}</small></button>`).join('')}
      ${state === 'ok' ? '<button type="button" class="preset-new side-link side-new">+ New activity group</button>' : ''}`;
  }
  window.drawPresets = drawShelf; // (collab.js: your presets have loaded)

  // ---- Placing a preset: its key date on `keyDay` (a day number) ----
  function freeGroup(base) {
    const used = new Set(tasks.map(t => t.group));
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
    return name;
  }
  function placePreset(p, keyDay) {
    if (readOnly || !p.items.length) return;
    const group = freeGroup(p.name);
    const ids = new Map(p.items.map(it => [it.id, uid()]));
    const made = p.items.map(it => {
      const start = keyDay + it.offset;
      return {
        id: ids.get(it.id), name: it.name, group,
        start: dayString(start), end: dayString(start + Math.max(1, it.len) - 1),
        milestone: it.milestone || (it.key ? 'start' : ''), done: false, // (the key date is always a ◆ milestone)
        after: (it.after || []).map(a => ids.get(a)).filter(Boolean),
        links: [],
        subtasks: (it.subtasks || []).map((name, i) => ({ id: uid(), no: i + 1, name, done: false })),
      };
    });
    tasks.push(...made);
    if (groupColorOf(p.color)) groupColors[group] = p.color;
    save(); render();
  }

  // ---- Dragging a chip onto the chart ----
  let press = null; // { preset, x, y, chip, dragging }
  const ghost = document.createElement('div');
  ghost.className = 'preset-ghost';
  ghost.hidden = true;
  document.body.append(ghost);

  const overChart = (x, y) => {
    const r = chartEl.getBoundingClientRect();
    return !useTurnedMap() && x > r.left + labelsW() && x < r.right && y > r.top && y < r.bottom;
  };
  const dayX = n => chartEl.querySelector('.track').getBoundingClientRect().left + (n - dayNumber(chartStart)) * renderedDayW;

  function drawGhost(x, y) {
    const p = press.preset, c = colorOf(p);
    ghost.style.setProperty('--c', c.bg);
    ghost.style.setProperty('--fg', c.fg);
    if (!overChart(x, y)) { // (not over the chart yet: just its name, by the pointer)
      ghost.innerHTML = `<div class="pg-chip" style="left:${x + 12}px;top:${y + 10}px">${esc(p.name)} <small>Drop on the chart, on the key date</small></div>`;
      press.day = null;
      return;
    }
    const key = keyItem(p);
    const day = Math.floor(pointerDay(x)) - key.offset;    // (the key date is under the pointer)
    press.day = day;
    const r = chartEl.getBoundingClientRect();
    const rowH = 24;
    ghost.innerHTML = `
      <div class="pg-line" style="left:${dayX(day) + renderedDayW / 2 - 1}px;top:${r.top}px;height:${r.height}px"></div>
      <div class="pg-label" style="left:${dayX(day) + renderedDayW / 2 + 6}px;top:${Math.max(r.top + 4, y - 34)}px">${esc(key.name)} · ${longDay(day + key.offset)}</div>
      ${[...p.items].sort((a, b) => a.offset - b.offset).map((it, i) => `<div class="pg-bar${it.key ? ' key' : ''}" style="left:${dayX(day + it.offset) + 1}px;width:${Math.max(1, it.len) * renderedDayW - 2}px;top:${y + 8 + i * rowH}px">${it.milestone || it.key ? '◆ ' : ''}${esc(it.name)}</div>`).join('')}`;
    // Near the chart's left or right edge: scroll on
    const left = r.left + labelsW() + 40, right = r.right - 40;
    if (x < left) chartEl.scrollLeft -= 14; else if (x > right) chartEl.scrollLeft += 14;
  }

  shelf.addEventListener('pointerdown', e => {
    const chip = e.target.closest('.preset-chip[data-preset]');
    if (!chip || e.button !== 0) return;
    const preset = list().find(p => p.id === chip.dataset.preset);
    if (!preset) return;
    press = { preset, x: e.clientX, y: e.clientY, chip, dragging: false, day: null };
    try { chip.setPointerCapture(e.pointerId); } catch {}
  });
  shelf.addEventListener('pointermove', e => {
    if (!press) return;
    if (!press.dragging) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5 || useTurnedMap()) return;
      press.dragging = true;
      ghost.hidden = false;
      document.documentElement.classList.add('preset-dragging');
    }
    drawGhost(e.clientX, e.clientY);
  });
  function endPress(drop) {
    if (!press) return;
    const { preset, dragging, day } = press;
    press = null;
    ghost.hidden = true;
    ghost.innerHTML = '';
    document.documentElement.classList.remove('preset-dragging');
    if (!dragging) return openEditor(preset); // (a click: edit it)
    if (drop && day !== null) placePreset(preset, day);
  }
  shelf.addEventListener('pointerup', () => endPress(true));
  shelf.addEventListener('pointercancel', () => endPress(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && press?.dragging) { press.dragging = true; press.day = null; endPress(false); } });
  shelf.addEventListener('click', e => { if (e.target.closest('.preset-new')) openEditor(null); });

  // ---- "Save as preset" on a group in the task list ----
  chartEl.addEventListener('click', e => {
    const btn = e.target.closest('.preset-save');
    if (!btn || readOnly) return;
    e.stopPropagation();
    const g = btn.dataset.presetGroup;
    const list = tasks.filter(t => (t.group || '') === g).sort((a, b) => a.start.localeCompare(b.start));
    if (!list.length) return;
    const key = list.find(t => t.milestone) || list[0];
    const ids = new Set(list.map(t => t.id));
    const keyStart = +parse(key.start);
    openEditor({
      id: null, name: g || 'New activity group', color: groupColors[g] ?? 0,
      items: list.map(t => ({
        id: t.id, name: t.name, key: t === key,
        offset: daysBetween(new Date(keyStart), parse(t.start)),
        len: daysBetween(parse(t.start), parse(t.end)) + 1,
        milestone: t.milestone || '',
        after: (t.after || []).filter(a => ids.has(a)),
        subtasks: (t.subtasks || []).map(s => s.name),
      })),
    }, { fromGroup: true });
  }, true);

  // ---- The preset editor ----
  let draft = null, draftIsNew = false;
  function openEditor(p, { fromGroup = false } = {}) {
    if (readOnly) return;
    draftIsNew = !p || !p.id;
    draft = p ? JSON.parse(JSON.stringify(p)) : {
      id: null, name: '', color: Math.floor(Math.random() * PALETTE.length),
      items: [{ id: uid(), name: 'Event', key: true, offset: 0, len: 1, milestone: 'end', after: [], subtasks: [] }],
    };
    dlg.dataset.fromGroup = fromGroup ? '1' : '';
    drawEditor();
    dlg.showModal();
    const name = body.querySelector('.pe-title');
    if (!draft.name || fromGroup) { name.focus(); name.select(); } else body.focus();
  }

  function drawEditor(focusSel) {
    const c = colorOf(draft);
    const items = [...draft.items].sort((a, b) => a.offset - b.offset || (b.key - a.key)); // (in date order: before the key date above it, after it below; on the same day, the key date first)
    body.style.setProperty('--c', c.bg);
    body.innerHTML = `
      <div class="pe-head">
        <span class="pe-dot"></span>
        <input class="pe-title" value="${esc(draft.name)}" placeholder="Name, e.g. Pink event" aria-label="Activity group name" autocomplete="off">
        <button type="button" class="sheet-icon pe-close" title="Close" aria-label="Close">✕</button>
      </div>
      ${dlg.dataset.fromGroup ? '<p class="pe-note">Made from the group: check which activity is the key date and the days, then save.</p>' : ''}
      <div class="pe-colors" role="radiogroup" aria-label="Colour">${PALETTE.map((p, i) => `<button type="button" class="pe-color${i === draft.color ? ' on' : ''}" data-color="${i}" style="--c:${p.bg}" role="radio" aria-checked="${i === draft.color}" aria-label="Colour ${i + 1}"></button>`).join('')}</div>
      <p class="pe-help">The <b>key date</b> lands on the day you drop the group on; the other activities are placed before and after it. Click ● in front of an activity to make it the key date.</p>
      <ol class="pe-items">${items.map(it => {
        const i = draft.items.indexOf(it);
        const dir = it.offset < 0 ? 'before' : it.offset > 0 ? 'after' : 'on';
        return `<li data-i="${i}" class="${it.key ? 'is-key' : ''}">
          <input type="radio" name="pe-key" class="pe-key" ${it.key ? 'checked' : ''} title="${it.key ? 'The key date: where you drop the activity group' : 'Make this the key date'}" aria-label="Key date">
          <input class="pe-name" value="${esc(it.name)}" aria-label="Activity name" autocomplete="off">
          ${it.key ? '<span class="pe-keytext">◆ Key date</span>' : `<span class="pe-when">
            <input type="number" class="pe-off" min="0" max="999" value="${Math.abs(it.offset)}" aria-label="Days" ${dir === 'on' ? 'hidden' : ''}>
            <select class="pe-dir" aria-label="Before or after the key date">
              <option value="before"${dir === 'before' ? ' selected' : ''}>days before</option>
              <option value="after"${dir === 'after' ? ' selected' : ''}>days after</option>
              <option value="on"${dir === 'on' ? ' selected' : ''}>on the key date</option>
            </select></span>`}
          <span class="pe-len"><input type="number" class="pe-days" min="1" max="999" value="${Math.max(1, it.len)}" aria-label="Length in days"> ${Math.max(1, it.len) === 1 ? 'day' : 'days'}</span>
          ${it.key ? '<button type="button" class="pe-ms on" disabled title="The key date is always shown as a milestone (◆)" aria-pressed="true">◆</button>'
            : `<button type="button" class="pe-ms${it.milestone ? ' on' : ''}" title="${it.milestone ? 'A milestone (◆). Click to make it a plain activity' : 'Make it a milestone (◆)'}" aria-pressed="${!!it.milestone}">◆</button>`}
          <button type="button" class="pe-del" title="Remove this activity" aria-label="Remove" ${draft.items.length < 2 ? 'disabled' : ''}>✕</button>
        </li>`;
      }).join('')}</ol>
      <button type="button" class="sheet-adder pe-add">+ Add activity</button>
      <div class="pe-place">
        <label>Add to this project with the key date on <input type="date" class="pe-date" value="${todayString()}"></label>
        <button type="button" class="pe-place-btn">Add</button>
      </div>
      <div class="error pe-error"></div>
      <div class="actions pe-actions">
        ${draftIsNew ? '' : '<button type="button" class="pe-delete">Delete activity group</button>'}
        <span class="spacer"></span>
        <button type="button" class="pe-cancel">Cancel</button>
        <button type="button" class="primary pe-save">Save activity group</button>
      </div>`;
    if (focusSel) body.querySelector(focusSel)?.focus();
  }

  const rowItem = el => draft.items[+el.closest('li').dataset.i];
  body.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('.pe-title')) draft.name = el.value;
    else if (el.matches('.pe-name')) rowItem(el).name = el.value;
  });
  body.addEventListener('change', e => {
    const el = e.target;
    if (el.matches('.pe-key')) { // another key date: the others keep their place, counted from it
      const k = rowItem(el), shift = k.offset;
      for (const it of draft.items) { it.offset -= shift; it.key = it === k; }
      return drawEditor();
    }
    if (el.matches('.pe-off, .pe-dir')) {
      const li = el.closest('li'), it = rowItem(el);
      const n = Math.max(0, Math.round(+li.querySelector('.pe-off').value || 0));
      const dir = li.querySelector('.pe-dir').value;
      it.offset = dir === 'on' ? 0 : dir === 'before' ? -n : n;
      if (dir !== 'on' && n === 0) it.offset = dir === 'before' ? -1 : 1; // ("0 days before" is "on the key date")
      return drawEditor();
    }
    if (el.matches('.pe-days')) { rowItem(el).len = Math.max(1, Math.round(+el.value || 1)); return drawEditor(); }
  });
  body.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('.pe-close, .pe-cancel')) return dlg.close();
    const color = t.closest('.pe-color');
    if (color) { draft.color = +color.dataset.color; return drawEditor(); }
    if (t.closest('.pe-ms')) { const it = rowItem(t); it.milestone = it.milestone ? '' : 'end'; return drawEditor(); }
    if (t.closest('.pe-del')) {
      const it = rowItem(t);
      draft.items = draft.items.filter(x => x !== it);
      draft.items.forEach(x => { x.after = (x.after || []).filter(a => a !== it.id); });
      if (it.key) { const k = draft.items[0], shift = k.offset; for (const x of draft.items) { x.offset -= shift; x.key = x === k; } }
      return drawEditor();
    }
    if (t.closest('.pe-add')) {
      draft.items.push({ id: uid(), name: 'New activity', key: false, offset: -1, len: 1, milestone: '', after: [], subtasks: [] });
      drawEditor();
      const rows = body.querySelectorAll('.pe-items li');
      const li = [...rows].find(r => draft.items[+r.dataset.i] === draft.items[draft.items.length - 1]);
      li?.querySelector('.pe-name')?.select();
      return;
    }
    if (t.closest('.pe-save')) { if (await saveDraft()) dlg.close(); return; }
    if (t.closest('.pe-place-btn')) {
      const date = body.querySelector('.pe-date').value;
      if (!date) return showError('Choose the key date first.');
      if (!(await saveDraft())) return;
      const p = draft;
      dlg.close();
      placePreset(p, dayNumber(parse(date)));
      scrollToDay(dayNumber(parse(date)) + Math.min(...p.items.map(it => it.offset)), 80);
      return;
    }
    if (t.closest('.pe-delete')) {
      if (!(await askConfirm('Delete activity group?', `<b>${esc(draft.name)}</b> will be removed from your activity groups. Groups already made from it stay as they are.`, 'Delete'))) return;
      await store(list().filter(p => p.id !== draft.id));
      dlg.close(); drawShelf();
    }
  });
  const showError = msg => { body.querySelector('.pe-error').textContent = msg; };
  async function saveDraft() {
    draft.name = draft.name.trim();
    if (!draft.name) { showError('Give the activity group a name.'); body.querySelector('.pe-title').focus(); return false; }
    if (storeState() !== 'ok') { showError('Your activity groups haven\'t loaded yet. Try again in a moment.'); return false; }
    draft.items.forEach(it => { it.name = it.name.trim() || 'Activity'; });
    if (!draft.items.some(it => it.key)) draft.items[0].key = true;
    const all = list();
    if (!draft.id) draft.id = uid();
    const i = all.findIndex(p => p.id === draft.id);
    const next = i < 0 ? [...all, draft] : all.map(p => p.id === draft.id ? draft : p);
    next.sort((a, b) => a.name.localeCompare(b.name));
    await store(next);
    draftIsNew = false;
    drawShelf();
    return true;
  }

  drawShelf();
})();
