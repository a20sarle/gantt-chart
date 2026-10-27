// ---- Activity groups (called presets in the code): groups you use again and again ----
// An activity group is a set of activities around one or more key dates (e.g. "Pink
// Sundays": the Event, with "Email a reminder" 3 days before it; and a Sponsor
// deadline, with "Send the sponsor package" 2 days before that). Drag it from the
// sidebar onto the chart and drop it on the (first) key date; with more key dates you
// say when the others are. The group is made with every activity in its place, and the
// group's links go onto its key date task(s). Activity groups are yours (saved with
// your account when you're signed in, see collab.js; otherwise in this browser),
// usable in all your projects.
//
// An activity group: { id, name, color (a PALETTE index or a hex code), links: [{ url }],
//   sections: [{ id, key: { id, name, len, lenUnit }, items: [{ id, name, side
//   ('before' | 'after' the key date), n, unit ('days' | 'weeks' | 'months': how far
//   from the key date it starts), len, lenUnit (how long it lasts), milestone,
//   subtasks (names) }] }], gaps: { <section id>: days after the first key date, as
//   last placed } }
// Every day counts (weekends too); months follow the calendar.
(() => {
  const PRESETS_KEY = 'worknest-presets';
  const shelf = document.getElementById('sidePresets'); // (in the sidebar)
  const dlg = document.getElementById('presetDialog');
  const body = document.getElementById('presetBody');
  const UNITS = ['days', 'weeks', 'months'];
  const unitName = (unit, n) => n === 1 ? unit.slice(0, -1) : unit;

  // ---- Where they're kept: your account (collab.js), or this browser ----
  const api = () => window.collab?.presetsApi?.() || null;
  const storeState = () => api()?.state() || 'ok'; // 'loading' | 'ok' | 'error'
  function list() {
    const a = api();
    let all;
    if (a) all = a.list();
    else { try { all = JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; } catch { all = []; } }
    return all.map(normalize);
  }
  async function store(next) {
    const a = api();
    if (a) return a.save(next);
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch {}
  }
  // Activity groups saved before there were several key dates: one key date (their old
  // key activity), the others before or after it in days
  function normalize(p) {
    if (Array.isArray(p.sections)) return { links: [], gaps: {}, ...p };
    const items = Array.isArray(p.items) ? p.items : [];
    const key = items.find(it => it.key) || items[0] || { id: uid(), name: 'Event', len: 1 };
    return {
      id: p.id, name: p.name, color: p.color, links: [], gaps: {},
      sections: [{
        id: uid(),
        key: { id: key.id, name: key.name, len: Math.max(1, key.len || 1), lenUnit: 'days', subtasks: key.subtasks || [] },
        items: items.filter(it => it !== key).map(it => ({
          id: it.id, name: it.name, side: it.offset < 0 ? 'before' : 'after', n: Math.abs(it.offset || 0), unit: 'days',
          len: Math.max(1, it.len || 1), lenUnit: 'days', milestone: it.milestone || '', subtasks: it.subtasks || [],
        })),
      }],
    };
  }

  const colorOf = p => groupColorOf(p.color) || PALETTE[0];
  // Each key date's own colour: the first in the group's colour, the next ones others
  const sectionColor = (p, i) => i === 0 ? colorOf(p).bg : PALETTE[((typeof p.color === 'number' ? p.color : 0) + 3 * i) % PALETTE.length].bg;
  // (a key date is a ◆ milestone unless it's been switched off; older groups: always one)
  const keyMs = s => s.key.milestone ?? 'start';
  const countOf = p => p.sections.reduce((n, s) => n + 1 + s.items.length, 0);
  const activities = n => n === 1 ? '1 activity' : `${n} activities`;
  const longDay = n => new Date(n * DAY).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  // ---- Dates: n days / weeks / months from a day (a day number) ----
  function addUnits(day, n, unit) {
    if (unit === 'weeks') return day + 7 * n;
    if (unit !== 'months') return day + n;
    const d = new Date(day * DAY), y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // (31 Jan + 1 month: 28/29 Feb)
    return dayNumber(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
  }
  const startOf = (it, keyDay) => addUnits(keyDay, it.side === 'before' ? -it.n : it.n, it.unit);
  const endOf = (start, len, unit) => Math.max(start, addUnits(start, Math.max(1, len), unit) - 1);
  // (for sorting within a key date: roughly how far from it)
  const roughDays = it => (it.side === 'before' ? -1 : 1) * it.n * (it.unit === 'months' ? 30 : it.unit === 'weeks' ? 7 : 1);

  // ---- In the sidebar: one item per activity group (drag it onto the chart; click to edit) ----
  function drawShelf() {
    if (!shelf) return;
    const state = storeState();
    const presets = state === 'ok' ? list() : [];
    shelf.innerHTML = `
      ${state === 'loading' ? '<p class="side-empty">Loading…</p>'
        : state === 'error' ? '<p class="side-empty">Activity groups need the updated database rules (see the README).</p>'
        : !presets.length ? '<p class="side-empty">Groups you use again and again, placed around a key date.</p>'
        : readOnly ? '<p class="side-empty">Click one to edit it. To place one, open one of your own projects.</p>'
        : `<p class="side-empty">${useTurnedMap() ? 'Tap an activity group to add it on a date.' : 'Drag an activity group onto the chart, onto its key date.'}</p>`}
      ${presets.map(p => `<button type="button" class="preset-chip side-proj" data-preset="${esc(p.id)}" style="--dot:${colorOf(p).bg}"
          title="${esc(p.name)}: ${activities(countOf(p))}. Drag onto the chart and drop on the key date (${esc(p.sections[0].key.name)}); click to edit">
          <i aria-hidden="true"></i><span>${esc(p.name)}</span><small>${countOf(p)}</small></button>`).join('')}
      ${state === 'ok' ? '<button type="button" class="preset-new side-link side-new">+ New activity group</button>' : ''}`;
  }
  window.drawPresets = () => { drawShelf(); offerSoon(); }; // (collab.js: your activity groups or the project have loaded)

  // ---- Placing an activity group: each key date on its day (day numbers) ----
  function freeGroup(base) {
    const used = new Set(tasks.map(t => t.group));
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
    return name;
  }
  // Every key date and activity in a group (their ids)
  const allIds = p => p.sections.flatMap(s => [s.key.id, ...s.items.map(it => it.id)]);
  // A task for a key date or an activity, on its day. "from" remembers where it came from
  // (the activity group, this placement of it, which one it is, and everything placed),
  // so changes to the activity group can be brought in later.
  function keyTask(p, s, keyDay, group, from) {
    return { // the key date: a ◆ milestone (unless switched off), with the group's links
      id: uid(), name: s.key.name, group, start: dayString(keyDay), end: dayString(endOf(keyDay, s.key.len, s.key.lenUnit)),
      milestone: keyMs(s), done: false, after: [], links: (p.links || []).map(l => ({ url: l.url })),
      subtasks: (s.key.subtasks || []).map((name, i) => ({ id: uid(), no: i + 1, name, done: false })),
      from: { ...from, i: s.key.id },
    };
  }
  function itemTask(it, keyDay, group, from) {
    const start = startOf(it, keyDay);
    return {
      id: uid(), name: it.name, group, start: dayString(start), end: dayString(endOf(start, it.len, it.lenUnit)),
      milestone: it.milestone || '', done: false, after: [], links: [],
      subtasks: (it.subtasks || []).map((name, i) => ({ id: uid(), no: i + 1, name, done: false })),
      from: { ...from, i: it.id },
    };
  }
  function placePreset(p, keyDays) {
    if (readOnly || !p.sections.length) return;
    const group = freeGroup(p.name);
    const from = { p: p.id, x: uid(), ids: allIds(p) };
    const made = [];
    p.sections.forEach((s, si) => {
      made.push(keyTask(p, s, keyDays[si], group, from));
      for (const it of s.items) made.push(itemTask(it, keyDays[si], group, from));
    });
    tasks.push(...made);
    if (groupColorOf(p.color)) groupColors[group] = p.color;
    save(); render();
    scrollToDay(Math.min(...made.map(t => dayNumber(parse(t.start)))), 80);
  }
  // Remembers how far apart the key dates were (to suggest it next time)
  async function rememberGaps(p, keyDays) {
    if (p.sections.length < 2 || storeState() !== 'ok') return;
    const all = list(), mine = all.find(x => x.id === p.id);
    if (!mine) return;
    mine.gaps = Object.fromEntries(p.sections.slice(1).map((s, i) => [s.id, keyDays[i + 1] - keyDays[0]]));
    await store(all);
  }
  const suggestedDay = (p, si, firstDay) => firstDay + (p.gaps?.[p.sections[si].id] ?? 7 * si);

  // With more than one key date: when are the others? (the first is where you dropped it)
  const ask = document.createElement('dialog');
  ask.className = 'preset-ask';
  document.body.append(ask);
  function askOtherKeyDates(p, firstDay) {
    ask.innerHTML = `<form method="dialog">
        <h2>${esc(p.name)}: when are the other key dates?</h2>
        <div class="pa-row"><span class="pa-key" style="--kc:${sectionColor(p, 0)}">◆ ${esc(p.sections[0].key.name)}</span><span class="pa-fixed">${longDay(firstDay)} <small>(where you dropped it)</small></span></div>
        ${p.sections.slice(1).map((s, i) => `<label class="pa-row"><span class="pa-key" style="--kc:${sectionColor(p, i + 1)}">◆ ${esc(s.key.name)}</span>
          <input type="date" data-s="${i + 1}" value="${dayString(suggestedDay(p, i + 1, firstDay))}"></label>`).join('')}
        <div class="actions reverse"><button value="ok" class="primary">Place</button><button value="cancel">Cancel</button></div>
      </form>`;
    ask.returnValue = '';
    ask.showModal();
    ask.querySelector('input')?.focus();
    ask.addEventListener('close', () => {
      if (ask.returnValue !== 'ok') return;
      const days = [firstDay, ...[...ask.querySelectorAll('input[type=date]')].map(inp => inp.value ? dayNumber(parse(inp.value)) : null)];
      if (days.some(d => d === null)) return;
      placePreset(p, days);
      rememberGaps(p, days);
    }, { once: true });
  }
  function placeFromDrop(p, firstDay) {
    if (p.sections.length > 1) return askOtherKeyDates(p, firstDay);
    placePreset(p, [firstDay]);
  }

  // ---- Bringing changes to an activity group into the projects that use it ----
  // When an activity group you've placed gets activities or key dates added or removed,
  // the project asks (on saving the group, and on opening the project) whether to bring
  // in just those: new ones are added around their key date, removed ones are taken out.
  // Everything else in the placed group (dates you moved, subtasks, links, comments) stays.
  const DECLINED_KEY = 'worknest-preset-declined';
  const declined = () => { try { return JSON.parse(localStorage.getItem(DECLINED_KEY)) || []; } catch { return []; } };
  const changeKey = (x, ids) => `${x}|${ids.join(',')}`;
  function changesFor(p, x) {
    const placed = tasks.filter(t => t.from?.x === x);
    if (!placed.length) return null;
    const had = new Set(placed[0].from.ids || []), now = allIds(p);
    const group = placed[0].group;
    const from = { p: p.id, x, ids: now };
    const dayOf = id => { const t = placed.find(t => t.from.i === id); return t ? dayNumber(parse(t.start)) : null; };
    const firstDay = dayOf(p.sections[0].key.id);
    const added = [];
    p.sections.forEach((s, si) => {
      let keyDay = dayOf(s.key.id);
      if (!had.has(s.key.id)) { // a new key date: as far from the first as last time
        if (firstDay === null) return;
        keyDay = suggestedDay(p, si, firstDay);
        added.push(keyTask(p, s, keyDay, group, from));
      }
      if (keyDay === null) return; // (its key date was deleted from the project)
      for (const it of s.items) if (!had.has(it.id)) added.push(itemTask(it, keyDay, group, from));
    });
    const removed = placed.filter(t => !now.includes(t.from.i));
    return { group, now, added, removed };
  }
  const update = document.createElement('dialog');
  update.className = 'preset-ask preset-update';
  document.body.append(update);
  let asking = false;
  async function offerUpdates(onlyFor) {
    if (readOnly || asking || storeState() !== 'ok') return;
    const presets = list();
    const xs = [...new Set(tasks.filter(t => t.from?.x && (!onlyFor || t.from.p === onlyFor)).map(t => t.from.x))];
    for (const x of xs) {
      const p = presets.find(q => q.id === tasks.find(t => t.from?.x === x).from.p);
      if (!p) continue; // (the activity group was deleted: its places stay as they are)
      const ch = changesFor(p, x);
      if (!ch || (!ch.added.length && !ch.removed.length) || declined().includes(changeKey(x, ch.now))) continue;
      asking = true;
      const yes = await askUpdate(p, ch);
      asking = false;
      if (yes) applyUpdate(x, ch);
      else {
        const d = declined().filter(k => !k.startsWith(`${x}|`));
        try { localStorage.setItem(DECLINED_KEY, JSON.stringify([...d, changeKey(x, ch.now)].slice(-200))); } catch {}
      }
    }
  }
  function askUpdate(p, ch) {
    const day = t => longDay(dayNumber(parse(t.start)));
    update.innerHTML = `<form method="dialog">
        <h2>${esc(p.name)} has changed</h2>
        <p>Update <b>${esc(ch.group || p.name)}</b> in this project? Only these changes are made: everything else in it stays as it is.</p>
        <ul class="pu-list">
          ${ch.added.map(t => `<li class="pu-add"><b>+</b> ${t.milestone ? '◆ ' : ''}${esc(t.name)} <small>${day(t)}</small></li>`).join('')}
          ${ch.removed.map(t => `<li class="pu-del"><b>−</b> ${esc(t.name)} <small>removed from the activity group</small></li>`).join('')}
        </ul>
        <div class="actions reverse"><button value="ok" class="primary">Update</button><button value="no">Keep as it is</button></div>
      </form>`;
    update.returnValue = '';
    update.showModal();
    return new Promise(res => update.addEventListener('close', () => res(update.returnValue === 'ok'), { once: true }));
  }
  function applyUpdate(x, ch) {
    const gone = new Set(ch.removed.map(t => t.id));
    tasks = tasks.filter(t => !gone.has(t.id));
    tasks.forEach(t => {
      if (t.after) t.after = t.after.filter(a => !gone.has(a)); // (links to removed ones)
      if (t.from?.x === x) t.from = { ...t.from, ids: ch.now };
    });
    tasks.push(...ch.added);
    save(); render();
  }
  // (on opening a project, once its tasks and your activity groups are both there)
  let offerTimer = null;
  const offerSoon = () => { clearTimeout(offerTimer); offerTimer = setTimeout(() => offerUpdates(), 300); };

  // ---- Dragging an activity group onto the chart ----
  let press = null; // { preset, x, y, chip, dragging, day }
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
    const s = p.sections[0], day = Math.floor(pointerDay(x)); // (the first key date is under the pointer)
    press.day = day;
    const r = chartEl.getBoundingClientRect(), rowH = 24;
    const bars = [{ name: s.key.name, start: day, end: endOf(day, s.key.len, s.key.lenUnit), key: true, ms: keyMs(s) },
      ...s.items.map(it => { const st = startOf(it, day); return { name: it.name, start: st, end: endOf(st, it.len, it.lenUnit), ms: it.milestone }; })]
      .sort((a, b) => a.start - b.start);
    ghost.innerHTML = `
      <div class="pg-line" style="left:${dayX(day) + renderedDayW / 2 - 1}px;top:${r.top}px;height:${r.height}px"></div>
      <div class="pg-label" style="left:${dayX(day) + renderedDayW / 2 + 6}px;top:${Math.max(r.top + 4, y - 34)}px">${esc(s.key.name)} · ${longDay(day)}${p.sections.length > 1 ? ' <small>(the other key dates: after you drop it)</small>' : ''}</div>
      ${bars.map((b, i) => `<div class="pg-bar${b.key ? ' key' : ''}" style="left:${dayX(b.start) + 1}px;width:${(b.end - b.start + 1) * renderedDayW - 2}px;top:${y + 8 + i * rowH}px">${b.ms ? '◆ ' : ''}${esc(b.name)}</div>`).join('')}`;
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
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5 || useTurnedMap() || readOnly) return; // (not onto a project you can only view)
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
    if (drop && day !== null) placeFromDrop(preset, day);
  }
  shelf.addEventListener('pointerup', () => endPress(true));
  shelf.addEventListener('pointercancel', () => endPress(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && press?.dragging) { press.day = null; endPress(false); } });
  shelf.addEventListener('click', e => { if (e.target.closest('.preset-new')) openEditor(null); });

  // ---- "Save as an activity group" on a group in the task list ----
  chartEl.addEventListener('click', e => {
    const btn = e.target.closest('.preset-save');
    if (!btn || readOnly) return;
    e.stopPropagation();
    const g = btn.dataset.presetGroup;
    const all = tasks.filter(t => (t.group || '') === g).sort((a, b) => a.start.localeCompare(b.start));
    if (!all.length) return;
    const key = all.find(t => t.milestone) || all[0];
    const keyDay = dayNumber(parse(key.start));
    openEditor({
      id: null, name: g || 'New activity group', color: groupColors[g] ?? 0, links: [], gaps: {},
      sections: [{
        id: uid(),
        key: { id: key.id, name: key.name, len: daysBetween(parse(key.start), parse(key.end)) + 1, lenUnit: 'days', milestone: key.milestone || '', subtasks: (key.subtasks || []).map(s => s.name) },
        items: all.filter(t => t !== key).map(t => {
          const off = dayNumber(parse(t.start)) - keyDay;
          return { id: t.id, name: t.name, side: off < 0 ? 'before' : 'after', n: Math.abs(off), unit: 'days',
            len: daysBetween(parse(t.start), parse(t.end)) + 1, lenUnit: 'days', milestone: t.milestone || '', subtasks: (t.subtasks || []).map(s => s.name) };
        }),
      }],
    }, { fromGroup: true });
  }, true);

  // ---- The editor ----
  let draft = null, draftIsNew = false, addingLink = false, placeOpen = false;
  const newSection = name => ({ id: uid(), key: { id: uid(), name, len: 1, lenUnit: 'days', subtasks: [] }, items: [] });
  function openEditor(p, { fromGroup = false } = {}) {
    draftIsNew = !p || !p.id;
    draft = p ? JSON.parse(JSON.stringify(normalize(p))) : {
      id: null, name: '', color: Math.floor(Math.random() * PALETTE.length), links: [], gaps: {}, sections: [newSection('Event')],
    };
    addingLink = false; placeOpen = false;
    dlg.dataset.fromGroup = fromGroup ? '1' : '';
    drawEditor();
    dlg.showModal();
    const name = body.querySelector('.pe-title');
    if (!draft.name || fromGroup) { name.focus(); name.select(); } else body.focus();
  }

  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // A milestone at the start (◆ before "Lasts") or at the end (◆ after it); one at a time
  const msButton = (where, ms, cls = '') => {
    const on = ms === where, at = where === 'start' ? 'start' : 'end';
    return `<button type="button" class="pe-ms pe-ms-${at}${cls}${on ? ' on' : ''}" data-ms="${where}" title="${on ? `A milestone (◆) at the ${at}. Click to remove it` : `Put a milestone (◆) at the ${at}`}" aria-pressed="${on}">◆</button>`;
  };
  const unitSelect = (cls, unit, n, label) => `<select class="${cls}" aria-label="${label}">${UNITS.map(u => `<option value="${u}"${u === unit ? ' selected' : ''}>${unitName(u, n)}</option>`).join('')}</select>`;
  const duration = (cls, len, unit) => `<span class="pe-dur" title="How long it lasts">⏱ Lasts <input type="number" class="${cls}" min="1" max="999" value="${Math.max(1, len)}" aria-label="Lasts">${unitSelect(cls + '-unit', unit, Math.max(1, len), 'Lasts: days, weeks or months')}</span>`;

  function drawEditor(focusSel) {
    const c = colorOf(draft);
    body.style.setProperty('--c', c.bg);
    const many = draft.sections.length > 1;
    body.innerHTML = `
      <div class="pe-head">
        <button type="button" class="pe-dot" title="Change the group's colour" aria-label="Change the group's colour" aria-haspopup="dialog"></button>
        <input class="pe-title" value="${esc(draft.name)}" placeholder="Name, e.g. Pink event" aria-label="Activity group name" autocomplete="off">
        ${draftIsNew ? '' : `<button type="button" class="sheet-icon pe-delete" title="Delete activity group" aria-label="Delete activity group">${TRASH_ICON}</button>`}
        <button type="button" class="sheet-icon pe-close" title="Close" aria-label="Close">✕</button>
      </div>
      ${dlg.dataset.fromGroup ? '<p class="pe-note">Made from the group: check its key date and the activities around it, then save.</p>' : ''}
      <div class="pe-links"><span class="pe-links-label">${CLIP_ICON} Links</span>
        ${draft.links.map((l, i) => `<span class="pe-link"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l.url))}</a><button type="button" class="pe-link-del" data-l="${i}" title="Remove link" aria-label="Remove link">✕</button></span>`).join('')}
        ${addingLink ? `<form class="pe-link-form"><input type="text" inputmode="url" autocomplete="off" placeholder="Paste a link (Google Doc, website…)"><button class="primary">Add</button></form>`
          : '<button type="button" class="pe-link-add">+ Add link</button>'}
      </div>
      <div class="error pe-link-error"></div>
      <div class="pe-row pe-colhead" aria-hidden="true"><span></span><span>Activity</span><span>Starts</span><span>Duration</span><span></span><span></span></div>
      ${draft.sections.map((s, si) => {
        const kc = sectionColor(draft, si);
        const before = s.items.filter(it => it.side === 'before').sort((a, b) => roughDays(a) - roughDays(b));
        const after = s.items.filter(it => it.side !== 'before').sort((a, b) => roughDays(a) - roughDays(b));
        const row = it => {
          const ii = s.items.indexOf(it);
          return `<div class="pe-row" data-s="${si}" data-i="${ii}">
            <span class="pe-grip" title="Drag above the key date (before) or below it (after)" aria-hidden="true">⋮⋮</span>
            <input class="pe-name" value="${esc(it.name)}" aria-label="Activity name" autocomplete="off">
            <span class="pe-when"><input type="number" class="pe-n" min="0" max="999" value="${it.n}" aria-label="How far from the key date">${unitSelect('pe-unit', it.unit, it.n, 'Days, weeks or months')}<b class="pe-side">${it.side === 'before' ? 'before' : 'after'}</b></span>
            <span class="pe-durcell">${msButton('start', it.milestone)}${duration('pe-len', it.len, it.lenUnit)}</span>
            ${msButton('end', it.milestone)}
            <button type="button" class="pe-del" title="Remove this activity" aria-label="Remove">✕</button>
          </div>`;
        };
        return `<div class="pe-sec" data-s="${si}" style="--kc:${kc}">
          ${many ? `<div class="pe-sec-head">Part ${si + 1}</div>` : ''}
          ${before.map(row).join('')}
          <div class="pe-row pe-keyrow" data-s="${si}" data-key>
            <span class="pe-grip pe-grip-key" aria-hidden="true"></span>
            <input class="pe-kname" value="${esc(s.key.name)}" aria-label="Key date name" autocomplete="off">
            <span class="pe-when"><span class="pe-keytag">◆ Key date</span></span>
            <span class="pe-durcell">${msButton('start', keyMs(s), ' pe-kms')}${duration('pe-klen', s.key.len, s.key.lenUnit)}</span>
            ${msButton('end', keyMs(s), ' pe-kms')}
            <button type="button" class="pe-kdel" title="${many ? 'Remove this key date and its activities' : 'An activity group needs a key date'}" aria-label="Remove key date" ${many ? '' : 'disabled'}>✕</button>
          </div>
          ${after.map(row).join('')}
          <button type="button" class="sheet-adder pe-add" data-s="${si}">+ Add activity</button>
        </div>`;
      }).join('')}
      <button type="button" class="pe-add-key">Add key date</button>
      <div class="error pe-error"></div>
      <div class="actions pe-actions">
        <button type="button" class="pe-cancel">Cancel</button>
        <button type="button" class="primary pe-save">Save activity group</button>
      </div>
      <div class="pe-place-wrap${placeOpen ? ' open' : ''}"${readOnly ? ' hidden' : ''}>
        <button type="button" class="pe-place-toggle" aria-expanded="${placeOpen}"><span class="pe-chev" aria-hidden="true">▸</span> Add activity group to project</button>
        <div class="pe-place"${placeOpen ? '' : ' hidden'}>
          <span class="pe-place-label">Use the following key date${many ? 's' : ''}</span>
          <div class="pe-place-row">
            ${draft.sections.map((s, si) => `<label class="pe-place-key"><span class="pa-key" style="--kc:${sectionColor(draft, si)}">◆ ${esc(s.key.name)}</span>
              <input type="date" class="pe-date" data-s="${si}" value="${dayString(si === 0 ? dayNumber(parse(todayString())) : suggestedDay(draft, si, dayNumber(parse(todayString()))))}"></label>`).join('')}
            <button type="button" class="primary pe-place-btn">Add to project</button>
          </div>
        </div>
      </div>`;
    if (focusSel) body.querySelector(focusSel)?.focus();
  }

  const secOf = el => draft.sections[+el.closest('[data-s]').dataset.s];
  const itemOf = el => { const r = el.closest('.pe-row'); return draft.sections[+r.dataset.s].items[+r.dataset.i]; };
  body.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('.pe-title')) draft.name = el.value;
    else if (el.matches('.pe-name')) itemOf(el).name = el.value;
    else if (el.matches('.pe-kname')) secOf(el).key.name = el.value;
  });
  body.addEventListener('change', e => {
    const el = e.target, num = (v, min) => Math.max(min, Math.round(+v || min));
    if (el.matches('.pe-n')) { itemOf(el).n = num(el.value, 0); return drawEditor(); }
    if (el.matches('.pe-unit')) { itemOf(el).unit = el.value; return drawEditor(); }
    if (el.matches('.pe-len')) { itemOf(el).len = num(el.value, 1); return drawEditor(); }
    if (el.matches('.pe-len-unit')) { itemOf(el).lenUnit = el.value; return drawEditor(); }
    if (el.matches('.pe-klen')) { secOf(el).key.len = num(el.value, 1); return drawEditor(); }
    if (el.matches('.pe-klen-unit')) { secOf(el).key.lenUnit = el.value; return drawEditor(); }
  });
  body.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.closest('.pe-link-form');
    if (!f) return;
    const url = normalizeUrl(f.querySelector('input').value);
    if (!url) { body.querySelector('.pe-link-error').textContent = 'That doesn\'t look like a web link.'; return; }
    draft.links.push({ url });
    addingLink = false;
    drawEditor('.pe-link-add');
  });
  body.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('.pe-close, .pe-cancel')) return dlg.close();
    const dot = t.closest('.pe-dot');
    if (dot) return colorPop.hidden ? openColorPop(dot) : closeColorPop();
    if (t.closest('.pe-place-toggle')) {
      placeOpen = !placeOpen;
      drawEditor('.pe-place-toggle');
      if (placeOpen) body.querySelector('.pe-place-wrap').scrollIntoView({ block: 'nearest' });
      return;
    }
    if (t.closest('.pe-link-add')) { addingLink = true; drawEditor('.pe-link-form input'); return; }
    const ld = t.closest('.pe-link-del');
    if (ld) { draft.links.splice(+ld.dataset.l, 1); return drawEditor(); }
    const ms = t.closest('.pe-ms[data-ms]');
    if (ms) {
      const where = ms.dataset.ms;
      if (ms.matches('.pe-kms')) { const s = secOf(t); s.key.milestone = keyMs(s) === where ? '' : where; }
      else { const it = itemOf(t); it.milestone = it.milestone === where ? '' : where; }
      return drawEditor();
    }
    if (t.closest('.pe-del')) { const s = secOf(t), it = itemOf(t); s.items = s.items.filter(x => x !== it); return drawEditor(); }
    if (t.closest('.pe-kdel:not([disabled])')) {
      const s = secOf(t);
      if (s.items.length && !(await askConfirm('Remove key date?', `<b>${esc(s.key.name)}</b> and its ${activities(s.items.length)} will be removed from this activity group.`, 'Remove'))) return;
      draft.sections = draft.sections.filter(x => x !== s);
      return drawEditor();
    }
    const add = t.closest('.pe-add');
    if (add) {
      const s = draft.sections[+add.dataset.s];
      s.items.push({ id: uid(), name: 'New activity', side: 'before', n: 1, unit: 'days', len: 1, lenUnit: 'days', milestone: '', subtasks: [] });
      drawEditor();
      body.querySelector(`.pe-row[data-s="${add.dataset.s}"][data-i="${s.items.length - 1}"] .pe-name`)?.select();
      return;
    }
    if (t.closest('.pe-add-key')) {
      draft.sections.push(newSection(`Key date ${draft.sections.length + 1}`));
      drawEditor();
      body.querySelector(`.pe-keyrow[data-s="${draft.sections.length - 1}"] .pe-kname`)?.select();
      return;
    }
    if (t.closest('.pe-save')) {
      const id = draft.id;
      if (await saveDraft()) { dlg.close(); if (id) offerUpdates(id); }
      return;
    }
    if (t.closest('.pe-place-btn')) {
      const days = [...body.querySelectorAll('.pe-date')].map(inp => inp.value ? dayNumber(parse(inp.value)) : null);
      if (days.some(d => d === null)) return showError(`Choose the key date${days.length > 1 ? 's' : ''} first.`);
      if (!(await saveDraft())) return;
      const p = draft;
      dlg.close();
      placePreset(p, days);
      rememberGaps(p, days);
      return;
    }
    if (t.closest('.pe-delete')) {
      if (!(await askConfirm('Delete activity group?', `<b>${esc(draft.name)}</b> will be removed from your activity groups. Groups already made from it stay as they are.`, 'Delete'))) return;
      await store(list().filter(p => p.id !== draft.id));
      dlg.close(); drawShelf();
    }
  });

  // Dragging a row by ⋮⋮: above a key date = before it, below = after it (into another
  // key date's section too)
  let rowDrag = null;
  body.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.pe-grip:not(.pe-grip-key)');
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const row = grip.closest('.pe-row');
    rowDrag = { row, item: itemOf(row), from: secOf(row) };
    row.classList.add('dragging');
    document.documentElement.classList.add('pe-dragging');
    try { grip.setPointerCapture(e.pointerId); } catch {}
  });
  body.addEventListener('pointermove', e => {
    if (!rowDrag) return;
    // (the key date's section under the pointer, then the place among its rows)
    const secs = [...body.querySelectorAll('.pe-sec')];
    const sec = secs.find(x => e.clientY < x.getBoundingClientRect().bottom) || secs.at(-1);
    const rows = [...sec.querySelectorAll('.pe-row')].filter(r => r !== rowDrag.row);
    const target = rows.find(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (target) target.before(rowDrag.row);
    else rows.at(-1)?.after(rowDrag.row);
    // (the word follows where it is)
    const key = sec.querySelector('.pe-keyrow');
    rowDrag.row.querySelector('.pe-side').textContent = key.compareDocumentPosition(rowDrag.row) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
  });
  function endRowDrag() {
    if (!rowDrag) return;
    const { row, item, from } = rowDrag;
    rowDrag = null;
    document.documentElement.classList.remove('pe-dragging');
    const sec = row.closest('.pe-sec');
    const to = draft.sections[+sec.dataset.s], key = sec.querySelector('.pe-keyrow');
    item.side = key.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
    if (to !== from) { from.items = from.items.filter(x => x !== item); to.items.push(item); }
    drawEditor();
  }
  body.addEventListener('pointerup', endRowDrag);
  body.addEventListener('pointercancel', endRowDrag);

  const colorPop = document.createElement('div');
  colorPop.className = 'menu color-pop pe-color-pop';
  colorPop.setAttribute('role', 'dialog');
  colorPop.setAttribute('aria-label', "The activity group's colour");
  colorPop.hidden = true;
  colorPop.innerHTML = `<p class="color-pop-head">Activity group colour</p>
    <div class="color-swatches">${PALETTE.map((c, i) => `<button type="button" data-pcolor="${i}" style="--c:${c.bg}" aria-label="${c.bg}" title="${c.bg}"></button>`).join('')}</div>
    <div class="color-custom">
      <input type="color" class="pc-native" title="Pick any colour" aria-label="Pick any colour">
      <input class="pc-hex" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#4f8ff7" aria-label="Colour as a hex code" title="A hex code, like #4f8ff7">
    </div>
    <div class="error pc-error"></div>`;
  dlg.append(colorPop);
  const pcNative = colorPop.querySelector('.pc-native'), pcHex = colorPop.querySelector('.pc-hex'), pcErr = colorPop.querySelector('.pc-error');
  function drawColorPop() {
    const v = draft.color, bg = colorOf(draft).bg.toLowerCase();
    for (const b of colorPop.querySelectorAll('[data-pcolor]')) b.classList.toggle('on', String(v) === b.dataset.pcolor);
    pcNative.value = bg;
    if (document.activeElement !== pcHex) pcHex.value = typeof v === 'string' && v.startsWith('#') ? v : bg;
  }
  function openColorPop(dot) {
    pcErr.textContent = '';
    colorPop.hidden = false;
    drawColorPop();
    // (placed under the dot, inside the dialog)
    const r = dot.getBoundingClientRect(), d = dlg.getBoundingClientRect();
    colorPop.style.left = `${Math.max(8, r.left - d.left - 8)}px`;
    colorPop.style.top = `${r.bottom - d.top + 8}px`;
    dot.setAttribute('aria-expanded', 'true');
    (colorPop.querySelector('.on') || pcHex).focus();
  }
  function closeColorPop() {
    colorPop.hidden = true;
    body.querySelector('.pe-dot')?.setAttribute('aria-expanded', 'false');
  }
  function setDraftColor(v) {
    if (draft.color === v) return;
    draft.color = v;
    // (only the colours change: the rest of the editor keeps what's being typed)
    body.style.setProperty('--c', colorOf(draft).bg);
    body.querySelectorAll('.pe-sec').forEach((s, i) => s.style.setProperty('--kc', sectionColor(draft, i)));
    body.querySelectorAll('.pe-place-key .pa-key').forEach((k, i) => k.style.setProperty('--kc', sectionColor(draft, i)));
    drawColorPop();
  }
  colorPop.addEventListener('click', e => {
    const sw = e.target.closest('[data-pcolor]');
    if (sw) { setDraftColor(+sw.dataset.pcolor); closeColorPop(); body.querySelector('.pe-dot')?.focus(); }
  });
  pcNative.addEventListener('input', () => { setDraftColor(pcNative.value.toLowerCase()); pcHex.value = pcNative.value.toLowerCase(); });
  pcHex.addEventListener('input', () => {
    const ok = HEX.test(pcHex.value.trim());
    pcErr.textContent = ok || pcHex.value.trim().length < 4 ? '' : 'Use a hex code like #4f8ff7';
    if (ok) setDraftColor(normHex(pcHex.value));
  });
  pcHex.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (HEX.test(pcHex.value.trim())) closeColorPop(); } });
  dlg.addEventListener('pointerdown', e => { if (!colorPop.hidden && !e.target.closest('.pe-color-pop, .pe-dot')) closeColorPop(); });
  // (Escape closes the picker first, then the editor)
  dlg.addEventListener('cancel', e => { if (!colorPop.hidden) { e.preventDefault(); closeColorPop(); } });
  dlg.addEventListener('close', closeColorPop);
  body.addEventListener('scroll', closeColorPop, { passive: true });

  const showError = msg => { body.querySelector('.pe-error').textContent = msg; };
  async function saveDraft() {
    draft.name = draft.name.trim();
    if (!draft.name) { showError('Give the activity group a name.'); body.querySelector('.pe-title').focus(); return false; }
    if (storeState() !== 'ok') { showError('Your activity groups haven\'t loaded yet. Try again in a moment.'); return false; }
    draft.sections.forEach((s, i) => {
      s.key.name = s.key.name.trim() || `Key date ${i + 1}`;
      s.items.forEach(it => { it.name = it.name.trim() || 'Activity'; });
    });
    delete draft.items; // (the old way of storing them)
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
  offerSoon(); // (a project on this computer: its tasks are already there)
})();
