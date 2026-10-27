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
//   from the key date it starts), len, lenUnit (how long it lasts), milestone, notes,
//   subtasks: [{ id, name }] }] }], gaps: { <section id>: days after the first key date, as
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
    if (Array.isArray(p.sections)) {
      const subs = x => ({ ...x, subtasks: (x.subtasks || []).map((s, n) => typeof s === 'string' ? { id: `${x.id}~${n}`, name: s } : s) });
      return { links: [], gaps: {}, ...p, sections: p.sections.map(s => ({ ...s, key: subs(s.key), items: s.items.map(subs) })) };
    }
    const items = Array.isArray(p.items) ? p.items : [];
    const key = items.find(it => it.key) || items[0] || { id: uid(), name: 'Event', len: 1 };
    return normalize({
      id: p.id, name: p.name, color: p.color, links: [], gaps: {},
      sections: [{
        id: uid(),
        key: { id: key.id, name: key.name, len: Math.max(1, key.len || 1), lenUnit: 'days', subtasks: key.subtasks || [] },
        items: items.filter(it => it !== key).map(it => ({
          id: it.id, name: it.name, side: it.offset < 0 ? 'before' : 'after', n: Math.abs(it.offset || 0), unit: 'days',
          len: Math.max(1, it.len || 1), lenUnit: 'days', milestone: it.milestone || '', subtasks: it.subtasks || [],
        })),
      }],
    });
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
  // A short fingerprint of a value (to tell later whether it's still what the group gave)
  const fpOf = v => { const s = JSON.stringify(v ?? ''); let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); };
  const lenOf = t => daysBetween(parse(t.start), parse(t.end)) + 1;
  // What a task got from its group, as fingerprints, field by field ("start": how many days
  // from its key date, so moving the whole group doesn't count as a change)
  const givenOf = (t, keyDay) => ({
    name: fpOf(t.name), start: fpOf(dayNumber(parse(t.start)) - keyDay), len: fpOf(lenOf(t)), ms: fpOf(t.milestone || ''),
    notes: fpOf(t.notes || ''), links: (t.links || []).map(l => fpOf(l.url)),
  });
  const placedSubs = list => (list || []).map((s, i) => ({ id: uid(), no: i + 1, name: s.name, done: false, from: s.id, fp: fpOf(s.name) }));
  // A task for a key date or an activity, on its day. "from" remembers where it came from
  // (the activity group, this placement of it, which one it is, its key date, everything
  // placed, and what it got), so changes to the activity group can be brought in later
  // without touching what's been changed or added in the project.
  function keyTask(p, s, keyDay, group, from) {
    const t = { // the key date: a ◆ milestone (unless switched off), with the group's links
      id: uid(), name: s.key.name, group, start: dayString(keyDay), end: dayString(endOf(keyDay, s.key.len, s.key.lenUnit)),
      milestone: keyMs(s), done: false, after: [], links: (p.links || []).map(l => ({ url: l.url })),
      subtasks: placedSubs(s.key.subtasks), notes: s.key.notes || '',
    };
    t.from = { ...from, i: s.key.id, k: s.key.id, fp: givenOf(t, keyDay), subs: (s.key.subtasks || []).map(x => x.id) };
    return t;
  }
  function itemTask(it, keyDay, group, from, keyId) {
    const start = startOf(it, keyDay);
    const t = {
      id: uid(), name: it.name, group, start: dayString(start), end: dayString(endOf(start, it.len, it.lenUnit)),
      milestone: it.milestone || '', done: false, after: [], links: [],
      subtasks: placedSubs(it.subtasks), notes: it.notes || '',
    };
    t.from = { ...from, i: it.id, k: keyId, fp: givenOf(t, keyDay), subs: (it.subtasks || []).map(x => x.id) };
    return t;
  }
  function placePreset(p, keyDays) {
    if (readOnly || !p.sections.length) return;
    const group = freeGroup(p.name);
    const from = { p: p.id, x: uid(), ids: allIds(p) };
    const made = [];
    p.sections.forEach((s, si) => {
      made.push(keyTask(p, s, keyDays[si], group, from));
      for (const it of s.items) made.push(itemTask(it, keyDays[si], group, from, s.key.id));
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
  // When an activity group you've placed changes, the project asks (on saving the group,
  // and on opening the project) whether to bring the changes in. Field by field, a task
  // only gets the group's new value when it still has what the group gave it (its
  // fingerprint matches): whatever's been changed in the project stays ("kept yours").
  // New activities / key dates / subtasks / links are added; removed ones are taken out,
  // except tasks with work on them (done, a subtask done, comments), and subtasks that are
  // done or have links.
  // What's been added in the project (tasks, subtasks, links, comments) is never touched.
  const DECLINED_KEY = 'worknest-preset-declined';
  const declined = () => { try { return JSON.parse(localStorage.getItem(DECLINED_KEY)) || []; } catch { return []; } };
  const changeKey = (x, p) => `${x}|${fpOf([p.sections, p.links])}`;
  const shortDay = n => new Date(n * DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const msWord = m => m === 'start' ? 'a milestone at the start' : m === 'end' ? 'a milestone at the end' : 'no milestone';

  // One task: field by field (t is changed in place: it's a copy until you click Update)
  function syncTask(t, e, keyDay, isKey) {
    const fp = t.from.fp || {}; // (placed before fingerprints: unknown, so only what still matches is "the group's")
    const known = !!t.from.fp;
    const done = [], kept = [];
    const field = (name, cur, want, apply, label, keptLabel) => {
      const g = fpOf(want);
      const was = known ? fp[name] : fpOf(cur) === g ? g : null;
      if (was === g) return;                  // (the group didn't change it)
      if (was != null && fpOf(cur) === was) { apply(); done.push(label); }
      else if (known && fpOf(cur) !== g) kept.push(keptLabel);
      fp[name] = g;
    };
    field('name', t.name, e.name, () => { t.name = e.name; }, `renamed “${esc(e.name)}”`, 'its name');
    if (!isKey) {
      const want = dayNumber(parse(e.start)) - keyDay;
      field('start', dayNumber(parse(t.start)) - keyDay, want, () => {
        const len = lenOf(t), s = keyDay + want;
        t.start = dayString(s); t.end = dayString(s + len - 1);
      }, `starts ${shortDay(keyDay + want)}`, 'its dates');
    }
    field('len', lenOf(t), lenOf(e), () => { t.end = dayString(dayNumber(parse(t.start)) + lenOf(e) - 1); },
      `lasts ${lenOf(e)} day${lenOf(e) > 1 ? 's' : ''}`, 'how long it lasts');
    field('ms', t.milestone || '', e.milestone || '', () => { t.milestone = e.milestone || ''; }, msWord(e.milestone), 'its milestone');
    field('notes', t.notes || '', e.notes || '', () => { t.notes = e.notes || ''; }, 'new notes', 'its notes');
    if (isKey) { // the group's links: new ones added, removed ones taken out (links added in the project stay)
      const had = new Set(known ? fp.links || [] : (t.links || []).map(l => fpOf(l.url)));
      const now = (e.links || []).map(l => fpOf(l.url));
      const add = e.links.filter(l => !had.has(fpOf(l.url)) && !(t.links || []).some(x => x.url === l.url));
      const gone = new Set(known ? [...had].filter(f => !now.includes(f)) : []); // (placed before: which links were the group's isn't known)
      const before = (t.links || []).length;
      t.links = [...(t.links || []).filter(l => !gone.has(fpOf(l.url))), ...add.map(l => ({ url: l.url }))];
      if (add.length) done.push(add.length === 1 ? 'a link added' : `${add.length} links added`);
      const removed = before + add.length - t.links.length;
      if (removed) done.push(removed === 1 ? 'a link removed' : `${removed} links removed`);
      fp.links = now;
    }
    // Subtasks, one by one
    t.subtasks ||= [];
    const given = new Set(t.from.subs || []);
    let added = 0, removed = 0, renamed = 0, keptSubs = 0;
    for (const es of e.subtasks) {
      let ps = t.subtasks.find(s => s.from === es.from);
      if (!ps && !t.from.subs) ps = t.subtasks.find(s => !s.from && s.name === es.name); // (placed before: by name)
      if (ps && !ps.from) { ps.from = es.from; ps.fp = fpOf(ps.name); }
      if (ps) {
        const g = fpOf(es.name);
        if (ps.fp !== g) {
          if (fpOf(ps.name) === ps.fp) { ps.name = es.name; renamed++; } else keptSubs++;
          ps.fp = g;
        }
      } else if (!given.has(es.from) && t.from.subs) { // (new in the group; one deleted in the project stays deleted)
        t.subtasks.push({ ...es, id: uid(), no: Math.max(0, ...t.subtasks.map(s => s.no || 0)) + 1 });
        added++;
      }
    }
    const nowSubs = new Set(e.subtasks.map(s => s.from));
    t.subtasks = t.subtasks.filter(s => {
      if (!s.from || nowSubs.has(s.from)) return true;
      if (s.done || (s.links || []).length) { delete s.from; delete s.fp; keptSubs++; return true; } // (work on it: stays, as the project's own)
      removed++; return false;
    });
    if (added) done.push(added === 1 ? 'a subtask added' : `${added} subtasks added`);
    if (renamed) done.push(renamed === 1 ? 'a subtask renamed' : `${renamed} subtasks renamed`);
    if (removed) done.push(removed === 1 ? 'a subtask removed' : `${removed} subtasks removed`);
    if (keptSubs) kept.push(keptSubs === 1 ? 'a subtask' : `${keptSubs} subtasks`);
    t.from.fp = fp;
    t.from.subs = e.subtasks.map(s => s.from);
    return { done, kept };
  }

  // One placement of the group in a project's tasks (a list; tasks = the open project's).
  // comments(task id): how many comments it has.
  function changesFor(p, x, list = tasks, comments = id => window.collab?.count?.(id) || 0) {
    const next = JSON.parse(JSON.stringify(list)); // (a copy: nothing changes until Update)
    const placed = next.filter(t => t.from?.x === x);
    if (!placed.length) return null;
    const had = new Set(placed[0].from.ids || []), now = allIds(p);
    const group = placed[0].group;
    const base = { p: p.id, x, ids: now };
    const lines = []; // { kind: 'add' | 'del' | 'edit' | 'kept', name, text }
    const dayOf = id => { const t = placed.find(t => t.from.i === id); return t ? dayNumber(parse(t.start)) : null; };
    const firstDay = dayOf(p.sections[0].key.id);
    p.sections.forEach((s, si) => {
      let keyDay = dayOf(s.key.id);
      if (!had.has(s.key.id)) { // a new key date: as far from the first as last time
        if (firstDay === null) return;
        keyDay = suggestedDay(p, si, firstDay);
        const t = keyTask(p, s, keyDay, group, base);
        next.push(t); lines.push({ kind: 'add', name: t.name, text: longDay(keyDay), ms: t.milestone });
      } else if (keyDay !== null) {
        const kt = placed.find(t => t.from.i === s.key.id);
        const r = syncTask(kt, keyTask(p, s, keyDay, group, base), keyDay, true);
        if (r.done.length) lines.push({ kind: 'edit', name: kt.name, text: r.done.join(', ') });
        if (r.kept.length) lines.push({ kind: 'kept', name: kt.name, text: `kept your change to ${r.kept.join(', ')}` });
      }
      if (keyDay === null) return; // (its key date was deleted from the project)
      for (const it of s.items) {
        const e = itemTask(it, keyDay, group, base, s.key.id);
        if (!had.has(it.id)) { next.push(e); lines.push({ kind: 'add', name: e.name, text: longDay(dayNumber(parse(e.start))), ms: e.milestone }); continue; }
        const t = placed.find(t => t.from.i === it.id);
        if (!t) continue; // (deleted in the project: stays deleted)
        const r = syncTask(t, e, keyDay, false);
        if (r.done.length) lines.push({ kind: 'edit', name: t.name, text: r.done.join(', ') });
        if (r.kept.length) lines.push({ kind: 'kept', name: t.name, text: `kept your change to ${r.kept.join(', ')}` });
      }
    });
    // Removed from the group: taken out, unless there's work on them (done, a subtask done, or comments)
    const gone = new Set();
    for (const t of placed.filter(t => !now.includes(t.from.i))) {
      const why = t.done ? 'done' : (t.subtasks || []).some(s => s.done) ? 'a subtask is done' : comments(t.id) ? 'it has comments' : '';
      if (why) {
        delete t.from; // (it's the project's own now)
        lines.push({ kind: 'kept', name: t.name, text: `removed from the activity group, but kept here (${why})` });
      } else { gone.add(t.id); lines.push({ kind: 'del', name: t.name, text: 'removed from the activity group' }); }
    }
    const result = next.filter(t => !gone.has(t.id));
    result.forEach(t => {
      if (t.after) t.after = t.after.filter(a => !gone.has(a)); // (links to removed ones)
      if (t.from?.x === x) t.from.ids = now;
    });
    return { group, lines, tasks: result, real: lines.some(l => l.kind !== 'kept') };
  }
  const update = document.createElement('dialog');
  update.className = 'preset-ask preset-update';
  document.body.append(update);
  let asking = false;
  // All of a project's placements of the group, one after the other
  function projectChanges(p, list, comments) {
    const xs = [...new Set(list.filter(t => t.from?.x && t.from.p === p.id).map(t => t.from.x))];
    let lines = [], real = false;
    for (const x of xs) {
      const ch = changesFor(p, x, list, comments);
      if (!ch || !ch.real) continue;
      list = ch.tasks; real = true;
      lines = [...lines, ...(xs.length > 1 ? [{ kind: 'group', name: ch.group }] : []), ...ch.lines];
    }
    return { tasks: list, lines, real, xs };
  }
  const isOpen = q => q.kind === 'local' ? q.id === LOCAL_ID : q.id === ONLINE_ID;
  // Saving an activity group: which of your projects use it, and what would change in each.
  // You tick the ones to update (all are ticked); the others aren't asked about this again.
  async function offerEverywhere(groupId) {
    const a = api(), p = list().find(q => q.id === groupId);
    if (!p || asking) return;
    asking = true;
    try {
      const found = [];
      if (!readOnly && (LOCAL_ID || ONLINE_ID) && tasks.some(t => t.from?.p === p.id)) {
        const ch = projectChanges(p, tasks, id => window.collab?.count?.(id) || 0);
        if (ch.real) found.push({ name: projectName, open: true, ch });
      }
      for (const q of a ? await a.projects() : []) {
        if (isOpen(q) || !q.data.tasks.some(t => t.from?.p === p.id)) continue;
        const counts = await a.commentCounts(q);
        const ch = projectChanges(p, q.data.tasks, id => counts[id] || 0);
        if (ch.real) found.push({ name: q.name, q, ch, unsaved: !!q.draft });
      }
      if (!found.length) return;
      const chosen = await askProjects(p, found);
      for (const [i, f] of found.entries()) {
        if (chosen.includes(i)) {
          if (f.open) { tasks = f.ch.tasks; save(); render(); }
          else { f.q.data = { ...f.q.data, tasks: f.ch.tasks }; await a.saveProject(f.q); }
        } else {
          const d = declined().filter(k => !f.ch.xs.some(x => k.startsWith(`${x}|`)));
          try { localStorage.setItem(DECLINED_KEY, JSON.stringify([...d, ...f.ch.xs.map(x => changeKey(x, p))].slice(-200))); } catch {}
        }
      }
    } finally { asking = false; }
  }
  const sign = { add: '+', del: '−', edit: '✎', kept: '•' };
  const lineHtml = l => l.kind === 'group' ? `<li class="pu-group">${esc(l.name)}</li>`
    : `<li class="pu-${l.kind}"><b>${sign[l.kind]}</b><span>${l.ms ? '◆ ' : ''}${esc(l.name)}</span><small>${l.kind === 'edit' ? l.text : esc(l.text)}</small></li>`;
  function askProjects(p, found) {
    update.innerHTML = `<form method="dialog">
        <h2>${esc(p.name)} has changed</h2>
        <p>${found.length > 1 ? `${found.length} of your projects use it.` : 'One of your projects uses it.'} Tick the ones to update: only these changes are made, and what's been changed or added in a project stays as it is.</p>
        <div class="pu-projects">${found.map((f, i) => `<details class="pu-project">
            <summary><input type="checkbox" checked data-i="${i}" aria-label="Update ${esc(f.name)}"><b>${esc(f.name)}</b>${f.open ? ' <small>(open)</small>' : f.unsaved ? ' <small>(has unsaved changes: updated along with them)</small>' : ''}
              <span class="pu-count">${f.ch.lines.filter(l => l.kind !== 'kept' && l.kind !== 'group').length} change${f.ch.lines.filter(l => l.kind !== 'kept' && l.kind !== 'group').length === 1 ? '' : 's'}</span></summary>
            <ul class="pu-list">${f.ch.lines.map(lineHtml).join('')}</ul>
          </details>`).join('')}</div>
        <div class="actions reverse"><button value="ok" class="primary">Update the ticked projects</button><button value="no">Not now</button></div>
      </form>`;
    update.returnValue = '';
    update.querySelector('details')?.setAttribute('open', '');
    // (ticking a box doesn't fold its project open or shut)
    update.querySelectorAll('summary input').forEach(cb => cb.addEventListener('click', e => e.stopPropagation()));
    update.showModal();
    return new Promise(res => update.addEventListener('close', () => res(update.returnValue === 'ok'
      ? [...update.querySelectorAll('summary input:checked')].map(cb => +cb.dataset.i) : []), { once: true }));
  }
  async function offerUpdates(onlyFor) {
    if (readOnly || asking || storeState() !== 'ok') return;
    const presets = list();
    const xs = [...new Set(tasks.filter(t => t.from?.x && (!onlyFor || t.from.p === onlyFor)).map(t => t.from.x))];
    for (const x of xs) {
      const p = presets.find(q => q.id === tasks.find(t => t.from?.x === x)?.from.p);
      if (!p) continue; // (the activity group was deleted: its places stay as they are)
      const ch = changesFor(p, x);
      if (!ch || !ch.real || declined().includes(changeKey(x, p))) continue;
      asking = true;
      const yes = await askUpdate(p, ch);
      asking = false;
      if (yes) { tasks = ch.tasks; save(); render(); }
      else {
        const d = declined().filter(k => !k.startsWith(`${x}|`));
        try { localStorage.setItem(DECLINED_KEY, JSON.stringify([...d, changeKey(x, p)].slice(-200))); } catch {}
      }
    }
  }
  function askUpdate(p, ch) {
    update.innerHTML = `<form method="dialog">
        <h2>${esc(p.name)} has changed</h2>
        <p>Update <b>${esc(ch.group || p.name)}</b> in this project? Only these changes are made: what's been changed or added in the project stays as it is.</p>
        <ul class="pu-list">
          ${ch.lines.map(lineHtml).join('')}
        </ul>
        <div class="actions reverse"><button value="ok" class="primary">Update</button><button value="no">Keep as it is</button></div>
      </form>`;
    update.returnValue = '';
    update.showModal();
    return new Promise(res => update.addEventListener('close', () => res(update.returnValue === 'ok'), { once: true }));
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
        key: { id: key.id, name: key.name, len: daysBetween(parse(key.start), parse(key.end)) + 1, lenUnit: 'days', milestone: key.milestone || '', subtasks: (key.subtasks || []).map(s => ({ id: uid(), name: s.name })), notes: key.notes || '' },
        items: all.filter(t => t !== key).map(t => {
          const off = dayNumber(parse(t.start)) - keyDay;
          return { id: t.id, name: t.name, side: off < 0 ? 'before' : 'after', n: Math.abs(off), unit: 'days',
            len: daysBetween(parse(t.start), parse(t.end)) + 1, lenUnit: 'days', milestone: t.milestone || '', subtasks: (t.subtasks || []).map(s => ({ id: uid(), name: s.name })), notes: t.notes || '' };
        }),
      }],
    }, { fromGroup: true });
  }, true);

  // ---- The editor ----
  let draft = null, draftIsNew = false, addingLink = false, placeOpen = false;
  const notesOpen = new Set(); // (the rows whose notes are showing: their ids)
  const newSection = name => ({ id: uid(), key: { id: uid(), name, len: 1, lenUnit: 'days', subtasks: [] }, items: [] });
  function openEditor(p, { fromGroup = false } = {}) {
    draftIsNew = !p || !p.id;
    draft = p ? JSON.parse(JSON.stringify(normalize(p))) : {
      id: null, name: '', color: Math.floor(Math.random() * PALETTE.length), links: [], gaps: {}, sections: [newSection('Event')],
    };
    addingLink = false; placeOpen = false;
    notesOpen.clear();
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
  // Notes and instructions and subtasks for an activity: 📝 shows them under its row (they
  // go onto the task when the group is placed)
  const NOTE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 3h9l4 4v14H6z M15 3v4h4 M9 12h7 M9 16h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const notesButton = (id, x) => {
    const subs = (x.subtasks || []).length, has = x.notes || subs;
    return `<button type="button" class="pe-notes-btn${has ? ' has' : ''}${notesOpen.has(id) ? ' open' : ''}" data-id="${id}"
      title="${has ? 'Notes and subtasks' : 'Add notes and subtasks'}" aria-label="Notes and subtasks" aria-expanded="${notesOpen.has(id)}">${NOTE_ICON}${subs ? `<small>${subs}</small>` : ''}</button>`;
  };
  const notesBox = (id, x) => notesOpen.has(id) ? `<div class="pe-details">
      <textarea class="pe-notes" data-id="${id}" rows="2" placeholder="Notes and instructions for this activity…" aria-label="Notes and instructions">${esc(x.notes || '')}</textarea>
      <ol class="pe-subs">${(x.subtasks || []).map((sub, n) => `<li><span class="pe-sub-no">${n + 1}</span>
        <input class="pe-sub" data-n="${n}" value="${esc(sub.name)}" aria-label="Subtask ${n + 1}" autocomplete="off">
        <button type="button" class="pe-sub-del" data-n="${n}" title="Remove subtask" aria-label="Remove subtask">✕</button></li>`).join('')}</ol>
      <form class="pe-sub-add" data-id="${id}"><input autocomplete="off" placeholder="Add a subtask and press Enter" aria-label="New subtask"></form>
    </div>` : '';
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
      <div class="pe-row pe-colhead" aria-hidden="true"><span></span><span>Activity</span><span>Starts</span><span>Duration</span><span></span><span></span><span></span></div>
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
            ${notesButton(it.id, it)}
            <button type="button" class="pe-del" title="Remove this activity" aria-label="Remove">✕</button>
            ${notesBox(it.id, it)}
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
            ${notesButton(s.key.id, s.key)}
            <button type="button" class="pe-kdel" title="${many ? 'Remove this key date and its activities' : 'An activity group needs a key date'}" aria-label="Remove key date" ${many ? '' : 'disabled'}>✕</button>
            ${notesBox(s.key.id, s.key)}
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
  const ownerOf = el => el.closest('.pe-keyrow') ? secOf(el).key : itemOf(el); // (a key date or an activity)
  body.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('.pe-title')) draft.name = el.value;
    else if (el.matches('.pe-name')) itemOf(el).name = el.value;
    else if (el.matches('.pe-kname')) secOf(el).key.name = el.value;
    else if (el.matches('.pe-notes')) ownerOf(el).notes = el.value;
    else if (el.matches('.pe-sub')) ownerOf(el).subtasks[+el.dataset.n].name = el.value;
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
    const sf = e.target.closest('.pe-sub-add');
    if (sf) { // a new subtask: ready for the next one
      const name = sf.querySelector('input').value.trim();
      if (!name) return;
      (ownerOf(sf).subtasks ||= []).push({ id: uid(), name });
      return drawEditor(`.pe-sub-add[data-id="${sf.dataset.id}"] input`);
    }
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
    const sd = t.closest('.pe-sub-del');
    if (sd) { ownerOf(sd).subtasks.splice(+sd.dataset.n, 1); return drawEditor(); }
    const nb = t.closest('.pe-notes-btn');
    if (nb) {
      const id = nb.dataset.id;
      notesOpen.has(id) ? notesOpen.delete(id) : notesOpen.add(id);
      drawEditor(notesOpen.has(id) ? `.pe-notes[data-id="${id}"]` : null);
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
      if (await saveDraft()) { dlg.close(); if (id) offerEverywhere(id); }
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
      for (const x of [s.key, ...s.items]) x.subtasks = (x.subtasks || []).map(sub => ({ ...sub, name: sub.name.trim() })).filter(sub => sub.name);
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
