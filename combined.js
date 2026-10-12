// ---- Several projects in one timeline (read only) ----
// Draws the chosen projects one under the other, in the same chart as a single
// project (the same date header, weekends, today line, group colours, bars,
// progress and milestones), but without the task list: each project starts
// with a row showing its name (a link to open it), then its groups and tasks.
// Nothing can be changed here. Used by the All projects page (collab.js); it
// uses app.js's date helpers and colours.
let comboLeftDay = null; // the day at the left edge, kept while redrawing (null: around today)

// projects: [{ key, name, color, label, tasks }] (color: its bars' colour, its
// label's; label: the label's name, '' for none); dayW: pixels per day;
// show: { from, to } (day numbers) to make sure those days are drawn and scroll to
// `from` (otherwise the timeline stays where it was).
function drawCombined(el, projects, dayW, show) {
  const today = parse(todayString());
  const dated = projects.flatMap(p => p.tasks).filter(t => t.start && t.end);

  // Range: all the tasks and today, a week either side, and at least a screen wide
  const wanted = show ? [show.from * DAY, show.to * DAY] : [];
  let min = Math.min(+today, ...dated.map(t => +parse(t.start)), ...wanted) - 7 * DAY;
  let max = Math.max(+today, ...dated.map(t => +parse(t.end)), ...wanted) + 7 * DAY;
  if (show) comboLeftDay = show.from;
  const screenDays = Math.ceil((el.clientWidth || 800) / dayW);
  if ((max - min) / DAY < screenDays) max = min + screenDays * DAY;
  min = new Date(min); max = new Date(max);
  const totalDays = daysBetween(min, max) + 1, width = totalDays * dayW;
  const x = s => daysBetween(min, parse(s)) * dayW;

  // The date header and day columns, as in the chart (see render() in app.js):
  // quarter, month, week and days; without the days when they're too narrow to
  // number (Quarter), and without the weeks too when zoomed further out
  const levels = dayW >= 18 ? ['quarter', 'month', 'week', 'days'] : dayW >= 5 ? ['quarter', 'month', 'week'] : ['quarter', 'month'];
  const topOf = lvl => [4, 21, 38, 56][levels.indexOf(lvl)];
  let grid = '', head = '';
  const period = (cls, from, to, text, minPx, title = '') => {
    if (!levels.includes(cls)) return;
    const w = (to - from) * dayW;
    head += `<div class="hspan ${cls}" style="left:${from * dayW}px;width:${w}px;top:${topOf(cls)}px"${title ? ` title="${title}"` : ''}><span>${w >= minPx ? text : ''}</span></div>`;
  };
  const dateAt = i => new Date(+min + i * DAY);
  let monthFrom = 0, quarterFrom = 0, weekFrom = 0;
  for (let i = 0; i <= totalDays; i++) {
    const d = dateAt(i), last = i === totalDays;
    if (!last) {
      const dow = d.getUTCDay();
      const cls = (dow === 0 || dow === 6 ? ' weekend' : '') + (dow === 1 ? ' week-start' : '') + (d.getUTCDate() === 1 ? ' month-start' : '');
      grid += `<div class="day${cls}" style="left:${i * dayW}px;width:${dayW}px"></div>`;
      if (levels.includes('days')) { // (with the weekday when there's room, as in the chart)
        const label = dayW >= 70 ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }) : d.getUTCDate();
        head += `<div class="day-label${dow === 0 || dow === 6 ? ' weekend' : ''}" style="left:${i * dayW}px;width:${dayW}px;top:${topOf('days')}px">${label}</div>`;
      }
    }
    if (i === 0) continue;
    if (last || d.getUTCDate() === 1) {
      period('month', monthFrom, i, dateAt(monthFrom).toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }), 64);
      monthFrom = i;
    }
    if (last || (d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0)) {
      period('quarter', quarterFrom, i, `Q${Math.floor(dateAt(quarterFrom).getUTCMonth() / 3) + 1}`, 24);
      quarterFrom = i;
    }
    if (last || d.getUTCDay() === 1) {
      const wk = isoWeek(dateAt(weekFrom)), w = (i - weekFrom) * dayW;
      period('week', weekFrom, i, w >= 64 ? `Week ${wk}` : `W${wk}`, 28, `Week ${wk}`);
      weekFrom = i;
    }
  }
  const todayAt = daysBetween(min, today);
  const todayLine = `<div class="today" style="left:${todayAt * dayW + dayW / 2}px" title="Today"></div>`;

  // By colour: the projects come in label order (collab.js), each one's tasks
  // packed together (a task goes on the first line where it fits after the one
  // before), all in its label's colour. Their names are on the chips above, in
  // the same colour, so there's no name row here: a thin line starts each
  // project, and a little more room each new label. Pointing at a bar shows its
  // project, group and dates.
  let rows = '', section, first = true;
  for (const p of projects) {
    const list = p.tasks.filter(t => t.start && t.end).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    const lanes = [], bars = [];
    for (const t of list) {
      const from = x(t.start), len = daysBetween(parse(t.start), parse(t.end)) + 1;
      const room = Math.max(len * dayW, Math.min(t.name.length * 7 + 24, 240)) + (t.milestone === 'end' ? 12 : 0); // (room for its name too)
      let lane = lanes.findIndex(end => end + 4 <= from);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = from + room;
      bars.push({ t, lane, len });
    }
    const lines = lanes.length ? Array.from(lanes, () => '') : [''];
    for (const { t, lane, len } of bars) {
      const pct = progressOf(t), subs = (t.subtasks || []).length;
      lines[lane] += `<div class="bar${t.milestone ? ' ms-' + t.milestone : ''}${pct === 100 ? ' done' : ''}" style="left:${x(t.start)}px;width:${len * dayW}px"
          title="${esc(p.name)}${t.group ? `, ${esc(t.group)}` : ''} (${len}d)"
          ><span class="progress" style="width:${pct}%"></span><span class="label">${esc(t.name)}${subs ? ` · ${pct}%` : ''}</span>${t.milestone ? '<i class="diamond"></i>' : ''}</div>`;
    }
    if (!bars.length) lines[0] = `<span class="combo-tag" title="${esc(p.name)}">${esc(p.name)}: no tasks yet</span>`;
    const start = first ? '' : p.label !== section ? ' label-start' : ' proj-start';
    rows += lines.map((l, i) => `<div class="row combo-lane${i ? '' : start}" data-key="${esc(p.key)}" style="--bar:${p.color}">${l}</div>`).join('');
    section = p.label; first = false;
  }

  // The page scrolls down (not a box inside it); the timeline only scrolls
  // sideways. The date header is a separate strip that sticks under the top bar
  // while the page scrolls, and follows the timeline sideways.
  const cls = `track combo-track${dayW < 18 ? ' compact' : ''}`, todayHere = todayAt >= 0 && todayAt < totalDays ? todayLine : '';
  el.innerHTML = `<div class="combo-headwrap"><div class="${cls}" style="width:${width}px">${todayHere}<div class="head"><div class="combo-hl" hidden></div>${head}</div></div></div>
    <div class="combo-scroll" data-min="${+min}" data-dayw="${dayW}">
    <div class="${cls}" style="width:${width}px">
      ${grid}${todayHere}${rows}
    </div></div>`;
  const s = el.querySelector('.combo-scroll'), hw = el.querySelector('.combo-headwrap');
  const leftDay = comboLeftDay ?? dayNumber(today) - Math.floor(s.clientWidth / dayW / 4); // (today a quarter in, like the chart)
  s.scrollLeft = (leftDay - dayNumber(min)) * dayW;
  hw.scrollLeft = s.scrollLeft;
  tidyCombinedLabels(hw);
  // Pointing at a bar marks its days in the date header: a red line under the
  // day numbers it spans, and its first and last day numbers in bold
  const hl = hw.querySelector('.combo-hl');
  const mark = bar => {
    hl.hidden = !bar;
    const from = bar ? parseFloat(bar.style.left) : -1, to = bar ? from + parseFloat(bar.style.width) - dayW : -1;
    if (bar) { hl.style.left = bar.style.left; hl.style.width = bar.style.width; }
    for (const label of hw.querySelectorAll('.day-label')) {
      const at = parseFloat(label.style.left);
      label.classList.toggle('edge', !!bar && (Math.abs(at - from) < 1 || Math.abs(at - to) < 1));
    }
  };
  s.addEventListener('pointerover', e => mark(e.target.closest('.bar')));
  s.addEventListener('pointerleave', () => mark(null));
  let queued = false;
  s.addEventListener('scroll', () => {
    hw.scrollLeft = s.scrollLeft;
    comboLeftDay = dayNumber(min) + s.scrollLeft / dayW;
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; tidyCombinedLabels(hw); }); }
  }, { passive: true });
}

// A quarter/month/week label being pushed out at the left edge is hidden
// rather than shown cut off (as tidyHeaderLabels does in the chart)
function tidyCombinedLabels(s) {
  const left = s.getBoundingClientRect().left;
  for (const span of s.querySelectorAll('.hspan')) {
    const label = span.firstElementChild, r = span.getBoundingClientRect();
    label.style.visibility = r.right - Math.max(r.left, left) < label.offsetWidth ? 'hidden' : '';
  }
}

// Back to today
function combinedToday(el) {
  comboLeftDay = null;
  const s = el.querySelector('.combo-scroll');
  if (!s) return;
  s.scrollLeft = (dayNumber(parse(todayString())) - +s.dataset.min / DAY - Math.floor(s.clientWidth / +s.dataset.dayw / 4)) * +s.dataset.dayw;
}
