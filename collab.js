// ---- Accounts, online projects, sharing and comments ----
// With Firebase set up (firebase-config.js), WorkNest starts on a start page
// where you sign in (Google, or a link emailed to you); then your projects show,
// and each project opens as ?p=<id>. The owner shares a project by adding a
// customer's email address: they sign in and can see the plan, and everyone
// talks about each task in its comments, with images and links. Only the owner
// can change the plan. cloud.js does the storing; app.js has the matching hooks
// (CLOUD, ONLINE_ID, readOnly, cloudSave, window.collab). Without Firebase
// settings none of this shows and the project stays in the browser.
(() => {
  const config = window.GANTT_FIREBASE;
  const version = new URL(document.currentScript.src).search; // load cloud.js as fresh as the rest
  const EMAIL_KEY = 'simple-gantt-signin-email';   // to finish an emailed sign-in link
  const onThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname); // (test mode is offered only here)
  const SEEN_KEY = `simple-gantt-seen:${ONLINE_ID}`; // per task: when its newest comment was seen
  const MAX_IMAGES = 6;
  // true: only people signed in with Google can create projects, and the start
  // page offers only Google (the emailed link is then just for opening a project
  // shared with you). Turn it on together with the matching line in firestore.rules.
  const GOOGLE_ONLY = false;
  const TALK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20.5l1.5-4.6A8 8 0 1 1 21 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  const IMAGE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4 18l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  const root = document.documentElement;
  let cloud = null, user = null; // user: { uid, email, name } once signed in
  let project = null;            // the online project ({ name, data, owner, viewers })
  let comments = [];             // all of its comments, oldest first
  let stopProject = null, stopComments = null;
  let firstData = true;
  let saveTimer = null, saving = 0;
  const sent = [];               // the project data most recently sent (to recognise it coming back)
  let linking = false;           // finishing an emailed sign-in link
  let screen = null, screenOpts = {};
  const seen = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; } })();
  const images = new Map();      // image id -> promise of its data: URL
  const isOwner = () => !!(user && project && project.owner === user.email);
  const store = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };

  // Redraws the chart, but never in the middle of a drag or a rename
  function safeRender() {
    if (drag || renaming) return setTimeout(safeRender, 300);
    render();
  }

  // ================= The comment thread (in the task sheet) =================
  let threadTask = null;  // the task whose comments are shown
  let pending = [];       // images added to the comment being written: [{ data, w, h }]
  const thread = document.createElement('section');
  thread.className = 'thread';
  thread.innerHTML = `
    <h3>Comments</h3>
    <ol class="cm-list"></ol>
    <p class="cm-local">Comments need an online project. <button type="button" class="link-like cm-move">Move it online</button> to talk about it with others.</p>
    <form class="cm-form">
      <div class="cm-previews"></div>
      <textarea rows="1" placeholder="Write a comment…" aria-label="Write a comment"></textarea>
      <div class="cm-actions">
        <button type="button" class="cm-add-image" title="Add images (you can also paste or drop them)" aria-label="Add images">${IMAGE_ICON}</button>
        <input type="file" accept="image/*" multiple hidden>
        <span class="cm-status" aria-live="polite"></span>
        <button class="primary cm-send" title="Send (Ctrl+Enter)" aria-label="Send"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </form>`;
  const listEl = thread.querySelector('.cm-list');
  const form = thread.querySelector('.cm-form');
  const textEl = thread.querySelector('textarea');
  const fileEl = thread.querySelector('input[type=file]');
  const statusEl = thread.querySelector('.cm-status');
  const sendBtn = thread.querySelector('.cm-send');

  const online = () => !!(ONLINE_ID && user && project);
  const taskComments = id => comments.filter(c => c.taskId === id);

  function drawThread() {
    thread.classList.toggle('online', online());
    thread.classList.toggle('local', !!LOCAL_ID);
    if (!online() || !threadTask) return;
    const list = taskComments(threadTask);
    thread.querySelector('h3').textContent = list.length ? `Comments · ${list.length}` : 'Comments';
    listEl.innerHTML = list.length ? list.map(commentHtml).join('')
      : '<li class="cm-empty">No comments yet.</li>';
    for (const btn of listEl.querySelectorAll('.cm-img')) {
      imageData(btn.dataset.img).then(src => { if (src) btn.querySelector('img').src = src; });
    }
    markSeen(threadTask);
  }

  function commentHtml(c) {
    const mine = c.uid === user.uid;
    const who = mine ? 'You' : c.name || c.email.split('@')[0];
    return `<li class="cm${mine ? ' mine' : ''}" data-id="${c.id}">
      <div class="cm-meta"><span title="${esc(c.email)}">${esc(who)}</span> · <time>${when(c.at)}</time>
        ${mine || isOwner() ? '<button type="button" class="cm-del" title="Delete comment">✕</button>' : ''}</div>
      <div class="cm-bubble">${c.text ? `<p>${linkify(c.text)}</p>` : ''}${(c.images || []).length
        ? `<div class="cm-imgs">${c.images.map(i => `<button type="button" class="cm-img" data-img="${esc(i.id)}"
             style="aspect-ratio:${+i.w || 4}/${+i.h || 3}" title="Show larger"><img alt="Image"></button>`).join('')}</div>` : ''}</div>
    </li>`;
  }

  // "Today 14:32", "9 Oct, 14:32", or with the year when it isn't this year
  function when(ms) {
    const d = new Date(ms), now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) };
    return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
  }

  // The text, safe to show, with web addresses as links and line breaks kept
  function linkify(text) {
    return esc(text).replace(/\b(?:https?:\/\/|www\.)[^\s<]+/gi, m => {
      const trail = (m.match(/(?:[.,!?;:)\]]|&#39;)+$/) || [''])[0];
      const shown = m.slice(0, m.length - trail.length);
      const url = normalizeUrl(shown.replace(/&amp;/g, '&'));
      return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${shown}</a>${trail}` : m;
    }).replace(/\n/g, '<br>');
  }

  function imageData(id) {
    if (!images.has(id)) images.set(id, cloud.getImage(ONLINE_ID, id).catch(() => null));
    return images.get(id);
  }

  // A task's comments count as seen once its thread has been open
  function markSeen(id) {
    const newest = Math.max(0, ...taskComments(id).map(c => c.at));
    if (newest > (seen[id] || 0)) {
      seen[id] = newest;
      store(SEEN_KEY, JSON.stringify(seen));
      safeRender(); // the task's 💬 is no longer highlighted
    }
  }

  // ---- Writing a comment ----
  function drawPreviews() {
    thread.querySelector('.cm-previews').innerHTML = pending.map((img, i) =>
      `<span class="cm-preview"><img src="${img.data}" alt=""><button type="button" data-i="${i}" title="Remove image">✕</button></span>`).join('');
  }
  async function addFiles(files) {
    const pics = [...files].filter(f => f.type.startsWith('image/'));
    if (!pics.length) return;
    statusEl.textContent = 'Preparing image…';
    for (const f of pics) {
      if (pending.length >= MAX_IMAGES) { statusEl.textContent = `At most ${MAX_IMAGES} images per comment.`; break; }
      try { pending.push(await shrinkImage(f)); } catch { statusEl.textContent = 'That image couldn\'t be read.'; continue; }
      statusEl.textContent = '';
    }
    drawPreviews();
  }
  // Images are shrunk to at most 1600 px and saved as JPEG, small enough to
  // store in the database (under 1 MB each)
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    for (;;) {
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); // (transparent parts become white)
      g.drawImage(bmp, 0, 0, w, h);
      const data = canvas.toDataURL('image/jpeg', 0.82);
      if (data.length < 900000 || w < 300) return { data, w, h };
      scale *= 0.75;
    }
  }
  function growText() { textEl.style.height = 'auto'; textEl.style.height = Math.min(textEl.scrollHeight + 2, 240) + 'px'; }

  thread.querySelector('.cm-add-image').onclick = () => fileEl.click();
  fileEl.onchange = () => { addFiles(fileEl.files); fileEl.value = ''; };
  textEl.addEventListener('input', growText);
  textEl.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.some(f => f.type.startsWith('image/'))) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(files);
  });
  form.addEventListener('dragover', e => { e.preventDefault(); form.classList.add('dropping'); });
  form.addEventListener('dragleave', () => form.classList.remove('dropping'));
  form.addEventListener('drop', e => { e.preventDefault(); form.classList.remove('dropping'); addFiles(e.dataTransfer.files); });
  textEl.addEventListener('keydown', e => { // Ctrl/Cmd+Enter sends; Enter is a new line
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    e.stopPropagation();
    const text = textEl.value.trim();
    if ((!text && !pending.length) || sendBtn.disabled) return;
    sendBtn.disabled = true;
    statusEl.textContent = 'Sending…';
    try {
      await cloud.addComment(ONLINE_ID, user, { taskId: threadTask, text, images: pending });
      textEl.value = ''; growText();
      pending = []; drawPreviews();
      statusEl.textContent = '';
      form.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Couldn\'t send. Check your connection and try again.';
    }
    sendBtn.disabled = false;
  });

  thread.addEventListener('click', async e => {
    const remove = e.target.closest('.cm-preview button');
    if (remove) { pending.splice(+remove.dataset.i, 1); return drawPreviews(); }
    if (e.target.closest('.cm-move')) return showCloud('moveonline', { id: LOCAL_ID });
    const pic = e.target.closest('.cm-img');
    if (pic) return showImage(await imageData(pic.dataset.img));
    const del = e.target.closest('.cm-del');
    if (del) {
      const c = comments.find(c => c.id === del.closest('.cm').dataset.id);
      if (c && await askConfirm('Delete comment?', 'The comment and its images will be removed for everyone.', 'Delete')) {
        try { await cloud.deleteComment(ONLINE_ID, c); } catch { statusEl.textContent = 'Couldn\'t delete the comment.'; }
      }
    }
  });

  // A larger look at an image: click anywhere (or Esc) to close
  const viewer = document.getElementById('imageViewer');
  function showImage(src) {
    if (!src) return;
    viewer.querySelector('img').src = src;
    viewer.showModal();
  }
  viewer.addEventListener('click', () => viewer.close());

  // ================= Pages, signing in, sharing, the account menu =================
  // Without a project in the address the app shows the start page (signed
  // out) or your projects (signed in); with one (?p=<id>), that project.
  const dialog = document.getElementById('cloudDialog');
  const body = document.getElementById('cloudBody');
  const shareBtn = document.getElementById('shareBtn');
  const accountWrap = document.getElementById('accountWrap');
  const accountBtn = document.getElementById('accountBtn');
  const accountMenu = document.getElementById('accountMenu');
  const startCard = document.getElementById('startCard');
  const projectUrl = id => `${location.origin}${location.pathname}?p=${id}`;
  const goHome = () => { location.href = location.pathname; }; // your projects (or the start page)

  // 'loading' (until we know who you are) | 'start' | 'projects' | 'app'
  function showPage(name) {
    for (const p of ['loading', 'start', 'projects', 'app']) root.classList.toggle(`page-${p}`, p === name);
    document.querySelector(LOCAL_ID || ONLINE_ID ? '.edit-bar' : CLOUD ? '.home-bar' : '.app-head')?.append(accountWrap); // (the top bar: All projects', or the project's)
    if (name !== 'app') document.title = 'WorkNest';
  }

  // ---- The start page: signing in ----
  function drawStart(step = 'signin', opts = {}) {
    startCard.innerHTML = step === 'sent' ? `
        <h2>Check your email</h2>
        <p>We sent a sign-in link to <b>${esc(opts.email)}</b>. Open it on this device to sign in.
           It can take a minute; also look in your spam folder.</p>
        <button type="button" class="start-again">Use another email</button>`
      : step === 'confirm' ? `
        <h2>Confirm your email</h2>
        <p>You opened the sign-in link in a different browser or on another device. Type the email address it was sent to.</p>
        <form class="start-row start-confirm">
          <input type="email" required placeholder="Your email address" autocomplete="email" aria-label="Your email address">
          <button class="start-primary">Sign in</button>
        </form>
        <div class="error">${esc(opts.error || '')}</div>`
      : `
        <h2>${ONLINE_ID ? 'Sign in to open the project shared with you' : 'Sign in'}</h2>
        <button type="button" class="start-google">Sign in with Google</button>
        ${ONLINE_ID || !GOOGLE_ONLY ? `
        <div class="cloud-or"><span>or with your email</span></div>
        <form class="start-row start-email">
          <input type="email" required placeholder="Your email address" autocomplete="email" aria-label="Your email address"
                 value="${esc(read(EMAIL_KEY) || '')}">
          <button class="start-primary">Email me a link</button>
        </form>` : `
        <p class="start-note">Got a link to a shared project? Open that link to sign in with your email instead.</p>`}
        <div class="error">${esc(opts.error || '')}</div>
        ${onThisComputer ? `<div class="start-testing"><button type="button" class="start-test">Test mode</button>
          <span>Only here on your computer: example projects, no sign-in, nothing saved online.</span></div>` : ''}`;
    // (Projects are created with a Google account; signing in with a link emailed
    // to you is only for opening a project shared with you.)
  }
  const startError = text => { const el = startCard.querySelector('.error'); if (el) el.textContent = text; };

  startCard.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('.start-again')) return drawStart();
    if (b.matches('.start-google')) {
      b.disabled = true;
      try { await cloud.signInWithGoogle(); }
      catch (err) { if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') startError(signInError(err)); }
      b.disabled = false;
    }
  });
  startCard.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    const email = f.querySelector('input').value.trim().toLowerCase();
    btn.disabled = true;
    if (f.matches('.start-email')) {
      try {
        await cloud.sendLink(email, ONLINE_ID ? projectUrl(ONLINE_ID) : location.origin + location.pathname);
        store(EMAIL_KEY, email);
        drawStart('sent', { email });
      } catch (err) { startError(signInError(err)); btn.disabled = false; }
    }
    if (f.matches('.start-confirm')) await finishLink(email);
  });

  function signInError(err) {
    console.error(err);
    const code = err && err.code || '';
    if (code === 'auth/invalid-email') return 'That doesn\'t look like an email address.';
    if (code === 'auth/quota-exceeded') return 'Too many sign-in emails were sent today. Try again tomorrow, or sign in with Google.';
    if (code === 'auth/operation-not-allowed') return 'This way of signing in isn\'t turned on in Firebase yet (see the README).';
    if (code === 'auth/unauthorized-domain' || code === 'auth/unauthorized-continue-uri') return 'This website isn\'t on Firebase\'s list of authorised domains yet (see the README).';
    if (code === 'auth/popup-blocked') return 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') return 'That sign-in link has expired or was already used. Send yourself a new one.';
    return 'Signing in didn\'t work. Please try again.';
  }

  // Back from an emailed sign-in link: sign in, then drop the link's codes from the address
  async function finishLink(email) {
    try {
      await cloud.finishLink(email, location.href);
      store(EMAIL_KEY, null);
    } catch (err) {
      drawStart(err.code === 'auth/invalid-email' ? 'confirm' : 'signin', { error: signInError(err) });
      showPage('start');
    }
    linking = false;
    history.replaceState(null, '', location.pathname + (ONLINE_ID ? `?p=${ONLINE_ID}` : ''));
  }

  // ---- Your projects ----
  // One page: + New project, and all your projects in one timeline (the search
  // box at the top narrows the projects to add). Each project has a ⋮ menu:
  // Open, Label…, Share… / Move online…, Delete…. (Signed in with an emailed link
  // while GOOGLE_ONLY is on: only the projects shared with you, no new ones.)
  const pref = key => TEST_MODE ? `worknest-test:${key}` : key; // (test mode keeps its own settings)
  let homeOnline = null;   // the online projects once loaded ([{ id, name, mine, owner, viewers, updated, data }]), or 'error'
  const homeMain = document.getElementById('homeMain');
  const searchEl = document.getElementById('projectSearch');
  const tileMenu = document.getElementById('tileMenu');
  // Where a project is kept, as an icon (in the timeline, and in the comparison)
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const KIND_ICONS = {
    online: `<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18z" ${stroke}/>`,
    local: `<rect x="3" y="4" width="18" height="12" rx="2" ${stroke}/><path d="M8 20h8M12 16v4" ${stroke}/>`,
    shared: `<circle cx="9" cy="8" r="3.5" ${stroke}/><path d="M2.5 20a6.5 6.5 0 0 1 13 0" ${stroke}/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" ${stroke}/>`,
  };
  const KIND_NAMES = { online: 'Online', local: 'On this computer', shared: 'Shared with you' };
  const iconOf = kind => `<svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-label="${KIND_NAMES[kind]}"><title>${KIND_NAMES[kind]}</title>${KIND_ICONS[kind]}</svg>`;
  const guestMode = () => GOOGLE_ONLY && !user.google;
  const parseData = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };
  const keyOf = p => `${p.kind}:${p.id}`;

  // ---- Labels ----
  // Yours only (saved with your account, not with the projects, so the people
  // you share with don't see them): { labels: [{ id, name, color }],
  // projectLabels: { '<kind>:<project id>': label id } }. A project's colour in
  // the timeline is its label's, and projects are listed by label.
  let mine = { labels: [], projectLabels: {}, presets: [] }; // (presets: presets.js)
  const TIP_KEY = 'worknest-labels-tip-hidden'; // (the labels tip on All projects, closed)
  let labelsState = 'loading'; // 'loading' | 'ok' | 'error' (e.g. the database rules aren't updated yet)
  const LABEL_COLORS = ['#ff6b4a', '#ffc145', '#b8b5ff', '#3fb6a8', '#4f8ff7', '#f06fa8', '#6cc070', '#8a8fa8'];
  const NO_LABEL_COLOR = '#c9cad3';
  const sortedLabels = () => [...mine.labels].sort((a, b) => a.name.localeCompare(b.name));
  const labelOf = p => mine.labels.find(l => l.id === mine.projectLabels[keyOf(p)]) || null;
  const dot = color => `<i class="dot" style="--label:${color}"></i>`;
  const nextColor = () => LABEL_COLORS.find(c => !mine.labels.some(l => l.color === c)) || LABEL_COLORS[mine.labels.length % LABEL_COLORS.length];
  async function saveMine() {
    try { await cloud.saveMine(user.uid, mine); }
    catch (err) {
      console.error(err);
      showCloud('error', { message: 'Your labels couldn\'t be saved. Check your connection, and that the database rules are up to date (see the README).' });
    }
  }
  // Projects in label order (labels by name, then those without one)
  const byLabel = list => [...sortedLabels().flatMap(l => list.filter(p => labelOf(p)?.id === l.id)), ...list.filter(p => !labelOf(p))];

  async function drawProjects() {
    document.getElementById('projectsPage').classList.toggle('guest', guestMode());
    homeOnline = null;
    drawHome();
    const [list, saved] = await Promise.all([
      cloud.listProjects(user.email).catch(err => { console.error(err); return 'error'; }),
      cloud.getMine(user.uid).then(d => { labelsState = 'ok'; return d || {}; }, err => { console.error(err); labelsState = 'error'; return {}; }),
    ]);
    homeOnline = list;
    mine = { labels: Array.isArray(saved.labels) ? saved.labels : [], projectLabels: saved.projectLabels || {},
             presets: Array.isArray(saved.presets) ? saved.presets : [] };
    drawHome();
    window.drawPresets?.(); // (your presets, for the presets shelf)
    if (inEditor()) drawProjectColor(); // (the open project's label colour, for its dot and chip)
  }

  // All your projects (online, on this computer, shared with you), newest change first
  function allProjects() {
    const online = Array.isArray(homeOnline) ? homeOnline.map(p => ({ ...p, kind: p.mine ? 'online' : 'shared', data: parseData(p.data) })) : [];
    const local = listLocal().map(p => ({ ...p, kind: 'local', data: readLocal(p.id) }));
    return [...online, ...local].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  function drawHome() {
    const q = searchEl.value.trim().toLowerCase();
    const everything = allProjects();
    const loading = homeOnline === null, failed = homeOnline === 'error';
    const nothing = !loading && !failed && !everything.length && !OPEN_ID;
    // The title; the buttons are in a toolbar between the chips and the timeline
    const title = `<div class="home-titlebar"><h1 class="home-title">All projects</h1></div>`;
    if (nothing) {
      homeMain.innerHTML = title + `
        <div class="home-empty"><img class="brand-logo" src="worknest-mark.svg" alt="">
          <h2>Start your first project</h2>
          <p>Plan it as a timeline, then share it with your customer to talk it through.</p>
          <button type="button" class="home-new-inline">+ New project</button></div>`;
      return;
    }
    // (until you have a label, or close the tip with its ✕)
    const tip = !loading && labelsState === 'ok' && !mine.labels.length && everything.length && read(TIP_KEY) !== '1'
      ? `<p class="home-tip">Tip: group your projects with <b>labels</b>, for example one per customer. Right-click a project's chip above the timeline (on a phone: press and hold it) and choose <b>Label…</b>.
          <button type="button" class="tip-close" title="Hide this tip" aria-label="Hide this tip">✕</button></p>` : '';
    const note = labelsState === 'error' ? '<p class="home-tip">Labels need the updated database rules (see the README).</p>' : '';
    homeMain.innerHTML = title + tip + note + '<div class="combo" id="combo"></div>';
    homeMain.querySelector('.tip-close')?.addEventListener('click', () => { store(TIP_KEY, '1'); drawHome(); });
    drawCombo(everything, q, loading, failed);
  }

  // ---- All projects and the editor, on one page ----
  // Every project has a chip in the overview bar (with + New project after them):
  // filled in its colour when it's shown in the overview under it (combined.js),
  // dashed when it isn't. Click a chip to show or hide it. Its pen (an eye for
  // a project shared with you) opens the project on its own page (?p= / ?local=),
  // where its chip is the title of the edit bar: click it to come back. Right-click / press and
  // hold a chip for its menu. All projects looks the same whether a project is open
  // or not; the open project's editor is under it, and they scroll together.
  const PICK_KEY = pref('simple-gantt-combined'), VIEW_KEY_COMBO = pref('simple-gantt-combined-view');
  const OV_KEY = pref('worknest-overview-collapsed');
  const OPEN_ID = LOCAL_ID || ONLINE_ID;              // (the project open in the editor, if any)
  const inEditor = () => root.classList.contains('page-app');
  let comboList = []; // the projects as listed (label order)
  let ovProjects = []; // the projects drawn in the overview
  // ‹ [Week ▾] ›, as in a project: Day / Week / Month / Quarter show exactly that
  // period across the timeline, ‹ › step one period, Overview fits all the
  // projects on it (pick it again to go back), Today goes to today's period
  const VIEW_NAMES = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', overview: 'Overview' };
  let comboView = VIEW_NAMES[read(VIEW_KEY_COMBO)] ? read(VIEW_KEY_COMBO) : 'month';
  let comboBack = comboView === 'overview' ? 'month' : comboView; // (the view to go back to from Overview)
  let comboDate = todayString(); // a day in the period shown
  let comboJump = true;          // the next drawing goes to the period (on opening, and after ‹ › Today or a new view)
  const picked = () => { try { const v = JSON.parse(read(PICK_KEY)); return Array.isArray(v) ? new Set(v) : null; } catch { return null; } };
  const isOn = p => { const chosen = picked(); return !chosen || chosen.has(keyOf(p)); }; // (nothing chosen yet: all)
  const hrefOf = p => `${p.kind === 'local' ? '?local=' : '?p='}${encodeURIComponent(p.id)}`;
  // The key of the open project's chip
  const editKey = () => {
    if (!OPEN_ID) return null;
    const p = comboList.find(x => x.id === OPEN_ID && (LOCAL_ID ? x.kind === 'local' : x.kind !== 'local'));
    return p ? keyOf(p) : `${LOCAL_ID ? 'local' : isOwner() ? 'online' : 'shared'}:${OPEN_ID}`;
  };
  const chipTitle = p => `${p.name || 'Untitled'}${labelOf(p) ? ` (${labelOf(p).name})` : ''}${p.kind === 'shared' ? ' (shared with you: view only)' : ''}\n${isOn(p)
    ? 'In the overview. Click to hide it.' : 'Not in the overview. Click to show it there.'} The ${p.kind === 'shared' ? 'eye opens it (view only)' : 'pen opens it for editing'}.${p.kind === 'shared' ? '' : ' Double-click to rename it.'} Right-click or press and hold for more.`;
  const PEN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const EYE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const NO_LABEL_BAR = '#9a9aa0'; // (a project without a label: grey, on its chip and its bars)
  const barColorOf = p => p.data?.color || labelOf(p)?.color || NO_LABEL_BAR; // (the colour chosen on the project page, or its label's)

  // ‹ [Month ▾] › and Today. The menu also has Show all
  // projects and Clear the timeline.
  function comboNav() {
    return `<div class="combo-navgroup">
        <div class="view-nav combo-nav" role="group" aria-label="View">
          <button type="button" class="nav-arrow" data-step="-1" title="Previous ${comboView === 'overview' ? 'screen' : comboView}" aria-label="Previous">‹</button>
          <div class="menu-wrap">
            <button type="button" class="combo-view-btn" aria-haspopup="menu" aria-expanded="false" title="Choose what the timeline shows">${VIEW_NAMES[comboView]} ▾</button>
            <div class="menu view-menu combo-view-menu" role="menu" hidden>
              ${['day', 'week', 'month', 'quarter'].map(v => `<button type="button" role="menuitemradio" data-cview="${v}"${v === comboView ? ' class="active"' : ''}>${VIEW_NAMES[v]}</button>`).join('')}
              <hr>
              <button type="button" role="menuitemcheckbox" data-cview="overview"${comboView === 'overview' ? ' class="active"' : ''} title="Fit all the projects on the timeline (pick again to go back)">Overview</button>
              <hr>
              <button type="button" role="menuitem" data-pick="all">Show all in the overview</button>
              <button type="button" role="menuitem" data-pick="none">Hide all</button>
            </div>
          </div>
          <button type="button" class="nav-arrow" data-step="1" title="Next ${comboView === 'overview' ? 'screen' : comboView}" aria-label="Next">›</button>
        </div>
        <button type="button" class="combo-today" title="Go to today">Today</button>
      </div>`;
  }

  // The soft tint behind each label's chips on All projects: one rounded block for
  // each line its chips are on (redrawn when the width changes)
  let tintWatch = null;
  function drawLabelTints() {
    const box = homeMain.querySelector('.label-flow'), svg = box?.querySelector('.label-tints');
    if (!svg) return;
    tintWatch ||= new ResizeObserver(() => drawLabelTints());
    if (!box.dataset.watched) { tintWatch.disconnect(); tintWatch.observe(box); box.dataset.watched = '1'; }
    const b = box.getBoundingClientRect();
    svg.setAttribute('width', b.width); svg.setAttribute('height', b.height);
    const groups = new Map();
    for (const el of box.querySelectorAll('[data-lg]')) {
      const r = el.getBoundingClientRect(), g = el.dataset.lg;
      if (!r.width) continue;
      if (!groups.has(g)) groups.set(g, { color: getComputedStyle(el).getPropertyValue('--label').trim(), lines: [] });
      const lines = groups.get(g).lines, x = { l: r.left - b.left, r: r.right - b.left, t: r.top - b.top, b: r.bottom - b.top };
      const line = lines.find(y => Math.abs(y.t - x.t) < 4);
      if (line) { line.l = Math.min(line.l, x.l); line.r = Math.max(line.r, x.r); line.b = Math.max(line.b, x.b); } else lines.push(x);
    }
    const P = 7;
    svg.innerHTML = [...groups.values()].flatMap(({ color, lines }) => lines.map(x =>
      `<rect x="${x.l - P}" y="${x.t - P}" width="${x.r - x.l + 2 * P}" height="${x.b - x.t + 2 * P}" rx="12" fill="${color}" fill-opacity=".13"/>`)).join('');
  }

  // Renaming on All projects: a project (double-click its chip) or a label (click its
  // name). The name becomes editable right there: Enter saves, Esc cancels.
  let renamingChip = false;
  function editInPlace(el, done) {
    renamingChip = true;
    const before = el.textContent;
    el.contentEditable = 'plaintext-only';
    el.focus();
    getSelection().selectAllChildren(el);
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      renamingChip = false;
      el.contentEditable = 'false';
      const name = el.textContent.replace(/\s+/g, ' ').trim();
      if (!save || !name || name === before) { el.textContent = before; return drawHome(); }
      done(name);
    };
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    el.addEventListener('blur', () => finish(true), { once: true });
  }
  async function renameProject(key, name) {
    const p = comboList.find(x => keyOf(x) === key);
    if (!p || p.kind === 'shared') return drawHome();
    try {
      if (p.kind === 'local') { const d = readLocal(p.id); if (d) writeLocal(p.id, { ...d, name }, Date.now()); }
      else {
        await cloud.saveProject(p.id, { name });
        const o = Array.isArray(homeOnline) && homeOnline.find(x => x.id === p.id);
        if (o) o.name = name;
      }
    } catch (err) {
      console.error(err);
      showCloud('error', { message: 'Couldn\'t rename the project. Check your connection and try again.' });
    }
    drawHome();
  }
  function renameLabel(id, name) {
    const l = mine.labels.find(x => x.id === id);
    if (!l) return drawHome();
    l.name = name;
    drawHome(); saveMine();
  }
  homeMain.addEventListener('dblclick', e => {
    const chip = e.target.closest('.label-flow .pick[data-key]');
    if (!chip || e.target.closest('.pick-edit') || renamingChip) return;
    clearTimeout(chipClickTimer);
    const p = comboList.find(x => keyOf(x) === chip.dataset.key);
    if (!p || p.kind === 'shared') return;
    e.preventDefault();
    editInPlace(chip.querySelector('.pick-name'), name => renameProject(chip.dataset.key, name));
  });
  homeMain.addEventListener('click', e => {
    const nameEl = e.target.closest('.label-name[data-label-rename]');
    if (nameEl && !renamingChip) return editInPlace(nameEl, name => renameLabel(nameEl.dataset.labelRename, name));
    const dot = e.target.closest('.label-dot[data-label-color]');
    if (dot) return openLabelColor(dot.dataset.labelColor, dot);
  });

  // A label's colour: its dot opens a picker (the label colours, any colour, or a hex code)
  const labelPop = document.createElement('div');
  labelPop.className = 'menu color-pop label-color-pop';
  labelPop.setAttribute('role', 'dialog');
  labelPop.setAttribute('aria-label', "The label's colour");
  labelPop.hidden = true;
  labelPop.innerHTML = `<p class="color-pop-head">Label colour</p>
    <div class="color-swatches">${LABEL_COLORS.map(col => `<button type="button" data-lcolor="${col}" style="--c:${col}" aria-label="${col}" title="${col}"></button>`).join('')}</div>
    <div class="color-custom">
      <input type="color" class="lc-native" title="Pick any colour" aria-label="Pick any colour">
      <input class="lc-hex" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#4f8ff7" aria-label="Colour as a hex code" title="A hex code, like #4f8ff7">
    </div>`;
  document.body.append(labelPop);
  let labelPopFor = null;
  function openLabelColor(id, dot) {
    const l = mine.labels.find(x => x.id === id);
    if (!l) return;
    if (!labelPop.hidden && labelPopFor === id) { labelPop.hidden = true; return; }
    labelPopFor = id;
    for (const b of labelPop.querySelectorAll('[data-lcolor]')) b.classList.toggle('on', b.dataset.lcolor === l.color);
    labelPop.querySelector('.lc-native').value = /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#4f8ff7';
    labelPop.querySelector('.lc-hex').value = l.color;
    labelPop.hidden = false;
    const r = dot.getBoundingClientRect();
    labelPop.style.left = `${Math.max(8, Math.min(r.left - 8, innerWidth - labelPop.offsetWidth - 8))}px`;
    labelPop.style.top = `${Math.min(r.bottom + 8, innerHeight - labelPop.offsetHeight - 8)}px`;
  }
  let labelColorTimer = null;
  function setLabelColor(color, close) {
    const l = mine.labels.find(x => x.id === labelPopFor);
    if (!l) return;
    l.color = color;
    drawHome();
    clearTimeout(labelColorTimer); // (saved once you stop picking)
    labelColorTimer = setTimeout(saveMine, 600);
    if (close) labelPop.hidden = true;
  }
  labelPop.addEventListener('click', e => { const b = e.target.closest('[data-lcolor]'); if (b) setLabelColor(b.dataset.lcolor, true); });
  labelPop.querySelector('.lc-native').addEventListener('input', e => { setLabelColor(e.target.value.toLowerCase()); labelPop.querySelector('.lc-hex').value = e.target.value.toLowerCase(); });
  labelPop.querySelector('.lc-hex').addEventListener('input', e => {
    const v = e.target.value.trim(), m = v.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (m) { const h = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1]; setLabelColor('#' + h.toLowerCase()); }
  });
  document.addEventListener('pointerdown', e => { if (!labelPop.hidden && !e.target.closest('.label-color-pop, .label-dot')) labelPop.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !labelPop.hidden) labelPop.hidden = true; });

  // The sidebar on a project's page: your projects (the open one highlighted), to switch
  function drawSideNav() {
    const box = document.getElementById('sideProjects');
    if (!box) return;
    const ek = editKey();
    const item = p => `<a class="side-proj${keyOf(p) === ek ? ' on' : ''}" href="${esc(hrefOf(p))}" style="--dot:${barColorOf(p)}"
        ${keyOf(p) === ek ? 'aria-current="page"' : ''} title="${esc(p.name || 'Untitled')}${p.kind === 'shared' ? ' (shared with you: view only)' : p.kind === 'local' ? ' (on this computer only)' : ''}">
        <i aria-hidden="true"></i><span>${esc(p.name || 'Untitled')}</span>${p.kind === 'shared' ? EYE_ICON : ''}</a>`;
    // Grouped by label, as on All projects: each label's name (with its colour), then its
    // projects; projects without a label after them
    const groups = sortedLabels().map(l => ({ l, ps: comboList.filter(p => labelOf(p)?.id === l.id) })).filter(g => g.ps.length);
    const loose = comboList.filter(p => !labelOf(p));
    box.innerHTML = groups.map(({ l, ps }) => `<div class="side-group" style="--label:${l.color}">
        <div class="side-label">${esc(l.name)}</div>${ps.map(item).join('')}</div>`).join('')
      + (loose.length ? `<div class="side-group side-loose${groups.length ? ' after' : ''}">${loose.map(item).join('')}</div>` : '')
      || '<p class="side-empty">Loading…</p>';
  }

  document.getElementById('sideNewProject')?.addEventListener('click', () => showCloud('newproject'));

  function drawCombo(everything, q, loading, failed) {
    const el = document.getElementById('combo');
    comboList = byLabel(everything);
    const ek = editKey(), match = p => (p.name || '').toLowerCase().includes(q);
    const chip = (p, lg = '', last = false) => `<span class="pick${isOn(p) ? ' on' : ''}${last ? ' lg-last' : ''}" data-key="${esc(keyOf(p))}"${lg ? ` data-lg="${esc(lg)}"` : ''} style="--label:${barColorOf(p)}" title="${esc(chipTitle(p))}"
      role="button" tabindex="0"><span class="pick-name">${esc(p.name || 'Untitled')}</span><button type="button" class="pick-edit" data-key="${esc(keyOf(p))}"
      title="${p.kind === 'shared' ? 'View' : 'Edit'} ${esc(p.name || 'Untitled')}" aria-label="${p.kind === 'shared' ? 'View' : 'Edit'} ${esc(p.name || 'Untitled')}">${p.kind === 'shared' ? EYE_ICON : PEN_ICON}</button></span>`;
    const others = comboList.filter(p => keyOf(p) !== ek);
    const shown = others.filter(isOn);
    // Grouped by label: a white label chip (its colour dot, its name), then its projects,
    // on a soft tint of its colour (drawn per line, see drawLabelTints); projects without
    // a label after them, on their own
    const listed = others.filter(match);
    const labelChip = l => `<span class="label-chip" data-lg="${esc(l.id)}" style="--label:${l.color}">
        <button type="button" class="label-dot" data-label-color="${esc(l.id)}" title="Change the label's colour" aria-label="Change the colour of ${esc(l.name)}"></button><span class="label-name" data-label-rename="${esc(l.id)}" title="Click to rename the label">${esc(l.name)}</span></span>`;
    const chipsHtml = sortedLabels().map(l => {
      const ps = listed.filter(x => labelOf(x)?.id === l.id);
      return ps.map((x, i) => i === 0 ? `<span class="keep">${labelChip(l)}${chip(x, l.id, ps.length === 1)}</span>` : chip(x, l.id, i === ps.length - 1)).join('');
    }).join('') + listed.filter(x => !labelOf(x)).map(x => chip(x)).join('');
    const collapsed = read(OV_KEY) === '1';
    el.innerHTML = `
      <div class="overview${collapsed ? ' collapsed' : ''}" data-drop="overview">
        <div class="overview-bar">
          <button type="button" class="ov-toggle${collapsed ? ' shut' : ''}" aria-expanded="${!collapsed}" title="${collapsed ? 'Show' : 'Hide'} the project chips (the timeline stays)"><svg class="chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Overview</span>${collapsed ? `<small class="ov-count">${listed.length} project${listed.length === 1 ? '' : 's'}</small>` : ''}</button>
          <div class="overview-chips label-flow"><svg class="label-tints" aria-hidden="true"></svg>${chipsHtml
            || `<span class="zone-hint">${loading ? '' : q && others.length ? 'No projects match your search.' : ''}</span>`}
            <button type="button" id="newProjectBtn" class="new-pick">+ New project</button></div>
        </div>
        <!-- (the timeline's own buttons, right on top of it) -->
        <div class="ov-tools" role="toolbar" aria-label="Timeline">
          <button type="button" class="ov-today" title="Go to today's period on the timeline">Today</button>
          <button type="button" class="ov-fit${comboView === 'overview' && !ovZoom ? ' active' : ''}" aria-pressed="${comboView === 'overview' && !ovZoom}"
            title="Zoom out until every project shown fits on the timeline (click again to go back)">Zoom to fit</button>
        </div>
        <div class="combo-chart"></div>
      </div>
`;
    drawEditChip();
    drawSideNav();
    drawLabelTints();
    const chart = el.querySelector('.combo-chart');
    ovProjects = shown.map(p => ({
      key: keyOf(p), name: p.name || 'Untitled', color: barColorOf(p), label: labelOf(p)?.name || '',
      tasks: p.data && Array.isArray(p.data.tasks) ? p.data.tasks : [], groupColors: (p.data && p.data.groupColors) || {},
    }));
    if (loading || failed) {
      chart.innerHTML = `<p class="home-note">${loading ? 'Loading…' : 'Your online projects couldn\'t be loaded. Check your connection and reload the page.'}</p>`;
      return;
    }
    if (!shown.length) { chart.innerHTML = '<p class="home-note combo-empty">Click a project\'s chip to see it in the overview.</p>'; return; }
    // On its own: the days to fit across the timeline: the period, or (Overview) all the projects with a day either side
    let from, to;
    if (comboView === 'overview') {
      const dated = ovProjects.flatMap(p => p.tasks).filter(t => t.start && t.end);
      const today = dayNumber(parse(todayString()));
      from = (dated.length ? Math.min(...dated.map(t => dayNumber(parse(t.start)))) : today) - 1;
      to = (dated.length ? Math.max(...dated.map(t => dayNumber(parse(t.end)))) : today + 27) + 1;
    } else {
      const p = periodOf(comboView, comboDate);
      from = dayNumber(parse(p.start)); to = dayNumber(parse(p.end));
    }
    if (ovZoom && following()) { // lined up with the editor: its zoom, and the days before its timeline too
      const lead = Math.ceil((chartEl.getBoundingClientRect().left + labelsW() - chart.getBoundingClientRect().left) / renderedDayW) + 1;
      const eFrom = dayNumber(chartStart), eTo = eFrom + Math.round(chartEl.querySelector('.track').offsetWidth / renderedDayW);
      drawCombined(chart, ovProjects, renderedDayW, { from: eFrom - lead, to: eTo });
      followChart();
      return;
    }
    const dayW = Math.max(2, ((chart.clientWidth || 800) - 2) / (to - from + 1));
    drawCombined(chart, ovProjects, dayW, comboJump ? { from, to } : null);
    comboJump = false;
  }

  // While a project is open (on a computer), the overview and the editor scroll
  // together. Normally each keeps its own zoom, and the day at the left edge of the
  // one is kept at the left edge of the other. After Today or Fit they're lined up:
  // the overview takes the editor's zoom and each day (and the red today line) sits
  // right above the same day in the editor; as the overview is wider (no task list),
  // it shows more of the days before. That lasts until the overview's own zoom is
  // changed (its ‹ [Month ▾] ›). On opening, the editor goes to the overview's day.
  const following = () => inEditor() && homeMain.offsetParent !== null && !turnedOn() && renderedDayW && chartStart && chartEl.querySelector('.track');
  let adopted = false; // (the editor has taken the overview's day, once, on opening)
  let ovZoom = null;   // the editor's zoom, while the overview is lined up with it
  const ovScroll = () => homeMain.querySelector('.combo-chart .combo-scroll');
  const ovLeftDay = s => +s.dataset.min / DAY + s.scrollLeft / +s.dataset.dayw;
  // How many days further left the overview starts than the editor's timeline, when lined up
  const ovLead = s => ovZoom && ovZoom === renderedDayW
    ? (chartEl.getBoundingClientRect().left + labelsW() - s.getBoundingClientRect().left) / renderedDayW : 0;
  // The editor moved: the overview moves along
  function followChart() {
    const s = ovScroll();
    if (!s || !following()) return;
    if (!adopted) { adopted = true; if (!ovZoom) return window.onCombinedScroll(ovLeftDay(s)); }
    const day = getScrollDay() - ovLead(s);
    if (Math.abs(ovLeftDay(s) - day) * +s.dataset.dayw > 1) scrollCombinedToDay(homeMain.querySelector('.combo-chart'), day);
  }
  // The overview moved: the editor moves along
  window.onCombinedScroll = day => {
    const s = ovScroll();
    if (!following() || chipDrag || !s) return;
    const target = (day + ovLead(s) - dayNumber(chartStart)) * renderedDayW;
    if (Math.abs(chartEl.scrollLeft - target) > 1) chartEl.scrollLeft = target;
  };
  // Today or Fit in the editor: the overview lines up with it
  function alignOverview() {
    if (!following() || read(OV_KEY) === '1') return;
    ovZoom = renderedDayW;
    adopted = true;
    drawHome();
  }
  function afterRender() {
    document.getElementById('overviewBtn')?.classList.toggle('active', !!overviewReturn);
    if (ovZoom && following() && ovZoom !== renderedDayW) alignOverview(); // (still lined up: the editor zoomed)
  }

  // The edit bar's chip: the open project's (its colour comes from app.js)
  function drawEditChip() {
    const chip = document.querySelector('.edit-chip');
    if (!chip || !OPEN_ID) return;
    chip.dataset.key = editKey();
    chip.title = readOnly ? `${projectName}\nRight-click or press and hold for more.` : `${projectName}\nClick to rename the project. Right-click or press and hold for more.`;
  }

  // A new window size: the period fits again (the timeline stays where it is)
  let resizeTimer = null;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!chipDrag && (root.classList.contains('page-projects') || inEditor())) drawHome(); }, 150);
  });

  // ‹ and ›: one period back or forward (one screen in Overview)
  function comboStep(dir) {
    ovZoom = null; // (its own zoom again)
    if (comboView === 'overview') {
      const s = homeMain.querySelector('.combo-scroll');
      if (s) s.scrollBy({ left: dir * s.clientWidth });
      return;
    }
    const d = parse(comboDate), y = d.getUTCFullYear(), m = d.getUTCMonth();
    comboDate = fmt(comboView === 'day' ? new Date(+d + dir * DAY) : comboView === 'week' ? new Date(+d + dir * 7 * DAY)
      : new Date(Date.UTC(y, m + dir * (comboView === 'month' ? 1 : 3), 1)));
    comboJump = true;
    drawHome();
  }
  function setComboView(v) {
    ovZoom = null;
    if (v === 'overview' && comboView === 'overview') v = comboBack; // (Overview again: back to where you were)
    else if (v === 'overview') comboBack = comboView;
    comboView = v;
    store(VIEW_KEY_COMBO, v);
    comboJump = true;
    drawHome();
  }
  const comboMenu = () => homeMain.querySelector('.combo-view-menu');
  function showComboMenu(open) {
    const menu = comboMenu();
    if (!menu) return;
    menu.hidden = !open;
    homeMain.querySelector('.combo-view-btn').setAttribute('aria-expanded', open);
    if (open) (menu.querySelector('.active') || menu.querySelector('button')).focus();
  }
  document.addEventListener('pointerdown', e => { if (comboMenu() && !comboMenu().hidden && !e.target.closest('.combo-nav .menu-wrap')) showComboMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && comboMenu() && !comboMenu().hidden) { showComboMenu(false); homeMain.querySelector('.combo-view-btn').focus(); } });

  // Choosing what the timeline shows
  function setShown(key, on, redraw = true) {
    const chosen = picked() || new Set(comboList.map(keyOf)); // (all of them, until you choose)
    on ? chosen.add(key) : chosen.delete(key);
    store(PICK_KEY, JSON.stringify([...chosen]));
    if (redraw) drawHome(); // (its chip moves; the timeline keeps its place)
  }
  // Moves a project's chip to 'shelf' (not shown), 'overview' or 'edit' (opens it
  // in the editor; the one open there goes into the overview). Moving the open
  // project's chip away closes the editor (Leaving asks first about unsaved changes).
  function moveChip(key, to) {
    const p = comboList.find(x => keyOf(x) === key), open = key === editKey();
    if (to === 'edit') { if (!open && p) location.href = location.pathname + hrefOf(p); return; } // (its own page)
    if (open) return goHome(); // (back to All projects; its chip stays where it was)
    setShown(key, to === 'overview');
  }

  // A chip (in the All projects area, or the edit bar): click it to move it (on
  // the shelf into the overview; in the overview, or the edit bar, back to the
  // shelf), its pen (or eye) opens it in the editor; right-click or press and hold
  // for its menu. (Pointer events, so it works with a finger too.)
  let chipDrag = null; // { chip, key, x, y, held, timer } while a chip is pressed
  const chipAt = e => !e.target.closest?.('.project-dot-wrap') && e.target.closest?.('#homeMain .pick[data-key], .edit-chip[data-key]'); // (not its colour dot)
  let chipClickTimer = null; // (a single click on All projects, waiting to see if it's a double-click)
  const nameEditing = () => nameEl.isContentEditable;
  document.addEventListener('pointerdown', e => {
    const chip = chipAt(e);
    if (!chip || e.button !== 0 || nameEditing() || e.target.closest('.pick-edit')) return;
    const d = chipDrag = { chip, key: chip.dataset.key, x: e.clientX, y: e.clientY, held: false };
    d.timer = setTimeout(() => { // pressed and held without moving: its menu
      if (chipDrag !== d) return;
      d.held = true;
      navigator.vibrate?.(15);
      openProjectMenu(d.key, chip);
    }, 550);
  });
  document.addEventListener('pointermove', e => { // (moving away: not a press and hold)
    const d = chipDrag;
    if (d && !d.held && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) { clearTimeout(d.timer); chipDrag = null; }
  });
  function endChipPress() {
    const d = chipDrag;
    if (!d) return;
    chipDrag = null;
    clearTimeout(d.timer);
    if (d.held) { // (the click that follows isn't a move)
      d.chip.dataset.dragged = '1';
      setTimeout(() => delete d.chip.dataset.dragged, 0);
    }
  }
  document.addEventListener('pointerup', endChipPress);
  document.addEventListener('pointercancel', endChipPress);
  document.addEventListener('contextmenu', e => { // right-click on a chip: its menu
    const chip = chipAt(e);
    if (!chip || nameEditing()) return;
    e.preventDefault();
    if (!chipDrag?.held) openProjectMenu(chip.dataset.key, chip);
  });
  // (the project's own name in its top bar: click it to rename the project; "WorkNest /" goes back)
  const clickChip = chip => chip.classList.contains('edit-chip') ? startProjectRename()
    : moveChip(chip.dataset.key, chip.closest('.overview-chips') && !chip.classList.contains('on') ? 'overview' : 'shelf');
  document.addEventListener('click', e => {
    const pen = e.target.closest?.('#homeMain .pick-edit'); // the pen / eye: into the editor
    if (pen) return moveChip(pen.dataset.key, 'edit');
    const chip = chipAt(e);
    if (!chip || chip.dataset.dragged || nameEditing() || renamingChip || e.target.isContentEditable) return;
    if (chip.closest('#homeMain')) { // (on All projects: a double-click renames, so wait a moment)
      clearTimeout(chipClickTimer);
      if (e.detail > 1) return;
      chipClickTimer = setTimeout(() => clickChip(chip), 240);
      return;
    }
    clickChip(chip);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'F2' && e.target.matches?.('#homeMain .label-flow .pick[data-key]') && !renamingChip) { // F2: rename it
      const p = comboList.find(x => keyOf(x) === e.target.dataset.key);
      if (p && p.kind !== 'shared') { e.preventDefault(); return editInPlace(e.target.querySelector('.pick-name'), name => renameProject(p.id && keyOf(p), name)); }
    }
    const chip = (e.key === 'Enter' || e.key === ' ') && !nameEditing() && !renamingChip && e.target.matches?.('#homeMain .pick[data-key], .edit-chip[data-key]') && e.target;
    if (!chip) return;
    e.preventDefault();
    clickChip(chip);
  });

  homeMain.addEventListener('click', e => {
    if (e.target.closest('#newProjectBtn, .home-new-inline')) return showCloud('newproject');
    const tog = e.target.closest('.ov-toggle'); // ∨ Overview: fold the overview away, or open it
    if (tog) { store(OV_KEY, read(OV_KEY) === '1' ? null : '1'); return drawHome(); }
    const period = e.target.closest('.combo-headwrap [data-view][data-date]'); // a quarter / month / week / day in its dates
    if (period) {
      ovZoom = null;
      comboView = period.dataset.view; comboDate = period.dataset.date; store(VIEW_KEY_COMBO, comboView); comboJump = true;
      return drawHome();
    }
    if (e.target.closest('.combo-view-btn')) return showComboMenu(comboMenu().hidden);
    const viewItem = e.target.closest('[data-cview]');
    if (viewItem) return setComboView(viewItem.dataset.cview);
    const stepBtn = e.target.closest('.combo-nav [data-step]');
    if (stepBtn) return comboStep(+stepBtn.dataset.step);
    if (e.target.closest('.combo-today, .ov-today') && following()) return document.getElementById('todayBtn').click(); // (both, lined up)
    if (e.target.closest('.ov-today')) { // (on its own: today's period)
      if (comboView === 'overview') return combinedToday(homeMain.querySelector('.combo-chart'));
      comboDate = todayString(); comboJump = true; return drawHome();
    }
    if (e.target.closest('.ov-fit')) return setComboView('overview'); // (fit its projects, or back again)
    if (e.target.closest('.combo-today')) {
      if (comboView === 'overview') return combinedToday(homeMain.querySelector('.combo-chart'));
      comboDate = todayString(); comboJump = true; return drawHome();
    }
    const pickAll = e.target.closest('[data-pick]');
    if (pickAll) { store(PICK_KEY, pickAll.dataset.pick === 'all' ? null : '[]'); return drawHome(); } // (Show all / Hide all)
  });
  searchEl.addEventListener('input', drawHome);
  // Pointing at a chip, or at one of its project's bars, brings out both: the
  // chip and all the project's bars stand out, the other chips and bars fade
  function focusProject(key) {
    const chart = homeMain.querySelector('.combo-chart'), pick = homeMain.querySelector('.overview-chips');
    chart?.classList.toggle('focusing', !!key);
    pick?.classList.toggle('focusing', !!key);
    for (const el of homeMain.querySelectorAll('.combo-lane, .overview-chips .pick')) el.classList.toggle('hl', !!key && el.dataset.key === key);
  }
  homeMain.addEventListener('pointerover', e => {
    const chip = e.target.closest('.overview-chips .pick');
    const lane = !chip && e.target.closest('.combo-lane .bar')?.closest('.combo-lane');
    focusProject((chip || lane)?.dataset.key || null);
  });
  homeMain.addEventListener('pointerleave', () => focusProject(null));


  // A project's ⋮ menu: Open, Label…; for yours, Share… / Move online…, and Delete…
  let menuFor = null;
  function openProjectMenu(key, anchor) {
    const p = comboList.find(x => keyOf(x) === key);
    if (!p) return;
    menuFor = { kind: p.kind, id: p.id, name: p.name || 'Untitled', key };
    const place = key === editKey() ? 'edit' : isOn(p) ? 'overview' : 'shelf'; // ('shelf': not shown)
    tileMenu.innerHTML = `${place === 'edit'
        ? `${readOnly ? '' : '<button type="button" data-act="rename">Rename…</button>'}<button type="button" data-act="close">Back to All projects</button>`
        : `<button type="button" data-act="edit">${p.kind === 'shared' ? 'Open (view only)' : 'Edit'}</button>
           <button type="button" data-act="${place === 'shelf' ? 'show' : 'hide'}">${place === 'shelf' ? 'Show in the overview' : 'Hide'}</button>`}
      <hr>
      ${labelsState === 'ok' ? '<button type="button" data-act="label">Label…</button>' : ''}
      ${p.kind === 'local' ? '<button type="button" data-act="move">Move online…</button>' : p.kind === 'online' ? '<button type="button" data-act="share">Share…</button>' : ''}
      ${p.kind === 'shared' ? '' : '<hr><button type="button" data-act="delete" class="danger">Delete…</button>'}`;
    tileMenu.hidden = false;
    const r = anchor.getBoundingClientRect(), w = tileMenu.offsetWidth, h = tileMenu.offsetHeight;
    tileMenu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    tileMenu.style.top = (r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4) + 'px';
    tileMenu.querySelector('button').focus();
  }
  const closeTileMenu = () => { tileMenu.hidden = true; };
  document.addEventListener('pointerdown', e => {
    if (!tileMenu.hidden && !tileMenu.contains(e.target) && !chipAt(e)) closeTileMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !tileMenu.hidden) closeTileMenu(); });
  addEventListener('scroll', closeTileMenu, true);
  tileMenu.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeTileMenu();
    const { kind, id, name, key } = menuFor;
    const where = kind === 'local' ? `?local=${encodeURIComponent(id)}` : `?p=${encodeURIComponent(id)}`;
    if (act === 'edit') return moveChip(key, 'edit');
    if (act === 'show') return moveChip(key, 'overview');
    if (act === 'hide' || act === 'close') return moveChip(key, 'shelf');
    if (act === 'rename') return startProjectRename();
    if (act === 'share' && key === editKey()) return showCloud('share');
    if (act === 'label') showCloud('label', { key: `${kind}:${id}`, name });
    if (act === 'share') location.href = `${location.pathname}${where}&share=1`;
    if (act === 'move') showCloud('moveonline', { id });
    if (act === 'delete') {
      const ok = await askConfirm(`Delete “${esc(name)}”?`, kind === 'local'
        ? 'It\'s deleted from this computer, and can\'t be brought back. (Use <b>Move online</b> instead to keep it.)'
        : 'The project and all its comments and images are deleted <b>for everyone</b>, and its link stops working. This can\'t be undone.', 'Delete');
      if (!ok) return;
      const forget = () => { if (mine.projectLabels[`${kind}:${id}`]) { delete mine.projectLabels[`${kind}:${id}`]; saveMine(); } };
      if (kind === 'local') { deleteLocal(id); forget(); return key === editKey() ? goHome() : drawHome(); }
      try { await cloud.deleteProject(id); forget(); if (key === editKey()) return goHome(); drawProjects(); }
      catch (err) { console.error(err); showCloud('error', { message: 'Couldn\'t delete the project. Check your connection and try again.' }); }
    }
  });

  // A new online project (opened when created)
  async function createAndOpen(name, data, btn) {
    btn.disabled = true;
    try {
      const id = await cloud.createProject({ name, data: JSON.stringify(data), owner: user.email });
      location.href = `${location.pathname}?p=${id}`;
      return true;
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      return false;
    }
  }
  // Moves a project from this computer online: a copy goes online, then the one
  // here is deleted
  async function moveOnline(id, btn) {
    const p = readLocal(id);
    if (!p) return false;
    btn.disabled = true;
    try {
      const newId = await cloud.createProject({ name: p.name, data: JSON.stringify({ tasks: p.tasks || [], groupColors: p.groupColors || {}, color: p.color || undefined }), owner: user.email });
      const label = mine.projectLabels[`local:${id}`]; // (it keeps its label)
      if (label) { delete mine.projectLabels[`local:${id}`]; mine.projectLabels[`online:${newId}`] = label; await saveMine(); }
      deleteLocal(id);
      location.href = `${location.pathname}?p=${newId}`;
      return true;
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      return false;
    }
  }

  // ---- Dialogs (sharing, problems) ----
  const screens = {
    newproject: () => `
      <h2>New project</h2>
      <form class="cloud-new">
        <input required maxlength="100" placeholder="Project name" aria-label="Project name" autocomplete="off">
        <div class="cloud-label">Where should it be saved?</div>
        <label class="cloud-choice"><input type="radio" name="where" value="online" checked>
          <span><b>Online</b> (recommended)<small>On all your devices, and you can share it with customers.</small></span></label>
        <label class="cloud-choice"><input type="radio" name="where" value="local">
          <span><b>On this computer only</b><small>In this browser only: not on your other devices, can't be shared,
            and lost if the browser's data is cleared. You can move it online later.</small></span></label>
        <p class="muted"><button type="button" class="link-like" data-diff>What's the difference?</button></p>
        <div class="error"></div>
        <div class="cloud-foot"><button type="button" class="cloud-close">Cancel</button><button class="primary">Create</button></div>
      </form>`,
    label: o => {
      const cur = mine.projectLabels[o.key] || '';
      const row = (id, color, name) => `<button type="button" class="label-pick${cur === id ? ' on' : ''}" data-set-label="${esc(id)}">
          ${dot(color)}<span>${esc(name)}</span>${cur === id ? '<b aria-label="chosen">✓</b>' : ''}</button>`;
      return `
        <h2>Label for “${esc(o.name)}”</h2>
        <p class="muted">Labels are yours: only you see them. Use them to group your projects, for example one per customer.</p>
        <div class="label-list">
          ${sortedLabels().map(l => `<div class="label-row">${row(l.id, l.color, l.name)}
            <button type="button" class="label-edit" data-edit-label="${esc(l.id)}" title="Edit label" aria-label="Edit ${esc(l.name)}">✎</button></div>`).join('')}
          <div class="label-row">${row('', NO_LABEL_COLOR, 'No label')}</div>
        </div>
        <form class="cloud-label-new">
          <div class="cloud-label">New label</div>
          <div class="cloud-row"><input required maxlength="40" placeholder="e.g. Anna's shop" aria-label="The new label's name" autocomplete="off">
            <button class="primary">Add</button></div>
          ${swatches(nextColor())}
        </form>
        <div class="error"></div>
        <div class="cloud-foot"><span></span><button type="button" class="primary cloud-close">Done</button></div>`;
    },
    editlabel: o => {
      const l = mine.labels.find(x => x.id === o.id);
      return `
        <h2>${l ? 'Edit label' : 'New label'}</h2>
        <form class="cloud-label-edit">
          <input required maxlength="40" value="${esc(l ? l.name : '')}" placeholder="e.g. Anna's shop" aria-label="Label name" autocomplete="off">
          <div class="cloud-label">Colour</div>
          ${swatches(l ? l.color : nextColor())}
          <div class="error"></div>
          <div class="cloud-foot">${l ? '<button type="button" class="cloud-label-del">Delete label…</button>' : '<span></span>'}
            <span class="foot-buttons"><button type="button" class="cloud-back">Cancel</button><button class="primary">Save</button></span></div>
        </form>`;
    },
    difference: () => `
      <h2>Online or on this computer?</h2>
      <div class="diff-grid">
        <div><h3>${iconOf('online')} Online</h3><ul>
          <li>Saved in WorkNest's online database.</li>
          <li>Open it on any computer or phone where you sign in.</li>
          <li>Share it with customers: they see the plan and write comments, with images and links.</li>
          <li>Safe if you clear your browser or get a new computer.</li></ul></div>
        <div><h3>${iconOf('local')} On this computer</h3><ul>
          <li>Saved only in this browser, on this computer.</li>
          <li>Not on your phone or other computers, or in another browser.</li>
          <li>Can't be shared, and has no comments.</li>
          <li>Lost if you clear the browser's data. Good for drafts or private plans: move it online any time.</li></ul></div>
      </div>
      <div class="cloud-foot"><span></span><button type="button" class="primary data-back-new">OK</button></div>`,
    moveonline: o => `
      <h2>Move “${esc((readLocal(o.id) || {}).name || '')}” online?</h2>
      <p>It's saved in WorkNest instead of only in this browser: you can open it on all your devices, share it with
         customers and write comments on its tasks. It's then no longer kept on this computer.</p>
      <div class="error"></div>
      <div class="cloud-foot"><button type="button" class="cloud-close">Cancel</button>
        <button type="button" class="primary cloud-move" data-id="${esc(o.id)}">Move online</button></div>`,
    noaccess: () => `
      <h2>No access</h2>
      <p>You're signed in as <b>${esc(user.email)}</b>, but this project isn't shared with that address.
         Ask the project's owner to add it, or sign in with another email address.</p>
      <div class="cloud-foot"><button type="button" class="cloud-switch">Use another email</button>
        <button type="button" class="primary cloud-home">Go to my projects</button></div>`,
    missing: () => `
      <h2>Project not found</h2>
      <p>This project doesn't exist (any more). The link may be wrong, or the owner deleted it.</p>
      <div class="cloud-foot"><span></span><button type="button" class="primary cloud-home">Go to my projects</button></div>`,
    share: () => `
      <h2>Share “${esc(projectName)}”</h2>
      <div class="cloud-label">Link to the project</div>
      <div class="cloud-row"><input class="cloud-url" readonly value="${esc(projectUrl(ONLINE_ID))}">
        <button type="button" class="cloud-copy">Copy</button></div>
      <div class="cloud-label">People</div>
      <ul class="cloud-people">
        <li><span>${esc(user.email)}</span><small>Owner (you)</small></li>
        ${(project.viewers || []).map(v => `<li><span>${esc(v)}</span><small>Can view and comment</small>
          <button type="button" class="cloud-remove" data-email="${esc(v)}" title="Remove">✕</button></li>`).join('')}
      </ul>
      <form class="cloud-row cloud-add">
        <input type="email" required placeholder="Customer's email address" autocomplete="off">
        <button class="primary">Add</button>
      </form>
      <div class="error"></div>
      <p class="muted">Send them the link. They sign in with the email address you added, and can then
         see the plan and write comments, but not change it.</p>
      <div class="cloud-foot"><button type="button" class="cloud-delete">Delete project…</button>
        <button type="button" class="primary cloud-close">Done</button></div>`,
    error: o => `
      <h2>Something went wrong</h2>
      <p>${esc(o.message || 'Please try again.')}</p>
      <div class="cloud-foot"><span></span><button type="button" class="primary cloud-close">OK</button></div>`,
  };

  // The colours to choose from for a label
  const swatches = chosen => `<div class="swatches" role="radiogroup" aria-label="Colour">${LABEL_COLORS.map(c =>
    `<label class="swatch" style="--label:${c}"><input type="radio" name="color" value="${c}"${c === chosen ? ' checked' : ''} aria-label="${c}"><i></i></label>`).join('')}</div>`;
  const backFromLabel = () => screenOpts.back ? showCloud('label', screenOpts.back) : closeCloud();
  const sameName = (name, except) => mine.labels.some(l => l.id !== except && l.name.toLowerCase() === name.toLowerCase());

  // Shows one of the screens above. `required`: it can't be closed.
  function showCloud(name, opts = {}) {
    screen = name; screenOpts = opts;
    body.innerHTML = screens[name](opts);
    if (!dialog.open) dialog.showModal();
    body.querySelector('input:not([readonly])')?.focus();
  }
  function closeCloud() { screen = null; if (dialog.open) dialog.close(); }
  dialog.addEventListener('cancel', e => { if (screenOpts.required) e.preventDefault(); });
  dialog.addEventListener('close', () => { screen = null; });
  const setError = text => { const el = body.querySelector('.error'); if (el) el.textContent = text; };
  const busy = (btn, on) => { if (btn) btn.disabled = on; };

  body.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('.cloud-close')) return closeCloud();
    if (b.matches('.cloud-home')) return goHome();
    if (b.matches('.cloud-switch')) { closeCloud(); return cloud.signOut(); } // (the start page shows, for this project)
    if (b.matches('.cloud-delete')) return deleteProject(b);
    if (b.matches('[data-diff]')) return showCloud('difference');
    if (b.matches('.data-back-new')) return showCloud('newproject'); // (back from "What's the difference?")
    if (b.dataset.setLabel !== undefined) { // a project's label
      if (b.dataset.setLabel) mine.projectLabels[screenOpts.key] = b.dataset.setLabel;
      else delete mine.projectLabels[screenOpts.key];
      closeCloud(); drawHome(); return saveMine();
    }
    if (b.dataset.editLabel) return showCloud('editlabel', { id: b.dataset.editLabel, back: screen === 'label' ? screenOpts : null });
    if (b.matches('.cloud-back')) return backFromLabel();
    if (b.matches('.cloud-label-del')) {
      const l = mine.labels.find(x => x.id === screenOpts.id), opts = screenOpts;
      if (!await askConfirm(`Delete the label “${esc(l.name)}”?`, 'Its projects stay as they are, just without a label.', 'Delete label')) return;
      mine.labels = mine.labels.filter(x => x.id !== l.id);
      for (const k of Object.keys(mine.projectLabels)) if (mine.projectLabels[k] === l.id) delete mine.projectLabels[k];
      screenOpts = opts; backFromLabel(); drawHome(); return saveMine();
    }
    if (b.matches('.cloud-move') && !await moveOnline(b.dataset.id, b)) return setError('Couldn\'t move it online. Check your connection and try again.');
    if (b.matches('.cloud-copy')) {
      const input = body.querySelector('.cloud-url');
      try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
      b.textContent = 'Copied';
      return setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    }
    if (b.matches('.cloud-remove')) {
      const viewers = project.viewers.filter(v => v !== b.dataset.email);
      try { await cloud.setViewers(ONLINE_ID, viewers); project = { ...project, viewers }; showCloud('share'); }
      catch { setError('Couldn\'t remove them. Try again.'); }
    }
  });

  body.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, input = f.querySelector('input'), btn = f.querySelector('button');
    if (f.matches('.cloud-label-new')) { // a new label, given to the project straight away
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) return;
      if (sameName(name)) return setError('You already have a label with that name.');
      const label = { id: uid(), name, color: f.color.value };
      mine.labels.push(label);
      mine.projectLabels[screenOpts.key] = label.id;
      closeCloud(); drawHome(); return saveMine();
    }
    if (f.matches('.cloud-label-edit')) {
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) return;
      if (sameName(name, screenOpts.id)) return setError('You already have a label with that name.');
      const l = mine.labels.find(x => x.id === screenOpts.id);
      if (l) Object.assign(l, { name, color: f.color.value });
      else mine.labels.push({ id: uid(), name, color: f.color.value });
      backFromLabel(); drawHome(); return saveMine();
    }
    if (f.matches('.cloud-new')) {
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) return;
      if (f.where.value === 'local') { // on this computer only
        const id = uid();
        try { writeLocal(id, { name, tasks: [], groupColors: {} }); }
        catch { return setError('There\'s no room left in this browser. Create it online instead.'); }
        location.href = `${location.pathname}?local=${id}`;
        return;
      }
      if (!await createAndOpen(name, { tasks: [], groupColors: {} }, f.querySelector('button.primary'))) setError('Couldn\'t create the project. Try again.');
    }
    if (f.matches('.cloud-add')) {
      const email = input.value.trim().toLowerCase();
      if (email === user.email || project.viewers.includes(email)) return setError('They already have access.');
      const viewers = [...project.viewers, email];
      busy(btn, true);
      try { await cloud.setViewers(ONLINE_ID, viewers); project = { ...project, viewers }; showCloud('share'); }
      catch { setError('Couldn\'t add them. Try again.'); busy(btn, false); }
    }
  });

  shareBtn.onclick = () => {
    if (LOCAL_ID) showCloud('moveonline', { id: LOCAL_ID }); // (on this computer: move it online first)
    else if (isOwner()) showCloud('share');
  };

  // The owner deletes the project, for everyone, with all its comments and
  // images; then your projects show
  async function deleteProject(btn) {
    const ok = await askConfirm(`Delete “${esc(projectName)}”?`,
      'The project and all its comments and images are deleted <b>for everyone</b>, and the link stops working. ' +
      "This can't be undone. (To keep a copy of the plan, use <b>Export ▾ → JSON</b> first.)", 'Delete project');
    if (!ok) return;
    busy(btn, true);
    btn.textContent = 'Deleting…';
    stopWatching(); // (so it doesn't report its own project as missing)
    try {
      await cloud.deleteProject(ONLINE_ID);
      goHome();
    } catch (err) {
      console.error(err);
      watch();
      busy(btn, false);
      btn.textContent = 'Delete project…';
      setError("Couldn't delete the project. Check your connection and try again.");
    }
  }

  // ---- The account menu ----
  const THEME_KEY = 'worknest-theme'; // 'light' | 'dark' (none: Auto); read before the page shows (index.html)
  const SUN_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const MOON_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  function drawAccountMenu() {
    const theme = read(THEME_KEY) || 'auto';
    const opt = (v, label, icon) => `<button type="button" data-theme-pick="${v}" class="${theme === v ? 'on' : ''}" aria-pressed="${theme === v}">${icon}${label}</button>`;
    accountMenu.innerHTML = `<div class="acct-head">Signed in as<b>${esc(user.email)}</b></div>
      <div class="acct-theme" role="group" aria-label="Appearance"><span>Appearance</span>
        <div class="theme-seg">${opt('light', 'Light', SUN_ICON)}${opt('dark', 'Dark', MOON_ICON)}${opt('auto', 'Auto', '')}</div></div>
      ${ONLINE_ID ? '<button type="button" data-home>All projects</button>' : ''}
      <button type="button" data-signout>Sign out</button>`;
  }
  function showAccountMenu(open) {
    accountMenu.hidden = !open;
    accountBtn.setAttribute('aria-expanded', open);
    if (open) drawAccountMenu();
  }
  accountBtn.onclick = () => showAccountMenu(accountMenu.hidden);
  document.addEventListener('pointerdown', e => { if (!accountMenu.hidden && !accountWrap.contains(e.target)) showAccountMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !accountMenu.hidden) { showAccountMenu(false); accountBtn.focus(); } });
  accountMenu.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-home]')) return goHome();
    if (b.dataset.themePick) { // Light / Dark / Auto (Auto: as the computer is set), remembered on this computer
      const t = b.dataset.themePick;
      store(THEME_KEY, t === 'auto' ? null : t);
      if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
      return drawAccountMenu();
    }
    if (b.matches('[data-signout]')) {
      if (saveTimer) await sendNow(); // (your last change first)
      await cloud.signOut();
      goHome(); // the start page
    }
  });

  function drawToolbar() {
    accountWrap.hidden = !user;
    if (user) {
      accountBtn.textContent = (user.name || user.email).trim()[0].toUpperCase();
      accountBtn.title = `Signed in as ${user.email}`;
    }
    document.getElementById('shareItem').hidden = !isOwner() && !LOCAL_ID; // (in the Export menu)
    shareBtn.textContent = LOCAL_ID ? 'Move online…' : 'Share…';
    shareBtn.title = LOCAL_ID ? 'Move this project online, to open it anywhere and share it' : 'Share this project with a customer';
  }

  // ================= The online project =================
  // Applies the project as stored online (on opening it, and whenever it's
  // changed elsewhere)
  function applyProject(data) {
    project = data;
    const owner = isOwner();
    readOnly = !owner;
    cloudSave = owner ? sendNow : null; // (Save: sends the project online; resolves true when it's saved)
    root.classList.toggle('read-only', readOnly);
    const viewOnly = document.getElementById('viewOnlyBadge'); // (someone else's project: whose, and view only)
    viewOnly.hidden = owner;
    document.getElementById('onlineBadge').hidden = !owner; // (your own project, online)
    viewOnly.title = owner ? '' : `Shared by ${data.owner}. You can see the plan and write comments, but not change it`;
    window.drawPresets?.(); // (no presets shelf when viewing)
    if (typeof drawSaveState === 'function') drawSaveState(); // (Undo, Redo and Save greyed out when viewing)
    // Our own changes coming back, or older than changes not sent yet, are skipped;
    // so is everything while you have unsaved changes (they'd be lost)
    const fresh = !saving && !sent.includes(data.data) && !isDirty();
    if (fresh) {
      let d = {};
      try { d = JSON.parse(data.data || '{}'); } catch {}
      tasks = Array.isArray(d.tasks) ? d.tasks : [];
      groupColors = d.groupColors || {};
      projectColor = typeof d.color === 'string' ? d.color : '';
      drawProjectColor();
      if (document.activeElement !== nameEl) { projectName = data.name || DEFAULT_NAME; showProjectName(); }
    }
    drawToolbar();
    safeRender();
    drawEditChip();
    if (fresh) markSaved(firstData); // (this is the saved version now)
    if (firstData && owner) restoreDraft(); // (unsaved changes from last time)
    if (firstData) { // the first time: show the remembered view around today, as on opening
      firstData = false;
      if (view) openView(view, todayString()); else scrollToToday();
      checkComingUp();
      if (params.has('share')) { // (Share… from your projects)
        history.replaceState(null, '', `${location.pathname}?p=${ONLINE_ID}`);
        if (owner) showCloud('share');
      }
    }
  }

  // The owner's changes are sent a moment after the last one (so a burst of
  // changes is one save)
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(sendNow, 400);
  }
  async function sendNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    syncGroupColors();
    const data = JSON.stringify({ tasks, groupColors, color: projectColor || undefined });
    sent.push(data); if (sent.length > 20) sent.shift();
    saving++;
    let ok = true;
    try { await cloud.saveProject(ONLINE_ID, { name: projectName, data }); }
    catch (err) {
      console.error(err);
      ok = false;
      showCloud('error', { message: 'Your changes couldn\'t be saved online. Check your connection and click Save again; they\'re kept in this browser until then.' });
    }
    saving--;
    return ok;
  }
  addEventListener('pagehide', () => { if (saveTimer) sendNow(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) sendNow(); });

  function watch() {
    if (stopProject) return;
    stopProject = cloud.watchProject(ONLINE_ID, data => {
      if (!data) { // deleted (or never existed): nothing of it stays on screen
        tasks = []; comments = []; projectName = 'Project not found'; showProjectName(); safeRender();
        return showCloud('missing', { required: true });
      }
      if (['noaccess'].includes(screen)) closeCloud();
      applyProject(data);
      stopComments ||= cloud.watchComments(ONLINE_ID, list => {
        comments = list;
        safeRender();
        drawThread();
      }, err => console.error(err));
    }, err => {
      console.error(err);
      stopWatching();
      if (err.code === 'permission-denied') showCloud('noaccess', { required: true });
      else showCloud('error', { message: 'The project couldn\'t be loaded. Check your connection and reload the page.' });
    });
  }
  function stopWatching() {
    stopProject?.(); stopComments?.();
    stopProject = stopComments = null;
  }

  // ================= A project on this computer =================
  // (app.js loads and saves it; here it's shown, with its label)
  function openLocal() {
    showPage('app');
    if (!localProject) {
      projectName = 'Project not found'; showProjectName();
      return showCloud('missing', { required: true });
    }
    document.getElementById('placeBadge').hidden = false;
    showProjectName();
    drawEditChip();
    safeRender();
    if (view) openView(view, todayString()); else scrollToToday();
    checkComingUp();
  }

  // ================= Starting up =================
  window.collab = {
    afterRender, followChart, alignOverview,
    // Your presets (presets.js): kept with your account, next to your labels
    presetsApi: () => config && user ? {
      state: () => labelsState,
      list: () => mine.presets || [],
      save: async list => { mine.presets = list; await saveMine(); },
      // Your own projects, on this computer and online (not those shared with you):
      // [{ kind: 'local' | 'online', id, name, data: { tasks, groupColors, … } }]
      async projects() {
        const local = listLocal().map(p => ({ kind: 'local', id: p.id, name: p.name, data: readLocal(p.id) }));
        let online = [];
        try {
          online = (await cloud.listProjects(user.email)).filter(p => p.mine).map(p => {
            let data = {};
            try { data = JSON.parse(p.data || '{}'); } catch {}
            return { kind: 'online', id: p.id, name: p.name, data };
          });
        } catch (err) { console.error(err); }
        // (with unsaved changes kept from last time: those, and they stay unsaved)
        return [...local, ...online].map(p => {
          const draftKey = `${TEST_MODE ? 'worknest-test:' : ''}worknest-draft:${p.kind === 'online' ? `p:${p.id}` : `local:${p.id}`}`;
          const d = readJson(draftKey);
          if (!d || typeof d.state !== 'string') return p;
          try { return { ...p, draftKey, draft: d, data: JSON.parse(d.state) }; } catch { return p; }
        }).filter(p => p.data && Array.isArray(p.data.tasks));
      },
      // Saves one of them (its tasks changed)
      async saveProject(p) {
        if (p.draft) return localStorage.setItem(p.draftKey, JSON.stringify({ ...p.draft, state: JSON.stringify(p.data) }));
        if (p.kind === 'local') return writeLocal(p.id, p.data);
        await cloud.saveProject(p.id, { data: JSON.stringify(p.data) });
      },
      // How many comments each of a project's tasks has ({ task id: count })
      commentCounts(p) {
        if (p.kind !== 'online') return Promise.resolve({});
        return new Promise(res => {
          let stop = null;
          setTimeout(() => res({}), 5000); // (no answer: none known)
          stop = cloud.watchComments(p.id, list => {
            const n = {};
            for (const x of list) n[x.taskId] = (n[x.taskId] || 0) + 1;
            res(n);
            setTimeout(() => stop?.(), 0);
          }, () => res({}));
        });
      },
    } : null,
    // The open project was saved: its chip and bars on All projects take its colour
    colorSaved(color) {
      const p = comboList.find(x => keyOf(x) === editKey());
      if (p) { p.data = { ...(p.data || {}), color: color || undefined }; drawHome(); }
    },
    // Fit: the dates of the projects in the overview (ms), when it's shown above the editor
    overviewSpan: () => [], // (Fit fits the project; the overview has its own zoom)
    // The open project's label colour (for its dot, when no colour of its own is chosen)
    labelColor() {
      const id = LOCAL_ID || ONLINE_ID;
      return id ? labelOf({ kind: LOCAL_ID ? 'local' : isOwner() ? 'online' : 'shared', id })?.color || '' : '';
    },
    count: id => comments.filter(c => c.taskId === id).length,
    // A task's 💬 with its number of comments; highlighted when there are new ones
    badge(id) {
      const list = taskComments(id);
      if (!list.length) return '';
      const fresh = list.some(c => user && c.uid !== user.uid && c.at > (seen[id] || 0));
      return `<button class="cm-badge${fresh ? ' fresh' : ''}" data-task="${id}"
        title="${list.length} comment${list.length > 1 ? 's' : ''}${fresh ? ', some new' : ''}">${TALK_ICON}<small>${list.length}</small></button>`;
    },
    openThread(id) {
      if (id !== threadTask) { textEl.value = ''; pending = []; drawPreviews(); statusEl.textContent = ''; textEl.style.height = ''; }
      threadTask = id;
      drawThread();
    },
    placeThread(slot) { if (config) slot.append(thread); },
    showThread() { requestAnimationFrame(() => thread.scrollIntoView({ block: 'start' })); },
    closeThread() { threadTask = null; },
  };

  if (!config) return; // (everything stays in this browser, as before)
  root.classList.add('cloud');
  const SIGNED_IN_KEY = 'worknest-signed-in'; // (remembered, so the next page doesn't flash the start screen; index.html)
  if (!root.classList.contains('page-app') && !root.classList.contains('page-projects')) showPage('loading');
  if (ONLINE_ID) { // view only until we know whether this is your project
    readOnly = true;
    root.classList.add('read-only');
  }
  drawToolbar();

  // If something goes wrong while a page opens, say what instead of leaving it blank
  function showProblem(err) {
    console.error(err);
    const message = `Something went wrong: ${err && err.message || err}. Reload the page; if it keeps happening, sign out and in again.`;
    if (root.classList.contains('page-app')) return showCloud('error', { message });
    startCard.innerHTML = `<h2>Something went wrong</h2><p>${esc(message)}</p>
      <button type="button" class="start-again">Back to signing in</button>`;
    showPage('start');
  }
  let knownUser = false; // (Firebase has said whether you're signed in)
  const loading = () => !knownUser; // (still opening: problems are shown on the page)
  addEventListener('error', e => { if (loading()) showProblem(e.error || e.message); });
  addEventListener('unhandledrejection', e => { if (loading()) showProblem(e.reason); });
  setTimeout(() => { if (loading()) showProblem('opening took too long (check your connection)'); }, 20000);

  // Test mode: one click on the start page (only at localhost) and you're in,
  // with example projects (test-cloud.js); a bar at the bottom says so
  if (TEST_MODE) {
    const bar = document.createElement('div');
    bar.className = 'test-bar';
    bar.innerHTML = `<b>Test mode</b><span>Example data on this computer only: nothing is saved online.</span>
      <button type="button" data-test="reset">Reset examples</button><button type="button" data-test="exit">Leave test mode</button>`;
    document.body.append(bar);
    bar.addEventListener('click', e => {
      const what = e.target.closest('[data-test]')?.dataset.test;
      if (what === 'reset') {
        for (const k of Object.keys(localStorage)) if (k.startsWith('worknest-test:')) localStorage.removeItem(k);
        goHome();
      }
      if (what === 'exit') { store('worknest-test-mode', null); goHome(); }
    });
  }
  startCard.addEventListener('click', e => {
    if (e.target.closest('.start-test')) { store('worknest-test-mode', '1'); goHome(); }
  });

  import(TEST_MODE ? `./test-cloud.js${version}` : `./cloud.js${version}`).then(mod => {
    cloud = mod;
    cloud.init(config);
    if (cloud.isLink(location.href)) { // back from an emailed sign-in link
      linking = true;
      const email = read(EMAIL_KEY);
      if (email) finishLink(email);
      else { drawStart('confirm'); showPage('start'); }
    }
    cloud.onUser(u => {
      try {
        user = u;
        drawToolbar();
        knownUser = true;
        try { u ? localStorage.setItem(SIGNED_IN_KEY, '1') : localStorage.removeItem(SIGNED_IN_KEY); } catch {}
        if (!u) {
          stopWatching();
          if (!linking) { drawStart(); showPage('start'); }
          return;
        }
        if (ONLINE_ID) { showPage('app'); watch(); }
        else if (LOCAL_ID) openLocal();
        if (ONLINE_ID || LOCAL_ID) drawProjects(); // (All projects above the open project; also your labels, for its colour)
        else { showPage('projects'); drawProjects(); }
        drawThread();
      } catch (err) { showProblem(err); }
    });
  }).catch(err => {
    console.error(err);
    startCard.innerHTML = '<p class="error">WorkNest couldn\'t load. Check your connection and reload the page.</p>';
    showPage('start');
  });
})();
