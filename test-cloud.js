// Test mode (only on this computer, at localhost): stands in for cloud.js with
// the same functions, but keeps everything in this browser, under its own keys,
// with example projects, labels and comments. You're signed in at once as a
// test user. Nothing is sent online and your real data isn't touched. collab.js
// loads this instead of cloud.js while test mode is on.
const DB_KEY = 'worknest-test:db';
const ME = { uid: 'test-user', email: 'you@example.com', name: 'Test user', google: true };
const listeners = new Set();
const notify = () => { for (const fn of [...listeners]) fn(); };
const load = () => JSON.parse(localStorage.getItem(DB_KEY));
const save = db => { localStorage.setItem(DB_KEY, JSON.stringify(db)); setTimeout(notify, 30); };
addEventListener('storage', e => { if (e.key === DB_KEY) notify(); }); // (other tabs)
const newId = () => Math.random().toString(36).slice(2, 12);
const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
const canSee = p => p.owner === ME.email || p.viewers.includes(ME.email);

// The example data, made the first time (and again after "Reset examples")
function seed() {
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const project = (name, owner, viewers, tasks, groupColors) =>
    ({ name, owner, viewers, updated: Date.now() - Math.random() * 864e5, data: JSON.stringify({ tasks, groupColors }) });
  const db = {
    projects: {
      shop: project('Webshop for Anna', ME.email, ['anna@example.com'], [
        { id: 't1', name: 'Kick-off', group: 'Planning', start: day(-9), end: day(-9), done: true, milestone: 'start' },
        { id: 't2', name: 'Wireframes', group: 'Design', start: day(-6), end: day(1), done: true },
        { id: 't3', name: 'Visual design', group: 'Design', start: day(1), end: day(8), after: ['t2'],
          subtasks: [{ id: 's1', name: 'Colours', done: true }, { id: 's2', name: 'Product page', done: false }] },
        { id: 't4', name: 'Build the shop', group: 'Development', start: day(7), end: day(24), after: ['t3'] },
        { id: 't5', name: 'Launch', group: 'Development', start: day(25), end: day(25), milestone: 'start', after: ['t4'] },
      ], { Planning: 0, Design: 2, Development: 5 }),
      intranet: project('Intranet update', ME.email, [], [
        { id: 'u1', name: 'Gather wishes', start: day(-3), end: day(4) },
        { id: 'u2', name: 'New start page', start: day(5), end: day(16) },
      ], {}),
      logo: project('Logo for Erik', 'erik@example.com', [ME.email], [
        { id: 'l1', name: 'Sketches', group: 'Logo', start: day(2), end: day(6) },
        { id: 'l2', name: 'Final logo', group: 'Logo', start: day(7), end: day(10), milestone: 'end' },
      ], { Logo: 3 }),
    },
    comments: {
      c1: { project: 'shop', taskId: 't3', text: 'Here are the first colour ideas. What do you think?', uid: ME.uid, email: ME.email, name: ME.name, images: [], at: Date.now() - 5 * 36e5 },
      c2: { project: 'shop', taskId: 't3', text: 'Love the green! Could the buttons be a bit bigger? See www.example.com for an example.', uid: 'anna', email: 'anna@example.com', name: 'Anna', images: [], at: Date.now() - 2 * 36e5 },
    },
    images: {},
    users: { [ME.uid]: { labels: [{ id: 'customers', name: 'Customers', color: '#3fb6a8' }, { id: 'internal', name: 'Internal', color: '#4f8ff7' }],
      projectLabels: { 'online:shop': 'customers', 'shared:logo': 'customers', 'online:intranet': 'internal' } } },
  };
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  // and one project kept on this computer (in test mode's own place, see app.js)
  writeLocal('draft', { name: 'Ideas for 2027', tasks: [{ id: 'd1', name: 'Brainstorm', group: 'Ideas', start: day(3), end: day(12) }], groupColors: { Ideas: 1 } });
}

export function init() { if (!load()) seed(); }

// ---- Signing in: you're always signed in as the test user
export const onUser = cb => { setTimeout(() => cb({ ...ME }), 0); };
export const sendLink = async () => {};
export const isLink = () => false;
export const finishLink = async () => {};
export const signInWithGoogle = async () => {};
export const signOut = async () => { localStorage.removeItem('worknest-test-mode'); }; // (signing out leaves test mode)

// ---- Projects
export function watchProject(id, onData, onError) {
  let last;
  const check = () => {
    const p = load().projects[id];
    if (p && !canSee(p)) { listeners.delete(check); return onError(denied()); }
    const json = JSON.stringify(p || null);
    if (json !== last) { last = json; onData(p ? { ...p } : null); }
  };
  listeners.add(check);
  setTimeout(check, 50);
  return () => listeners.delete(check);
}
export async function createProject({ name, data, owner }) {
  const db = load(), id = newId();
  db.projects[id] = { name, data, owner, viewers: [], updated: Date.now() };
  save(db);
  return id;
}
export async function saveProject(id, fields) {
  const db = load();
  if (db.projects[id]?.owner !== ME.email) throw denied();
  Object.assign(db.projects[id], fields, { updated: Date.now() });
  save(db);
}
export const setViewers = (id, viewers) => saveProject(id, { viewers });
export async function deleteProject(id) {
  const db = load();
  for (const [cid, c] of Object.entries(db.comments)) {
    if (c.project === id) { (c.images || []).forEach(i => delete db.images[i.id]); delete db.comments[cid]; }
  }
  delete db.projects[id];
  save(db);
}
export async function listProjects(email) {
  return Object.entries(load().projects).filter(([, p]) => p.owner === email || p.viewers.includes(email))
    .map(([id, p]) => ({ id, name: p.name, mine: p.owner === email, owner: p.owner, viewers: p.viewers.length, updated: p.updated || 0, data: p.data }));
}

// ---- Your labels
export async function getMine(uid) { return load().users[uid] || {}; }
export async function saveMine(uid, { labels, projectLabels, presets }) {
  const db = load();
  db.users[uid] = { labels, projectLabels, presets: presets || [] };
  save(db);
}

// ---- Comments
export function watchComments(id, onList) {
  let last;
  const check = () => {
    const list = Object.entries(load().comments).filter(([, c]) => c.project === id)
      .map(([cid, c]) => ({ ...c, id: cid })).sort((a, b) => a.at - b.at);
    const json = JSON.stringify(list);
    if (json !== last) { last = json; onList(list); }
  };
  listeners.add(check);
  setTimeout(check, 60);
  return () => listeners.delete(check);
}
export async function addComment(projectId, me, { taskId, text, images }) {
  const db = load();
  const imgs = images.map(img => { const iid = newId(); db.images[iid] = img.data; return { id: iid, w: img.w, h: img.h }; });
  db.comments[newId()] = { project: projectId, taskId, text, uid: me.uid, email: me.email, name: me.name, images: imgs, at: Date.now() };
  save(db);
}
export async function deleteComment(projectId, comment) {
  const db = load();
  (comment.images || []).forEach(i => delete db.images[i.id]);
  delete db.comments[comment.id];
  save(db);
}
export async function getImage(projectId, imageId) { return load().images[imageId] || null; }
