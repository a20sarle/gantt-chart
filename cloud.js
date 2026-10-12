// Firebase: signing in, the online projects and their comments.
// collab.js loads this only when firebase-config.js has settings.
//
// Firestore layout (see firestore.rules for who may do what):
//   projects/{id}               { name, data, owner, viewers, created, updated }
//                                data: the tasks and group colours, as JSON text
//   projects/{id}/comments/{id} { taskId, text, uid, email, name, images: [{ id, w, h }], at }
//   projects/{id}/images/{id}   { data, w, h, uid, at }   data: a JPEG as a data: URL
//   users/{uid}                 { labels, projectLabels, updated }   your own labels
// Images live in the database rather than in Cloud Storage, because Storage
// needs Firebase's paid plan; collab.js shrinks them to stay well under 1 MB.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink,
  signInWithEmailLink, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {
  getFirestore, doc, collection, setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, serverTimestamp, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';

let auth, db;
export function init(config) {
  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
}

// ---- Signing in ----
// google: signed in with Google this time (only they can create projects);
// otherwise with a link emailed to them (people a project is shared with)
const person = async u => u && {
  uid: u.uid, email: (u.email || '').toLowerCase(), name: u.displayName || '',
  google: await u.getIdTokenResult().then(t => t.signInProvider === 'google.com', () => false),
};
export const onUser = cb => onAuthStateChanged(auth, async u => cb(await person(u)));
export const sendLink = (email, url) => sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
export const isLink = href => isSignInWithEmailLink(auth, href);
export const finishLink = (email, href) => signInWithEmailLink(auth, email, href);
export const signInWithGoogle = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOut = () => fbSignOut(auth);

// ---- Projects ----
const projectRef = id => doc(db, 'projects', id);

// Calls onData(project or null) now and whenever it changes elsewhere
// (not for this browser's own changes while they're still being sent)
export function watchProject(id, onData, onError) {
  return onSnapshot(projectRef(id), snap => {
    if (snap.metadata.hasPendingWrites) return;
    onData(snap.exists() ? snap.data() : null);
  }, onError);
}
export async function createProject({ name, data, owner }) {
  const ref = doc(collection(db, 'projects'));
  await setDoc(ref, { name, data, owner, viewers: [], created: serverTimestamp(), updated: serverTimestamp() });
  return ref.id;
}
export const saveProject = (id, fields) => updateDoc(projectRef(id), { ...fields, updated: serverTimestamp() });
export const setViewers = (id, viewers) => updateDoc(projectRef(id), { viewers });

// Deletes a project with all its comments and images. (Firestore doesn't
// delete them along with the project, so they go first, in batches; the
// rules still need the project to check that you're its owner.)
export async function deleteProject(id) {
  const comments = await getDocs(collection(db, 'projects', id, 'comments'));
  const refs = comments.docs.flatMap(d => [
    ...(d.data().images || []).map(img => doc(db, 'projects', id, 'images', img.id)),
    d.ref,
  ]);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
  await deleteDoc(projectRef(id));
}

// The projects this person owns, and those shared with them:
// [{ id, name, mine, owner, viewers (how many), updated (ms), data }]
export async function listProjects(email) {
  const all = collection(db, 'projects');
  const [mine, shared] = await Promise.all([
    getDocs(query(all, where('owner', '==', email))),
    getDocs(query(all, where('viewers', 'array-contains', email))),
  ]);
  const item = (d, mine) => {
    const p = d.data();
    return { id: d.id, name: p.name, mine, owner: p.owner, viewers: (p.viewers || []).length, updated: p.updated ? p.updated.toMillis() : 0, data: p.data };
  };
  return [...mine.docs.map(d => item(d, true)), ...shared.docs.map(d => item(d, false))];
}

// ---- Your own settings (your labels) ----
// users/{uid}: { labels: [{ id, name, color }], projectLabels: { '<kind>:<project id>': label id } }
export async function getMine(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : {};
}
export const saveMine = (uid, { labels, projectLabels }) => setDoc(doc(db, 'users', uid), { labels, projectLabels, updated: serverTimestamp() });

// ---- Comments ----
// Calls onList(all of the project's comments, oldest first) now and on every change
export function watchComments(id, onList, onError) {
  const q = query(collection(db, 'projects', id, 'comments'), orderBy('at'));
  return onSnapshot(q, snap => onList(snap.docs.map(d => {
    const c = d.data({ serverTimestamps: 'estimate' });
    return { ...c, id: d.id, at: c.at ? c.at.toMillis() : Date.now() };
  })), onError);
}

// A comment and its images, saved together (all or nothing)
export async function addComment(projectId, me, { taskId, text, images }) {
  const batch = writeBatch(db);
  const imgs = images.map(img => {
    const ref = doc(collection(db, 'projects', projectId, 'images'));
    batch.set(ref, { data: img.data, w: img.w, h: img.h, uid: me.uid, at: serverTimestamp() });
    return { id: ref.id, w: img.w, h: img.h };
  });
  batch.set(doc(collection(db, 'projects', projectId, 'comments')), {
    taskId, text, uid: me.uid, email: me.email, name: me.name, images: imgs, at: serverTimestamp(),
  });
  await batch.commit();
}
export async function deleteComment(projectId, comment) {
  const batch = writeBatch(db);
  for (const img of comment.images || []) batch.delete(doc(db, 'projects', projectId, 'images', img.id));
  batch.delete(doc(db, 'projects', projectId, 'comments', comment.id));
  await batch.commit();
}
export async function getImage(projectId, imageId) {
  const snap = await getDoc(doc(db, 'projects', projectId, 'images', imageId));
  return snap.exists() ? snap.data().data : null;
}
