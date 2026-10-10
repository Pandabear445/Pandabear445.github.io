/* =========================================================
   Recall — flashcards and study modes
   ========================================================= */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const MIN = 60000, DAY = 86400000;
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dayKey = (d = new Date()) => { const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, reduceMotion ? 0 : ms));
/* ---------------- Hearth ----------------
   Inside Hearth, Recall runs in a sandboxed frame with no storage and no network of its own. Hearth (the parent
   page) loads your decks, encrypts every change with a key only your devices have, and syncs it; this frame only
   talks to it through messages. Everything that comes in (from Hearth, a backup or an imported file) is cleaned
   first, because a shared deck file is someone else's data. */
const HB = window.parent !== window ? { theme:null } : null;
function hbSend(t, data){ if (HB) parent.postMessage({ recall:1, t, ...data }, '*'); }
const ID_RE = /^[\w-]{1,40}$/;
const safeId = id => typeof id === 'string' && ID_RE.test(id) ? id : nid();
const safeImg = s => typeof s === 'string' && s.length < 4e6 && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
const safeColor = c => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#5B4BFF';
const safeLang = l => typeof l === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(l) ? l : 'en-US';
const txt = (s, n = 20000) => (typeof s === 'string' ? s : s == null ? '' : String(s)).slice(0, n);
const num = (v, d = 0) => Number.isFinite(+v) ? +v : d;
const word = (v, d = '') => typeof v === 'string' && /^[\w.:-]{0,40}$/.test(v) ? v : d;
// Removes HTML tags from pasted text, again and again until none are left ("<<b>i>" leaves no "<i>" behind).
const stripTags = s => { let prev; do { prev = s; s = s.replace(/<[^>]+>/g, ''); } while (s !== prev); return s; };
function cleanOpts(o){ const r = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (!/^\w{1,30}$/.test(k)) continue; if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) r[k] = v; else if (typeof v === 'string' && /^[\w.:-]{0,40}$/.test(v)) r[k] = v; } return r; }
function cleanCard(c){
  if (!c || typeof c !== 'object') return null;
  const b = newCard(), s = c.srs && typeof c.srs === 'object' ? c.srs : {}, st = c.st && typeof c.st === 'object' ? c.st : {};
  return { id:safeId(c.id), term:txt(c.term), def:txt(c.def), termImg:safeImg(c.termImg), defImg:safeImg(c.defImg), starred:!!c.starred, hint:txt(c.hint, 2000), lv:num(c.lv),
    st:{ c:num(st.c), w:num(st.w), s:num(st.s) },
    srs:{ state:['new','learning','review'].includes(s.state) ? s.state : 'new', ease:num(s.ease, b.srs.ease), ivl:num(s.ivl), due:num(s.due), reps:num(s.reps), lapses:num(s.lapses) } };
}
function cleanDeck(d){
  if (!d || typeof d !== 'object' || !Array.isArray(d.cards)) return null;
  const seen = new Set();
  const cards = d.cards.slice(0, 5000).map(cleanCard).filter(c => c && !seen.has(c.id) && seen.add(c.id));
  return { id:safeId(d.id), title:txt(d.title, 200), desc:txt(d.desc, 2000), course:typeof d.course === 'string' && ID_RE.test(d.course) ? d.course : '',
    examDate:typeof d.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.examDate) ? d.examDate : '', termLang:safeLang(d.termLang), defLang:safeLang(d.defLang),
    createdAt:num(d.createdAt, Date.now()), updatedAt:num(d.updatedAt), opts:cleanOpts(d.opts), cards };
}
function cleanProfile(src){
  // A new object with only the known fields, each checked, so nothing else in the saved data comes along.
  const p = src && typeof src === 'object' ? src : {}, def = defaultProfile();
  const ids = a => Array.isArray(a) ? a.filter(x => typeof x === 'string' && ID_RE.test(x)) : [];
  const nums = o => { const r = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (/^[\w-]{1,40}$/.test(k) && Number.isFinite(+v)) r[k] = +v; return r; };
  const out = {
    activity:nums(p.activity), streak:num(p.streak, def.streak),
    lastDay:typeof p.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.lastDay) ? p.lastDay : null,
    xp:num(p.xp, def.xp), best:nums(p.best), goal:num(p.goal, def.goal), newPerDay:num(p.newPerDay, def.newPerDay),
    newToday:{ day:word(p.newToday?.day), n:num(p.newToday?.n) }, deleted:ids(p.deleted).slice(-200),
    theme:['auto','light','dark'].includes(p.theme) ? p.theme : 'auto', seedCleared:p.seedCleared !== false,
    courses:(Array.isArray(p.courses) ? p.courses : []).filter(c => c && typeof c === 'object').slice(0, 200)
      .map(c => ({ id:safeId(c.id), name:txt(c.name, 60).replace(/[<>&"'`]/g, ''), color:safeColor(c.color) })),
    homeCourse:typeof p.homeCourse === 'string' && ID_RE.test(p.homeCourse) ? p.homeCourse : '',
    focus:num(p.focus, def.focus), updatedAt:num(p.updatedAt, def.updatedAt),
  };
  if ('lastBackup' in p) out.lastBackup = num(p.lastBackup);
  if (p.combo) out.combo = { decks:ids(p.combo.decks), filter:word(p.combo.filter, 'all'), front:p.combo.front === 'def' ? 'def' : 'term' };
  return out;
}
function cleanState(s){
  const seen = new Set();
  return { decks:(Array.isArray(s?.decks) ? s.decks : []).map(cleanDeck).filter(d => d && !seen.has(d.id) && seen.add(d.id)), profile:cleanProfile(s?.profile) };
}

const svg = (p, fill) => `<svg viewBox="0 0 24 24" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${p}</svg>`;

const I = {
  cards: svg('<rect x="3" y="7" width="14" height="12" rx="2.5"/><path d="M7 7V5.5A2.5 2.5 0 0 1 9.5 3h9A2.5 2.5 0 0 1 21 5.5v9a2.5 2.5 0 0 1-2.5 2.5H17"/>'),
  learn: svg('<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-5.5"/>'),
  review: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><path d="M12 7v5l3 2"/>'),
  write: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
  match: svg('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M14 6.5h3.5a2 2 0 0 1 2 2V11M10 17.5H6.5a2 2 0 0 1-2-2V13"/>'),
  test: svg('<path d="M9 4h6v3H9zM7 5.5H5v15h14v-15h-2"/><path d="M8.5 13l2 2 4-4"/>'),
  blitz: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>'),
  star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>', true),
  starO: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
  speak: svg('<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  shuffle: svg('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
  play: svg('<path d="M7 4v16l13-8z"/>', true),
  pause: svg('<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>', true),
  swap: svg('<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>'),
  left: svg('<path d="M15 5l-7 7 7 7"/>'), right: svg('<path d="M9 5l7 7-7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', true),
  paste: svg('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>'),
  type: svg('<path d="M4 7V5h16v2M9 19h6M12 5v14"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: svg('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  flame: svg('<path d="M12 22c4 0 7-2.8 7-7 0-4-3-6-4-9-1 2-2 3-3.5 3.5C11 7 10.5 4 12 2 7 4 5 9 5 14.5 5 18.9 8 22 12 22z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), xmark: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  turn: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  clock: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
  target: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>'),
  coffee: svg('<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3M12 2v3"/>'),
  db: svg('<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.5M4.5 12v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V12"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>'),
  print: svg('<path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/>'),
  brain: svg('<path d="M9.5 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10.5a3 3 0 0 0 1 2.2A3.2 3.2 0 0 0 7.5 18a2.5 2.5 0 0 0 2 2 2.5 2.5 0 0 0 2.5-2.5V5.5A1.5 1.5 0 0 0 9.5 4zM14.5 4a3 3 0 0 1 3 3v.2a3 3 0 0 1 2.5 3.3 3 3 0 0 1-1 2.2 3.2 3.2 0 0 1-2.5 5.3 2.5 2.5 0 0 1-2 2 2.5 2.5 0 0 1-2.5-2.5V5.5A1.5 1.5 0 0 1 14.5 4z"/>'),
  bolt: svg('<path d="M6 13l3-10h7l-3 7h5L9 21l2-8H6z"/>'),
  gap: svg('<path d="M3 7h5M3 12h3M3 17h7M16 7h5M13 12h8M17 17h4"/><rect x="9.5" y="4.5" width="5" height="5" rx="1.2" stroke-dasharray="2 2"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'),
  ear: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2.5" y="14" width="5" height="7" rx="2"/><rect x="16.5" y="14" width="5" height="7" rx="2"/>'),
  layers: svg('<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M2 13l10 5 10-5"/><path d="M2 17.5l10 5 10-5" opacity=".55"/>'),
  cal: svg('<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'),
};

/* ---------------- state ---------------- */
function newCard(term='', def=''){ return { id:nid(), term, def, termImg:'', defImg:'', starred:false, hint:'', lv:0, st:{c:0,w:0,s:0}, srs:{state:'new', ease:2.5, ivl:0, due:0, reps:0, lapses:0} }; }
const defaultProfile = () => ({ activity:{}, streak:0, lastDay:null, xp:0, best:{}, goal:40, newPerDay:20, newToday:{day:'',n:0}, deleted:[], theme:'auto', seedCleared:true, courses:[], homeCourse:'', focus:0, updatedAt:0 });
let S = { decks:[], profile:defaultProfile() };
let V = { name:'home' }, T = {}, cleanup = [], keysFor = null, animateView = true;
let DOWNLOADS = null;
const COLORS = ['#5B4BFF','#0FA37A','#E5364F','#F2994A','#1E88E5','#C2379A','#0097A7','#8D6E63'];

const OLD_SEEDS = ['Spanish: everyday verbs|The 15 verbs you will use every single day.', 'Cell biology basics|Organelles and what they do.'];
function clearSeeds(){
  const gone = S.decks.filter(d => OLD_SEEDS.includes(d.title + '|' + d.desc));
  if (!gone.length) return [];
  S.decks = S.decks.filter(d => !gone.includes(d));
  S.profile.deleted = [...new Set([...(S.profile.deleted || []), ...gone.map(d => d.id)])].slice(-200);
  return gone.map(d => d.id);
}

/* ---------------- storage: IndexedDB (large, for images) + localStorage fallback ---------------- */
const IDB = {
  db:null,
  open(){ return new Promise((res, rej) => { if (!window.indexedDB) return rej(new Error('no idb')); const r = indexedDB.open('recall', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error); }); },
  get(k){ return new Promise((res, rej) => { const q = this.db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  set(k, v){ return new Promise((res, rej) => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
};
const LS_KEY = 'recall:v1';
let warnedFull = false;
const Store = {
  db:null, root:null, timers:{}, lt:null,
  saveLocal(){ clearTimeout(this.lt); this.lt = setTimeout(() => this.flush(), 150); },
  flush(){
    clearTimeout(this.lt); this.lt = null;
    if (HB) return; // Hearth keeps your decks (encrypted); nothing is left in this browser
    const json = JSON.stringify(S); let ok = false;
    if (window.recallDesktop){ try { window.recallDesktop.save(json); ok = true; } catch(e){} }
    if (IDB.db){ IDB.set('state', json).catch(() => {}); ok = true; }
    try { localStorage.setItem(LS_KEY, json); ok = true; }
    catch(e){ try { localStorage.removeItem(LS_KEY); } catch(_){} }
    if (!ok && !warnedFull){ warnedFull = true; toast('Your browser storage is full. Download a backup, then remove some images.'); }
  },
  deckRef(id){ return this.root.collection('decks').doc(id); },
  queue(key, fn){ clearTimeout(this.timers[key]); this.timers[key] = setTimeout(fn, 800); },
  saveDeck(deck){
    if (deck.isCombo){ deck.sources.forEach(id => { const d = S.decks.find(x => x.id === id); if (d) this.saveDeck(d); }); return; }
    deck.updatedAt = Date.now(); this.saveLocal();
    if (HB) return hbSend('deck', { deck:JSON.parse(JSON.stringify(deck)) });
    if (!this.db) return;
    this.queue('d:' + deck.id, async () => {
      try { setSync('Saving…'); await this.deckRef(deck.id).set(JSON.parse(JSON.stringify(deck))); setSync('Saved'); }
      catch(e){ setSync(e.code === 'invalid_argument' ? 'Deck too large to sync' : 'Saved on this device'); }
    });
  },
  saveProfile(){
    S.profile.updatedAt = Date.now(); this.saveLocal();
    if (HB) return hbSend('profile', { profile:JSON.parse(JSON.stringify(S.profile)) });
    if (!this.db) return;
    this.queue('p', async () => { try { await this.root.set(JSON.parse(JSON.stringify(S.profile))); } catch(e){} });
  },
  removeDeck(id){
    S.decks = S.decks.filter(d => d.id !== id);
    S.profile.deleted = [...(S.profile.deleted || []), id].slice(-200);
    this.saveProfile();
    if (HB) hbSend('remove', { id });
    if (this.db) this.deckRef(id).delete().catch(()=>{});
  },
  async initCloud(){
    if (!window.claude || !window.claude.use) return;
    try {
      const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
      if (!db || !user) return;
      const id = await user.id(); if (!id) return;
      this.db = db; this.root = db.doc('data/users/' + id + '/profile');
      const [p, q] = await Promise.all([this.root.get(), this.root.collection('decks').get()]);
      const cloudProfile = p.exists ? p.data() : null;
      const cloudDecks = q.docs.map(d => d.data()).filter(Boolean);
      if (cloudProfile || cloudDecks.length){
        const deleted = new Set([...(cloudProfile?.deleted || []), ...(S.profile.deleted || [])]);
        const byId = new Map();
        [...cloudDecks, ...S.decks].forEach(d => { const cur = byId.get(d.id); if (!cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(d.id, JSON.parse(JSON.stringify(d))); });
        const cloudById = new Map(cloudDecks.map(d => [d.id, d]));
        const localNewer = S.decks.filter(d => !cloudById.has(d.id) || (d.updatedAt || 0) > (cloudById.get(d.id).updatedAt || 0));
        S.decks = [...byId.values()].filter(d => !deleted.has(d.id)).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (cloudProfile && (cloudProfile.updatedAt || 0) >= (S.profile.updatedAt || 0)) S.profile = { ...defaultProfile(), ...cloudProfile };
        S.profile.deleted = [...deleted].slice(-200);
        clearSeeds();
        const del = new Set(S.profile.deleted);
        cloudDecks.forEach(d => { if (del.has(d.id)) this.deckRef(d.id).delete().catch(()=>{}); });
        localNewer.forEach(d => { if (!del.has(d.id)) this.deckRef(d.id).set(JSON.parse(JSON.stringify(d))).catch(()=>{}); });
        this.saveLocal(); this.saveProfile();
        if (!T.active && V.name !== 'edit'){ animateView = false; render(); }
      } else {
        await this.root.set(JSON.parse(JSON.stringify(S.profile)));
        for (const d of S.decks) await this.deckRef(d.id).set(JSON.parse(JSON.stringify(d))).catch(()=>{});
      }
      setSync('Synced'); setTimeout(() => setSync(''), 2500);
    } catch(e){ this.db = null; }
  }
};
function setSync(t){ const el = $('#sync'); if (el) el.textContent = t; }
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && Store.lt) Store.flush(); });
addEventListener('pagehide', () => { if (Store.lt) Store.flush(); });

/* ---------------- saving files ---------------- */
async function saveFile(name, text, type){
  if (HB){ hbSend('file', { name:String(name).slice(0, 120), text:String(text), type }); return true; }
  if (window.recallDesktop) return window.recallDesktop.saveFile(name, text);
  if (DOWNLOADS){
    try { await DOWNLOADS.save({ filename:name, data:new Blob([text], { type }) }); return true; }
    catch(e){ if (e.code !== 'declined') toast('Could not save the file.'); return false; }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000); return true;
}

/* ---------------- theme ---------------- */
function applyTheme(){ const t = S.profile.theme; if (t === 'auto' && HB && HB.theme) document.documentElement.setAttribute('data-theme', HB.theme); else if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
function isDark(){ const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }

/* ---------------- text formatting for science and math ---------------- */
const SYM = { alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',pi:'π',rho:'ρ',sigma:'σ',tau:'τ',phi:'φ',chi:'χ',psi:'ψ',omega:'ω',
  Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
  pm:'±',mp:'∓',times:'×',div:'÷',cdot:'·',neq:'≠',leq:'≤',geq:'≥',approx:'≈',equiv:'≡',sim:'∼',propto:'∝',infty:'∞',sqrt:'√',sum:'∑',prod:'∏',int:'∫',oint:'∮',partial:'∂',nabla:'∇',
  deg:'°',to:'→',rightarrow:'→',leftarrow:'←',leftrightarrow:'↔',Rightarrow:'⇒',Leftarrow:'⇐',iff:'⇔',rightleftharpoons:'⇌',uparrow:'↑',downarrow:'↓',
  in:'∈',notin:'∉',subset:'⊂',subseteq:'⊆',cup:'∪',cap:'∩',emptyset:'∅',forall:'∀',exists:'∃',neg:'¬',land:'∧',lor:'∨',therefore:'∴',because:'∵',
  hbar:'ℏ',ell:'ℓ',angstrom:'Å',perp:'⊥',parallel:'∥',angle:'∠',micro:'µ',ohm:'Ω',celsius:'℃' };
function symbols(s){
  return String(s ?? '').replace(/\\([A-Za-z]+)/g, (m, n) => SYM[n] ?? m)
    .replace(/<=>/g, '⇌').replace(/<->/g, '↔').replace(/->/g, '→').replace(/<-/g, '←').replace(/!=/g, '≠').replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/\+-/g, '±');
}
function fmt(s){
  let h = esc(symbols(s));
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=$|[\s).,;:!?])/g, '$1<i>$2</i>');
  h = h.replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>').replace(/\^(\d*[+-](?![\w(])|-?\d+|[A-Za-z])/g, '<sup>$1</sup>');
  h = h.replace(/_\{([^}]*)\}/g, '<sub>$1</sub>').replace(/([A-Za-z)\]])_(\d+)/g, '$1<sub>$2</sub>');
  return h;
}
function plain(s){
  return symbols(s).replace(/\*\*|\*/g, '').replace(/[\^_]\{([^}]*)\}/g, '$1').replace(/\^(\d*[+-](?![\w(])|-?\d+|[A-Za-z])/g, '$1').replace(/([A-Za-z)\]])_(\d+)/g, '$1$2');
}
function cloze(term){
  const parts = []; const blanked = term.replace(/\{\{(.+?)\}\}/g, (m, w) => { parts.push(w.trim()); return '_____'; });
  return parts.length ? { term:blanked, answer:parts.join(', ') } : null;
}

/* ---------------- courses & exams ---------------- */
function courses(){ return S.profile.courses || (S.profile.courses = []); }
function courseById(id){ return courses().find(c => c.id === id); }
function addCourse(name){ const c = { id:nid(), name:name.trim().slice(0, 60), color:COLORS[courses().length % COLORS.length] }; courses().push(c); Store.saveProfile(); return c; }
function courseTag(d){ const c = courseById(d.course); return c ? `<span class="ctag" style="--cc:${c.color}"><i></i>${esc(c.name)}</span>` : ''; }
function daysUntil(ds){ if (!ds) return null; const [y, m, d] = ds.split('-').map(Number); const t = new Date(y, m - 1, d), now = new Date(); now.setHours(0,0,0,0); return Math.round((t - now) / DAY); }
function niceDate(ds){ const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' }); }
function examInfo(d){
  const n = daysUntil(d.examDate); if (n === null) return null;
  const k = deckCounts(d), left = d.cards.length - k.mastered;
  return { n, left, perDay: n > 0 ? Math.ceil(left / n) : left, pct: d.cards.length ? Math.round(k.mastered / d.cards.length * 100) : 0 };
}
function examPill(d){
  const e = examInfo(d); if (!e || e.n < 0) return '';
  const txt = e.n === 0 ? 'Exam today' : e.n === 1 ? 'Exam tomorrow' : `Exam in ${e.n} days`;
  return `<span class="pill ${e.n <= 3 ? 'bad' : e.n <= 10 ? 'warn' : ''}">${I.cal.replace('<svg','<svg style="width:14px;height:14px"')}${txt}</span>`;
}

/* ---------------- learning helpers ---------------- */
function deckById(id){ if (id === '__combo') return COMBO || buildCombo(); return S.decks.find(d => d.id === id); }
/* ---- studying several decks together: a temporary deck whose cards are the real cards ---- */
let COMBO = null;
function comboCfg(){ const c = S.profile.combo || (S.profile.combo = { decks:[], filter:'all', front:'term' }); c.decks = c.decks.filter(id => S.decks.some(d => d.id === id)); return c; }
function comboCards(cfg){
  const decks = cfg.decks.map(id => S.decks.find(d => d.id === id)).filter(Boolean);
  let cards = decks.flatMap(d => d.cards.filter(complete));
  if (cfg.filter === 'starred') cards = cards.filter(c => c.starred);
  if (cfg.filter === 'work') cards = cards.filter(needsWork);
  return { decks, cards };
}
function comboTitle(cfg, decks){
  const cs = [...new Set(decks.map(d => d.course))];
  const name = decks.length === 1 ? decks[0].title : (cs.length === 1 && courseById(cs[0]) && decks.length === S.decks.filter(d => d.course === cs[0]).length) ? courseById(cs[0]).name + ' (all decks)' : decks.length === S.decks.length ? 'All decks' : decks.length + ' decks';
  return (cfg.filter === 'starred' ? 'Starred · ' : cfg.filter === 'work' ? 'Needs work · ' : '') + name;
}
function buildCombo(){
  const cfg = comboCfg(), { decks, cards } = comboCards(cfg);
  const deckOf = new Map(); decks.forEach(d => d.cards.forEach(c => deckOf.set(c.id, d)));
  COMBO = { id:'__combo', isCombo:true, title:comboTitle(cfg, decks), desc:'', course:'', termLang:decks[0]?.termLang || 'en-US', defLang:decks[0]?.defLang || 'en-US', opts:{ front:cfg.front, filter:'all' }, cards, sources:decks.map(d => d.id), deckOf };
  return COMBO;
}
function startCombo(deckIds, filter){ const cfg = comboCfg(); cfg.decks = [...deckIds]; if (filter) cfg.filter = filter; Store.saveProfile(); go('combo'); }
function starredTotals(){ const ds = S.decks.filter(d => d.cards.some(c => c.starred && complete(c))); return { n:ds.reduce((s, d) => s + d.cards.filter(c => c.starred && complete(c)).length, 0), decks:ds }; }
function workTotals(){ const ds = S.decks.filter(d => d.cards.some(c => needsWork(c) && complete(c))); return { n:ds.reduce((s, d) => s + d.cards.filter(c => needsWork(c) && complete(c)).length, 0), decks:ds }; }
function mastery(c){
  if (c.srs.ivl >= 7 || (c.lv >= 2 && c.st.s >= 2)) return 'mastered';
  if (c.st.c + c.st.w === 0 && c.srs.state === 'new') return 'new';
  return 'learning';
}
function needsWork(c){ return c.st.w >= 2 && c.st.w >= c.st.c; }
function hasTerm(c){ return !!(String(c.term).trim() || c.termImg); }
function hasDef(c){ return !!(String(c.def).trim() || c.defImg); }
function complete(c){ return hasTerm(c) && hasDef(c); }
function isDue(c, now = Date.now()){ return c.srs.state !== 'new' && c.srs.due <= now; }
function deckCounts(d){ const r = {new:0, learning:0, mastered:0, due:0, fresh:0}; d.cards.forEach(c => { r[mastery(c)]++; if (isDue(c)) r.due++; if (c.srs.state === 'new' && complete(c)) r.fresh++; }); return r; }
function newLeftToday(){ const p = S.profile; if (p.newToday.day !== dayKey()) return p.newPerDay; return Math.max(0, p.newPerDay - p.newToday.n); }

function schedule(srs, g, now = Date.now()){
  const s = { ...srs };
  if (s.state === 'new' || s.state === 'learning'){
    if (g === 0){ s.state = 'learning'; s.due = now + MIN; s.ivl = 0; }
    else if (g === 1){ s.state = 'learning'; s.due = now + 6*MIN; s.ivl = 0; }
    else if (g === 2){ s.state = 'review'; s.ivl = 1; s.due = now + DAY; }
    else { s.state = 'review'; s.ivl = 4; s.due = now + 4*DAY; s.ease += 0.15; }
  } else {
    if (g === 0){ s.lapses++; s.state = 'learning'; s.ease = Math.max(1.3, s.ease - 0.2); s.ivl = 0; s.due = now + 10*MIN; }
    else if (g === 1){ s.ease = Math.max(1.3, s.ease - 0.15); s.ivl = Math.max(1, s.ivl * 1.2); s.due = now + s.ivl*DAY; }
    else if (g === 2){ s.ivl = Math.max(s.ivl + 1, s.ivl * s.ease); s.due = now + s.ivl*DAY; }
    else { s.ease += 0.15; s.ivl = Math.max(s.ivl + 2, s.ivl * s.ease * 1.3); s.due = now + s.ivl*DAY; }
  }
  s.ivl = Math.round(s.ivl * 10) / 10; s.reps++;
  return s;
}
function fmtIvl(ms){ if (ms < 60*MIN) return Math.max(1, Math.round(ms/MIN)) + ' min'; if (ms < DAY) return Math.round(ms/(60*MIN)) + ' hr'; const d = Math.round(ms/DAY); if (d < 30) return d + (d === 1 ? ' day' : ' days'); if (d < 365) return Math.round(d/30) + ' mo'; return (d/365).toFixed(1) + ' yr'; }

function recordAnswer(card, correct){
  card.st.c += correct ? 1 : 0; card.st.w += correct ? 0 : 1; card.st.s = correct ? card.st.s + 1 : 0;
  const p = S.profile, today = dayKey(), before = p.activity[today] || 0;
  p.activity[today] = before + 1; p.xp += correct ? 10 : 2;
  if (p.lastDay !== today){ const y = dayKey(new Date(Date.now() - DAY)); p.streak = p.lastDay === y ? p.streak + 1 : 1; p.lastDay = today; }
  if (before < p.goal && before + 1 >= p.goal){ toast('Daily goal reached. Nice work!'); confetti(); }
  Store.saveProfile();
}

function norm(s){ return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\([^)]*\)/g,' ').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\b(the|a|an|to)\b/g,' ').replace(/\s+/g,' ').trim(); }
function lev(a, b){ const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let prev = Array.from({length:n+1}, (_,i)=>i); for (let i=1;i<=m;i++){ const cur=[i]; for (let j=1;j<=n;j++) cur[j] = Math.min(prev[j]+1, cur[j-1]+1, prev[j-1] + (a[i-1]===b[j-1]?0:1)); prev = cur; } return prev[n]; }
function grade(input, answer){
  const u = norm(plain(input)); if (!u) return 'wrong';
  const ans = plain(answer);
  const alts = [ans, ...ans.split(/[\/;,]| or /)].map(norm).filter(Boolean);
  if (alts.includes(u)) return 'right';
  for (const a of alts){ const tol = Math.max(1, Math.floor(a.length * 0.18)); if (a.length >= 4 && lev(u, a) <= tol) return 'close'; }
  return 'wrong';
}

function frontIs(deck){ return deck.opts?.front === 'def' ? 'def' : 'term'; }
function Q(deck, c){ return frontIs(deck) === 'term' ? c.term : c.def; }
function A(deck, c){ return frontIs(deck) === 'term' ? c.def : c.term; }
function QI(deck, c){ return frontIs(deck) === 'term' ? c.termImg : c.defImg; }
function AI_(deck, c){ return frontIs(deck) === 'term' ? c.defImg : c.termImg; }
function qLang(deck){ return frontIs(deck) === 'term' ? deck.termLang : deck.defLang; }
function aLang(deck){ return frontIs(deck) === 'term' ? deck.defLang : deck.termLang; }
function qName(deck){ return frontIs(deck) === 'term' ? 'Term' : 'Definition'; }
function aName(deck){ return frontIs(deck) === 'term' ? 'Definition' : 'Term'; }
function hasAText(d, c){ return !!plain(A(d, c)).trim(); }
function pool(deck){
  const f = deck.opts?.filter || 'all';
  const cs = deck.cards.filter(complete);
  if (f === 'starred'){ const s = cs.filter(c => c.starred); if (s.length) return s; }
  if (f === 'work'){ const s = cs.filter(needsWork); if (s.length) return s; }
  return cs;
}
const isLong = s => String(s).length > 90;
const imgTag = (src, cls='cimg') => (src = safeImg(src)) ? `<img class="${cls}" src="${src}" alt="" loading="lazy" decoding="async">` : '';
/* text + image block for any side of a card */
function sideHTML(text, img, big){
  const t = String(text || '').trim();
  return `${imgTag(img, big ? 'cimg' : 'cimg sm')}${t ? `<span class="stxt">${fmt(t)}</span>` : ''}`;
}

/* ---------------- speech ---------------- */
function speak(text, lang){
  const t = plain(text).replace(/_{2,}/g, 'blank').trim(); if (!t) return;
  if (!('speechSynthesis' in window)) return toast('Read-aloud is not supported in this browser');
  speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = lang || 'en-US'; u.rate = 0.95; speechSynthesis.speak(u);
}

/* ---------------- toast, modal, menus, confetti, count-up ---------------- */
let toastTimer;
function toast(msg, action){
  $('.toast')?.remove(); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role','status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  document.body.appendChild(el);
  const out = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  if (action) $('.toast-btn', el).onclick = () => { out(); action.fn(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(out, action ? 7000 : 2800);
}
let modalOnClose = null;
function modal(html, onMount, onClose){
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg" data-act="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  modalOnClose = onClose || null;
  const first = $('.modal input:not([type=file]), .modal textarea, .modal button', root); first && first.focus();
  onMount && onMount($('.modal', root));
}
function closeModal(){
  const root = $('#modal-root'), ghost = root.firstElementChild, had = !!ghost;
  root.innerHTML = '';
  if (ghost && !reduceMotion){ $$('[id]', ghost).forEach(n => n.removeAttribute('id')); ghost.classList.add('closing'); document.body.appendChild(ghost); setTimeout(() => ghost.remove(), 200); }
  const f = modalOnClose; modalOnClose = null; if (had && f) f();
}
function confirmBox(title, body, okLabel, onOk, danger){
  modal(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="ok" ${danger ? 'style="background:var(--bad);box-shadow:none"' : ''}>${esc(okLabel)}</button></div>`,
    m => { $('#ok', m).onclick = () => { modalOnClose = null; closeModal(); onOk(); }; });
}
function promptBox(title, label, value, okLabel, onOk, type='text'){
  modal(`<h2>${esc(title)}</h2><div class="field"><label for="pb">${esc(label)}</label><input class="input" id="pb" type="${type}" value="${esc(value)}"></div><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="ok">${esc(okLabel)}</button></div>`,
    m => { const go_ = () => { const v = $('#pb', m).value; if (!String(v).trim()) return $('#pb', m).focus(); modalOnClose = null; closeModal(); onOk(v); }; $('#ok', m).onclick = go_; $('#pb', m).onkeydown = e => { if (e.key === 'Enter') go_(); }; });
}
function closeMenu(){ $$('.menu').forEach(m => m.remove()); }
function openMenu(btn, items){
  const had = btn.parentElement.querySelector('.menu'); closeMenu(); if (had) return;
  const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role','menu');
  m.innerHTML = items.map(([act, label, ic, cls]) => `<button data-act="${act}" role="menuitem" class="${cls || ''}">${ic || ''}<span>${label}</span></button>`).join('');
  btn.parentElement.appendChild(m); $('button', m)?.focus();
}
function confetti(){
  if (reduceMotion) return;
  const cv = $('#fx'), ctx = cv.getContext('2d'); cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  const cols = ['#5B4BFF','#8A5CFF','#FF6B8B','#FFC53D','#0FA37A','#4FC3F7'];
  const ps = Array.from({length:140}, () => ({ x:innerWidth/2 + (Math.random()-0.5)*80, y:innerHeight*0.4, vx:(Math.random()-0.5)*16, vy:Math.random()*-14-4, r:Math.random()*7+4, c:cols[Math.floor(Math.random()*cols.length)], a:Math.random()*6, va:(Math.random()-0.5)*0.35 }));
  let t = 0;
  (function f(){ ctx.clearRect(0,0,innerWidth,innerHeight); ps.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += 0.38; p.vx *= 0.985; p.a += p.va; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r/2,-p.r/4,p.r,p.r/2); ctx.restore(); }); if (++t < 120) requestAnimationFrame(f); else ctx.clearRect(0,0,innerWidth,innerHeight); })();
}
function countUp(el){
  const to = +el.dataset.count, suf = el.dataset.suffix || '', dec = +(el.dataset.dec || 0);
  if (reduceMotion){ el.textContent = to.toFixed(dec) + suf; return; }
  const t0 = performance.now(), dur = 900;
  (function f(now){ const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = (to * e).toFixed(dec) + suf; if (p < 1) requestAnimationFrame(f); })(t0);
}

/* ---------------- images ---------------- */
async function compressImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const max = 900, k = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}
function zoomImage(src){ src = safeImg(src); if (!src) return; modal(`<img src="${src}" alt="" style="width:100%;border-radius:14px"><div class="row" style="justify-content:flex-end"><button class="btn" data-act="modal-close">Close</button></div>`); }

/* ---------------- focus timer (Pomodoro) ---------------- */
const Focus = { mode:null, end:0, left:0, paused:false, focusMin:25, breakMin:5, iv:null };
function beep(){ try { const ac = new (window.AudioContext || window.webkitAudioContext)(); [0, .28, .56].forEach(t => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.0001, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.22); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.25); }); } catch(e){} }
function focusStart(fm, bm){ Object.assign(Focus, { focusMin:fm, breakMin:bm, mode:'focus', paused:false, end:Date.now() + fm*MIN }); clearInterval(Focus.iv); Focus.iv = setInterval(focusTick, 1000); focusTick(); }
function focusStop(){ clearInterval(Focus.iv); Focus.mode = null; document.title = 'Recall'; focusTick(); }
function focusLeft(){ return Focus.paused ? Focus.left : Math.max(0, Focus.end - Date.now()); }
function mmss(ms){ const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60; return m + ':' + String(s).padStart(2, '0'); }
function focusTick(){
  const chip = $('#focus-chip'); if (!chip) return;
  if (!Focus.mode){ chip.classList.add('hidden'); return; }
  if (!Focus.paused && Focus.end - Date.now() <= 0){
    beep();
    if (Focus.mode === 'focus'){ S.profile.focus = (S.profile.focus || 0) + 1; Store.saveProfile(); Focus.mode = 'break'; Focus.end = Date.now() + Focus.breakMin*MIN; toast(`Focus session done! Take a ${Focus.breakMin}-minute break.`); }
    else { Focus.mode = 'focus'; Focus.end = Date.now() + Focus.focusMin*MIN; toast('Break is over. Back to it!'); }
  }
  const left = focusLeft();
  chip.classList.remove('hidden'); chip.classList.toggle('brk', Focus.mode === 'break');
  chip.innerHTML = `${Focus.mode === 'focus' ? I.target : I.coffee}<span>${Focus.paused ? 'Paused ' : ''}${mmss(left)}</span>`;
  document.title = Focus.paused ? 'Recall' : `${mmss(left)} ${Focus.mode === 'focus' ? 'focus' : 'break'} · Recall`;
  const big = $('#focus-big'); if (big) big.textContent = mmss(left);
}
function timerModal(){
  if (!Focus.mode){
    modal(`<h2>Focus timer</h2><p class="muted">Study in focused blocks with short breaks (the Pomodoro technique). The timer keeps running while you move around Recall, and beeps when it's time for a break.</p>
      <div class="stack" style="gap:8px">
        <button class="btn primary big" data-act="focus-go" data-f="25" data-b="5">25 min focus · 5 min break</button>
        <button class="btn" data-act="focus-go" data-f="50" data-b="10">50 min focus · 10 min break</button>
        <button class="btn" data-act="focus-go" data-f="90" data-b="15">90 min deep work · 15 min break</button>
      </div>
      ${S.profile.focus ? `<p class="small muted">You've finished ${S.profile.focus} focus ${S.profile.focus === 1 ? 'session' : 'sessions'} so far.</p>` : ''}`);
  } else {
    modal(`<p class="muted" style="font-weight:700">${Focus.mode === 'focus' ? 'Focus time' : 'Break time'}</p>
      <div class="bigscore" id="focus-big" style="text-align:center">${mmss(focusLeft())}</div>
      <div class="row center"><button class="btn primary" data-act="focus-pause">${Focus.paused ? I.play + ' Resume' : I.pause + ' Pause'}</button><button class="btn" data-act="focus-skip">Skip to ${Focus.mode === 'focus' ? 'break' : 'focus'}</button><button class="btn ghost" data-act="focus-stop">Stop timer</button></div>`);
  }
}

/* ---------------- router ---------------- */
function go(name, params = {}){
  cleanup.forEach(f => { try { f(); } catch(e){} }); cleanup = [];
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (name === 'combo') COMBO = null;
  V = { name, ...params }; T = {}; keysFor = null; closeMenu(); modalOnClose = null; closeModal();
  transition(() => { animateView = true; render(); window.scrollTo({ top:0, behavior:'instant' }); });
}
const VIEWS = {};
function render(){
  const animate = animateView;
  (VIEWS[V.name] || VIEWS.home)();
  app.classList.remove('view-in');
  if (animate){ void app.offsetWidth; app.classList.add('view-in'); }
  animateView = false;
  const apply = () => {
    $$('[data-w]').forEach(el => el.style.width = el.dataset.w + '%');
    $$('[data-h]').forEach(el => el.style.height = el.dataset.h + 'px');
    $$('[data-off]').forEach(el => el.style.strokeDashoffset = el.dataset.off);
    $$('[data-count]').forEach(el => animate ? countUp(el) : (el.textContent = (+el.dataset.count).toFixed(+(el.dataset.dec || 0)) + (el.dataset.suffix || '')));
  };
  if (animate) requestAnimationFrame(() => requestAnimationFrame(apply));
  else { app.classList.add('no-trans'); apply(); void app.offsetWidth; requestAnimationFrame(() => app.classList.remove('no-trans')); }
}
/* smooth page changes with the View Transitions API where the browser supports it */
function transition(fn){
  if (document.startViewTransition && !reduceMotion && document.visibilityState === 'visible'){ try { document.startViewTransition(fn); return; } catch(e){} }
  fn();
}
function sub(){ animateView = false; render(); }

/* =========================================================
   HOME
   ========================================================= */
function ring(pct){
  const r = 19, c = 2*Math.PI*r, off = c * (1 - Math.min(1, pct));
  return `<svg class="ring" viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="${r}" stroke="var(--surface-3)"/><circle cx="23" cy="23" r="${r}" stroke="${pct>=1?'var(--good)':'var(--accent)'}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-off="${off}" transform="rotate(-90 23 23)"/></svg>`;
}
function weekBars(){
  const vals = [];
  for (let i = 6; i >= 0; i--){ const d = new Date(Date.now() - i*DAY); vals.push({ v:S.profile.activity[dayKey(d)] || 0, l:'SMTWTFS'[d.getDay()] }); }
  const max = Math.max(10, ...vals.map(x => x.v));
  return `<div class="week" aria-label="Answers over the last 7 days">${vals.map(x => `<div><i class="${x.v?'on':''}" style="height:4px" data-h="${Math.max(4, x.v/max*32)}" title="${x.v} answers"></i><span>${x.l}</span></div>`).join('')}</div>`;
}
function mbar(d){
  const k = deckCounts(d), n = d.cards.length || 1;
  return `<div class="mbar" aria-hidden="true"><span class="g" data-w="${k.mastered/n*100}"></span><span class="w" data-w="${k.learning/n*100}"></span></div>`;
}
function quickStudy(){
  const st = starredTotals(), wk = workTotals();
  if (!st.n && !wk.n) return '';
  return `<div class="section-head"><h2>Quick study</h2></div><div class="quick stagger">
    ${st.n ? `<button class="qs" data-act="combo-starred" style="--i:0"><span class="qs-ic" style="background:linear-gradient(135deg,#F5B400,#FFD54F)">${I.star}</span><span><b>Starred cards</b><span class="small muted">${st.n} ${st.n===1?'card':'cards'} from ${st.decks.length} ${st.decks.length===1?'deck':'decks'} — your exam must-knows</span></span>${I.right}</button>` : ''}
    ${wk.n ? `<button class="qs" data-act="combo-work" style="--i:1"><span class="qs-ic" style="background:linear-gradient(135deg,#E5364F,#FF7A8E)">${I.target}</span><span><b>Needs work</b><span class="small muted">${wk.n} ${wk.n===1?'card':'cards'} you keep getting wrong, across all decks</span></span>${I.right}</button>` : ''}
  </div>`;
}
function miniRing(pct){
  const r = 15, c = 2 * Math.PI * r, off = c * (1 - pct);
  return `<span class="mini-ring" title="${Math.round(pct * 100)}% mastered"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="${r}" stroke="var(--surface-3)"/><circle cx="18" cy="18" r="${r}" stroke="${pct >= 1 ? 'var(--good)' : 'var(--accent)'}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-off="${off}" transform="rotate(-90 18 18)"/></svg><b>${Math.round(pct * 100)}</b></span>`;
}
function deckTile(d, i){
  const k = deckCounts(d); const c = courseById(d.course);
  return `<button class="deck" data-act="open-deck" data-id="${d.id}" style="--i:${i};${c ? '--cc:' + c.color : ''}">
      <span class="face-bg"></span>${c ? '<span class="deck-stripe"></span>' : ''}
      <div class="deck-top"><h3>${esc(d.title || 'Untitled deck')}</h3>${miniRing(d.cards.length ? k.mastered / d.cards.length : 0)}</div>
      <div class="row" style="gap:6px">${courseTag(d)}<span class="pill">${d.cards.length} ${d.cards.length===1?'card':'cards'}</span>${k.due ? `<span class="pill due">${k.due} to review</span>` : ''}${examPill(d)}</div>
      ${mbar(d)}
      <div class="legend"><span><i style="background:var(--good)"></i>${k.mastered} mastered</span><span><i style="background:var(--warn)"></i>${k.learning} learning</span><span><i style="background:var(--surface-3)"></i>${k.new} new</span></div>
    </button>`;
}
VIEWS.home = () => {
  if (!S.decks.length) return homeEmpty();
  const p = S.profile, allDue = S.decks.reduce((s,d)=>s+deckCounts(d).due, 0), totalNew = S.decks.reduce((s,d)=>s+deckCounts(d).fresh, 0);
  const newN = Math.min(totalNew, newLeftToday()), queueN = allDue + newN;
  const mastered = S.decks.reduce((s,d)=>s+deckCounts(d).mastered, 0), total = S.decks.reduce((s,d)=>s+d.cards.length, 0);
  const todayN = p.activity[dayKey()] || 0;
  const streak = (p.lastDay === dayKey() || p.lastDay === dayKey(new Date(Date.now()-DAY))) ? p.streak : 0;
  const hr = new Date().getHours(), hello = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const exams = S.decks.filter(d => d.examDate && daysUntil(d.examDate) >= 0).sort((a,b) => a.examDate.localeCompare(b.examDate)).slice(0, 6);
  const cs = courses(), filt = cs.find(c => c.id === p.homeCourse) || p.homeCourse === '_none' ? p.homeCourse : '';
  const unassigned = S.decks.filter(d => !courseById(d.course));
  let decksHTML = '', i = 0;
  if (!cs.length || filt){
    const list = !filt ? S.decks : filt === '_none' ? unassigned : S.decks.filter(d => d.course === filt);
    decksHTML = `<div class="decks stagger">${list.map(d => deckTile(d, i++)).join('')}<button class="deck deck-add" data-act="new-deck" style="--i:${i}">${I.plus}<span>New deck</span></button></div>`;
  } else {
    decksHTML = cs.filter(c => S.decks.some(d => d.course === c.id)).map(c => `
      <div class="course-group"><div class="course-row-h"><h3 class="course-h"><i style="background:${c.color}"></i>${esc(c.name)}<span class="muted small">${(n => n + (n === 1 ? ' deck' : ' decks'))(S.decks.filter(d => d.course === c.id).length)}</span></h3>${S.decks.filter(d => d.course === c.id).length > 1 ? `<button class="btn ghost" data-act="combo-course" data-ids="${S.decks.filter(d => d.course === c.id).map(d => d.id).join(',')}">${I.layers} Study all ${esc(c.name)}</button>` : ''}</div>
      <div class="decks stagger">${S.decks.filter(d => d.course === c.id).map(d => deckTile(d, i++)).join('')}</div></div>`).join('')
      + (unassigned.length ? `<div class="course-group"><h3 class="course-h"><i style="background:var(--surface-3)"></i>Other decks</h3><div class="decks stagger">${unassigned.map(d => deckTile(d, i++)).join('')}</div></div>` : '')
      + `<div class="decks"><button class="deck deck-add" data-act="new-deck" style="min-height:110px">${I.plus}<span>New deck</span></button></div>`;
  }
  app.innerHTML = `
  <section class="today">
    <div class="panel today-main">
      <p style="font-weight:700">${hello}</p>
      <h1>${queueN ? `${queueN} ${queueN===1?'card':'cards'} to review today` : "You're all caught up"}</h1>
      <p>${queueN ? 'Smart Review picks the cards you are about to forget, across all your decks. About ' + Math.max(1, Math.round(queueN * 8 / 60)) + ' min.' : 'Nothing is due right now. Come back later, or play a quick game to keep it fresh.'}</p>
      <div class="row" style="margin-top:4px">
        ${queueN ? `<button class="btn big light" data-act="review-all">${I.review} Start review</button>` : ''}
        <button class="btn ${queueN ? 'glass' : 'big light'}" data-act="new-deck">${I.plus} New deck</button>
        <button class="btn glass" data-act="timer">${I.clock} Focus timer</button>
      </div>
    </div>
    <div class="today-side">
      <div class="statcard">${ring(todayN / p.goal)}<div style="flex:1"><div class="big" data-count="${todayN}">0</div><div class="lbl">of ${p.goal} answers today · <button class="linkbtn" data-act="set-goal">change goal</button></div></div></div>
      <div class="statcard"><div class="ico" style="background:var(--warn-soft);color:var(--warn)">${I.flame}</div><div><div class="big" data-count="${streak}">0</div><div class="lbl">day streak</div></div>${weekBars()}</div>
      <div class="statcard"><div class="ico" style="background:var(--good-soft);color:var(--good)">${I.trophy}</div><div><div class="big" data-count="${mastered}">0</div><div class="lbl">of ${total} cards mastered</div></div></div>
    </div>
  </section>
  ${exams.length ? `<div class="section-head"><h2>Upcoming exams</h2><button class="linkbtn" data-act="exam-help">How is this calculated?</button></div>
  <div class="exams stagger">${exams.map((d, k) => { const e = examInfo(d), c = courseById(d.course); return `
    <button class="exam" data-act="open-deck" data-id="${d.id}" style="--i:${k};--cc:${c ? c.color : 'var(--accent)'}">
      <span class="exam-days ${e.n <= 3 ? 'soon' : ''}"><b>${e.n === 0 ? '!' : e.n}</b><span>${e.n === 0 ? 'today' : e.n === 1 ? 'day left' : 'days left'}</span></span>
      <span class="exam-body">${c ? `<span class="ctag" style="--cc:${c.color}"><i></i>${esc(c.name)}</span>` : ''}<b>${esc(d.title)}</b>
      <span class="small muted">${niceDate(d.examDate)} · ${e.pct}% mastered</span>
      <span class="small" style="font-weight:700;color:${e.left ? 'var(--accent)' : 'var(--good)'}">${e.left ? `Learn about ${e.perDay} ${e.perDay===1?'card':'cards'} a day to be ready` : 'Ready! Keep reviewing.'}</span></span>
    </button>`; }).join('')}</div>` : ''}
  ${quickStudy()}
  <div class="section-head"><h2>Your decks</h2><div class="row"><button class="btn" data-act="combo-open">${I.layers} Study decks together</button><button class="btn ghost" data-act="import-file">${I.upload} Import</button></div></div>
  ${cs.length ? `<div class="chips" role="group" aria-label="Filter by course">
    <button class="chip" data-act="home-course" data-v="" aria-pressed="${!filt}">All</button>
    ${cs.map(c => `<button class="chip" data-act="home-course" data-v="${c.id}" aria-pressed="${filt===c.id}"><i style="background:${c.color}"></i>${esc(c.name)}</button>`).join('')}
    ${unassigned.length ? `<button class="chip" data-act="home-course" data-v="_none" aria-pressed="${filt==='_none'}">No course</button>` : ''}
    <button class="chip ghost" data-act="courses">${I.folder} Manage courses</button></div>`
  : `<p class="small muted" style="margin:-4px 0 14px">Tip: group decks by class with <button class="linkbtn" data-act="courses">courses</button>, and add an exam date to get a countdown and study plan.</p>`}
  ${decksHTML}
  <p class="hint-line">You can also drag a CSV, text or backup file anywhere onto this page to import it.</p>
  <input type="file" id="filein" accept=".json,.csv,.txt,.tsv" class="hidden">`;
  $('#filein').onchange = e => importFile(e.target.files[0]);
};
function homeEmpty(){
  app.innerHTML = `
  <section class="welcome">
    <div>
      <h1>Study smarter for every class.</h1>
      <p class="lead">Make flashcards for your courses, then study them seven different ways. Recall tracks what you know, counts down to your exams, and brings cards back right before you'd forget them.</p>
      <div class="row" style="margin-top:26px"><button class="btn primary big" data-act="new-deck">${I.plus} Create your first deck</button><button class="btn ghost big" data-act="help">${I.help} How it works</button></div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="hero-card"><small>Term</small>H₂O + CO₂</div>
      <div class="hero-card"><small>Term</small>Mitosis</div>
      <div class="hero-card"><small>Definition</small>powerhouse of the cell</div>
    </div>
  </section>
  <div class="starts stagger">
    <button class="start" data-act="new-deck" style="--i:0"><span class="ic g-flash">${I.type}</span><b>Type your cards</b><span>Add terms, definitions and images one at a time.</span></button>
    <button class="start" data-act="new-paste" style="--i:1"><span class="ic g-learn">${I.paste}</span><b>Paste a list</b><span>From Quizlet, Anki, Excel, Google Docs or your lecture notes.</span></button>
    <button class="start" data-act="import-file" style="--i:2"><span class="ic g-review">${I.upload}</span><b>Import a file</b><span>A .csv or .txt file, or a Recall backup.</span></button>
  </div>
  <input type="file" id="filein" accept=".json,.csv,.txt,.tsv" class="hidden">`;
  $('#filein').onchange = e => importFile(e.target.files[0]);
}

/* =========================================================
   DECK
   ========================================================= */
const MODES = {
  flash:{ name:'Flashcards', desc:'Flip through cards and sort what you know.', ic:'cards', g:'g-flash' },
  learn:{ name:'Learn', desc:'Guided quiz that gets harder as you improve.', ic:'learn', g:'g-learn' },
  review:{ name:'Smart Review', desc:'Only the cards due today, spaced for memory.', ic:'review', g:'g-review' },
  write:{ name:'Write', desc:'Type every answer from memory.', ic:'write', g:'g-write' },
  test:{ name:'Practice test', desc:'A graded mock exam with mixed questions.', ic:'test', g:'g-test' },
  match:{ name:'Match', desc:'Pair terms and definitions against the clock.', ic:'match', g:'g-match' },
  blitz:{ name:'Blitz', desc:'Type answers before they hit the floor.', ic:'blitz', g:'g-blitz' },
  gap:{ name:'Fill the gap', desc:'Key words vanish from definitions. Type them back.', ic:'gap', g:'g-gap' },
  explain:{ name:'Explain it', desc:'Explain each idea in your own words, then compare.', ic:'bulb', g:'g-explain' },
  dump:{ name:'Brain dump', desc:'List everything you remember, see what you forgot.', ic:'brain', g:'g-dump' },
  listen:{ name:'Listen & spell', desc:'Hear a term read aloud and type it. Great for languages.', ic:'ear', g:'g-listen' },
  quick:{ name:'Quick Fire', desc:'60 seconds of true or false. Build a streak.', ic:'bolt', g:'g-quick' },
};
function suggestion(d){
  const k = deckCounts(d), newN = Math.min(k.fresh, newLeftToday()), e = examInfo(d);
  if (e && e.n >= 0 && e.n <= 7){
    if (e.left > d.cards.length * 0.3) return { m:'learn', why:`Your exam is ${e.n === 0 ? 'today' : e.n === 1 ? 'tomorrow' : 'in ' + e.n + ' days'} and ${e.left} cards aren't mastered yet. Learn them first.` };
    return { m:'test', why:`Your exam is ${e.n === 0 ? 'today' : e.n === 1 ? 'tomorrow' : 'in ' + e.n + ' days'}. Take a mock exam to find any gaps.` };
  }
  if (k.due) return { m:'review', why:`${k.due} ${k.due===1?'card is':'cards are'} due. Reviewing now locks them into long-term memory.` };
  if (k.new === d.cards.length) return { m:'flash', why:'Start by flipping through every card once to see what is in this deck.' };
  if (k.new + k.learning > k.mastered) return { m:'learn', why:`You have ${k.new + k.learning} cards still to learn. Learn quizzes you until they stick.` };
  if (newN) return { m:'review', why:'Add the remaining new cards to your review schedule.' };
  return { m:'test', why:'You know most of this deck. Check yourself with a practice test.' };
}
function seg(name, opts, cur){
  return `<div class="seg" role="group" data-seg>${opts.map(([v,l]) => `<button data-act="${name}" data-v="${v}" aria-pressed="${cur===v}">${l}</button>`).join('')}<span class="thumb"></span></div>`;
}
function placeThumbs(){ $$('[data-seg]').forEach(s => { const on = $('[aria-pressed="true"]', s), th = $('.thumb', s); if (on && th){ th.style.left = on.offsetLeft + 'px'; th.style.width = on.offsetWidth + 'px'; } }); }
VIEWS.deck = () => {
  const d = deckById(V.id); if (!d) return go('home');
  d.opts = d.opts || {};
  const k = deckCounts(d), f = d.opts.filter || 'all', ready = pool({ ...d, opts:{} }).length >= 2;
  const sg = ready ? suggestion(d) : null, reviewN = k.due + Math.min(k.fresh, newLeftToday());
  const e = examInfo(d), c = courseById(d.course);
  const modeBtn = id => { const m = MODES[id]; return `<button class="mode" data-act="mode" data-v="${id}"><span class="ic ${m.g}">${I[m.ic]}</span><span><b>${m.name}${id==='review' && reviewN ? ` <span class="pill due" style="font-size:12px;margin-left:4px;display:inline-flex;padding:1px 8px">${reviewN}</span>` : ''}</b><span>${m.desc}</span></span></button>`; };
  app.innerHTML = `
  <div><button class="back" data-act="home">${I.left} All decks</button></div>
  <div class="deck-hero">
    <div class="row between" style="align-items:flex-start;flex-wrap:nowrap">
      <div class="stack" style="gap:8px;min-width:0">
        ${c ? `<div class="row" style="gap:10px"><span class="ctag" style="--cc:${c.color}"><i></i>${esc(c.name)}</span>${S.decks.filter(x => x.course === c.id).length > 1 ? `<button class="linkbtn small" data-act="combo-course" data-ids="${S.decks.filter(x => x.course === c.id).map(x => x.id).join(',')}">Study all ${esc(c.name)} decks together</button>` : ''}</div>` : ''}
        <h1 style="overflow-wrap:anywhere">${esc(d.title || 'Untitled deck')}</h1>${d.desc ? `<p class="muted">${esc(d.desc)}</p>` : ''}
      </div>
      <div class="row" style="flex-wrap:nowrap">
        <button class="btn" data-act="edit-deck">${I.edit} Edit</button>
        <div class="menu-wrap"><button class="icon-btn" data-act="deck-menu" aria-label="More options" aria-haspopup="true">${I.dots}</button></div>
      </div>
    </div>
    ${mbar(d)}
    <div class="legend"><span><i style="background:var(--good)"></i>${k.mastered} mastered</span><span><i style="background:var(--warn)"></i>${k.learning} still learning</span><span><i style="background:var(--surface-3)"></i>${k.new} not started</span></div>
  </div>
  ${e ? `<div class="exam-banner ${e.n >= 0 && e.n <= 3 ? 'soon' : ''}">
      <span class="ic">${I.cal}</span>
      <div style="flex:1;min-width:0"><b>${e.n < 0 ? `Exam was ${-e.n} ${e.n === -1 ? 'day' : 'days'} ago` : e.n === 0 ? 'Exam today — good luck!' : `Exam in ${e.n} ${e.n === 1 ? 'day' : 'days'}`}</b>
      <div class="small muted">${niceDate(d.examDate)}${e.n > 0 ? ` · ${e.left ? `learn about <b>${e.perDay}</b> ${e.perDay===1?'card':'cards'} a day to master everything in time` : 'every card mastered — keep reviewing'}` : ''}</div></div>
      <button class="btn ghost" data-act="set-exam">Change</button></div>`
  : `<button class="exam-add" data-act="set-exam">${I.cal} Add an exam date to get a countdown and daily study plan</button>`}
  ${!ready ? `<div class="panel summary"><h2>Add at least 2 cards to start studying</h2><button class="btn primary" data-act="edit-deck">${I.plus} Add cards</button></div>` : `
  <div class="suggest">
    <span class="ic ${MODES[sg.m].g}">${I[MODES[sg.m].ic]}</span>
    <div class="txt"><div class="eyebrow">Recommended next</div><h3>${MODES[sg.m].name}</h3><p class="muted small">${sg.why}</p></div>
    <button class="btn primary big" data-act="mode" data-v="${sg.m}">Start</button>
  </div>
  <div class="settings">
    <label class="t">Study</label>${seg('filter', [['all','All cards'],['starred',`Starred (${d.cards.filter(c=>c.starred).length})`],['work',`Needs work (${d.cards.filter(needsWork).length})`]], f)}
    <label class="t">Card front shows</label>${seg('front', [['term','Term'],['def','Definition']], frontIs(d))}
  </div>
  <p class="group-title">Study</p><div class="modes">${['flash','learn','review'].map(modeBtn).join('')}</div>
  <p class="group-title">Test yourself</p><div class="modes">${['test','write','gap','explain','dump','listen'].map(modeBtn).join('')}</div>
  <p class="group-title">Games</p><div class="modes">${['match','quick','blitz'].map(modeBtn).join('')}</div>`}
  <div class="section-head" style="margin-top:10px"><h2>Cards <span class="muted" style="font-weight:600">${d.cards.length}</span></h2><button class="btn" data-act="edit-deck">${I.plus} Add cards</button></div>
  <div class="cardlist">${d.cards.map(c => { const m = mastery(c); return `
    <div class="crow" data-card="${c.id}">
      <div class="t"><span class="dot" style="background:${m==='mastered'?'var(--good)':m==='learning'?'var(--warn)':'var(--surface-3)'}" title="${m==='new'?'Not started':m==='learning'?'Still learning':'Mastered'}"></span>${sideHTML(c.term, c.termImg)} ${needsWork(c) ? '<span class="pill bad" style="margin-left:4px">needs work</span>' : ''}${!complete(c) ? '<span class="pill warn">missing a side</span>' : ''}</div>
      <div class="d">${sideHTML(c.def, c.defImg)}</div>
      <div class="acts">
        <button class="icon-btn flat" data-act="speak-card" data-id="${c.id}" aria-label="Read aloud" title="Read aloud">${I.speak}</button>
        <button class="icon-btn flat" data-act="star" data-id="${c.id}" aria-pressed="${c.starred}" aria-label="${c.starred?'Unstar':'Star'}" title="Star">${c.starred ? I.star : I.starO}</button>
      </div>
    </div>`; }).join('')}</div>`;
  requestAnimationFrame(placeThumbs);
  if (V.focus){ const row = $(`[data-card="${V.focus}"]`); V.focus = null; if (row) setTimeout(() => { row.scrollIntoView({ block:'center', behavior: reduceMotion ? 'auto' : 'smooth' }); row.classList.add('hl'); }, 350); }
};
function examModal(d){
  modal(`<h2>Exam date</h2><p class="muted">Recall will count down to your exam and tell you how many cards to learn each day to be ready in time.</p>
    <div class="field"><label for="ex-d">Exam date for "${esc(d.title)}"</label><input class="input" type="date" id="ex-d" value="${esc(d.examDate || '')}" min="${dayKey()}"></div>
    <div class="row" style="justify-content:space-between">${d.examDate ? '<button class="btn ghost" id="ex-rm" style="color:var(--bad)">Remove date</button>' : '<span></span>'}<div class="row"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="ex-ok">Save</button></div></div>`, m => {
    $('#ex-ok', m).onclick = () => { const v = $('#ex-d', m).value; if (!v) return $('#ex-d', m).focus(); d.examDate = v; Store.saveDeck(d); closeModal(); toast('Exam date saved'); sub(); };
    const rm = $('#ex-rm', m); if (rm) rm.onclick = () => { d.examDate = ''; Store.saveDeck(d); closeModal(); sub(); };
  });
}
function coursesModal(){
  const cs = courses();
  modal(`<h2>Courses</h2><p class="muted">Group your decks by class. Each course gets a color so you can spot it at a glance.</p>
    <div class="stack" style="gap:8px">${cs.map(c => `<div class="course-row">
      <button class="swatch" data-act="c-color" data-id="${c.id}" style="background:${c.color}" aria-label="Change color of ${esc(c.name)}" title="Change color"></button>
      <input class="input" value="${esc(c.name)}" data-cname="${c.id}" aria-label="Course name">
      <span class="muted small" style="white-space:nowrap">${(n => n + (n === 1 ? ' deck' : ' decks'))(S.decks.filter(d => d.course === c.id).length)}</span>
      <button class="icon-btn flat" data-act="c-del" data-id="${c.id}" aria-label="Delete course ${esc(c.name)}" title="Delete course">${I.trash}</button></div>`).join('') || '<p class="small muted">No courses yet. Add your first one below.</p>'}</div>
    <div class="row" style="flex-wrap:nowrap"><input class="input" id="c-new" placeholder="e.g. BIOL 1010 or Organic Chemistry" maxlength="60"><button class="btn" id="c-add">${I.plus} Add</button></div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="modal-close">Done</button></div>`, m => {
    const add = () => { const v = $('#c-new', m).value.trim(); if (!v) return $('#c-new', m).focus(); addCourse(v); coursesModal(); setTimeout(() => $('#c-new')?.focus(), 30); };
    $('#c-add', m).onclick = add; $('#c-new', m).onkeydown = e => { if (e.key === 'Enter') add(); };
    $$('[data-cname]', m).forEach(inp => inp.onchange = () => { const c = courseById(inp.dataset.cname); if (c && inp.value.trim()){ c.name = inp.value.trim().slice(0, 60); Store.saveProfile(); } });
  }, () => { if (!T.active) sub(); });
}

/* =========================================================
   STUDY SEVERAL DECKS TOGETHER
   ========================================================= */
VIEWS.combo = () => {
  const cfg = comboCfg(), sel = new Set(cfg.decks), cs = courses();
  const { decks, cards } = comboCards(cfg), combo = buildCombo();
  const allStar = comboCards({ ...cfg, filter:'starred' }).cards.length, allWork = comboCards({ ...cfg, filter:'work' }).cards.length;
  const row = d => { const st = d.cards.filter(c => c.starred).length; return `<label class="pick ${sel.has(d.id) ? 'on' : ''}"><input type="checkbox" data-pick="${d.id}" ${sel.has(d.id) ? 'checked' : ''}><span class="pick-t"><b>${esc(d.title)}</b><span class="small muted">${d.cards.length} cards${st ? ` · ★ ${st} starred` : ''}${d.examDate && daysUntil(d.examDate) >= 0 ? ' · exam ' + niceDate(d.examDate) : ''}</span></span></label>`; };
  const group = (title, color, list, cid) => { if (!list.length) return ''; const all = list.every(d => sel.has(d.id)); return `<div class="pick-group"><div class="pick-h"><span class="course-h" style="margin:0"><i style="background:${color}"></i>${title}</span><button class="linkbtn" data-act="pick-group" data-ids="${list.map(d => d.id).join(',')}" data-on="${all ? 0 : 1}">${all ? 'Deselect all' : 'Select all'}</button></div><div class="pick-list">${list.map(row).join('')}</div></div>`; };
  const n = cards.length, ok = n >= 2;
  const modeBtn = id => { const m = MODES[id]; return `<button class="mode" data-act="combo-mode" data-v="${id}" ${ok ? '' : 'disabled'}><span class="ic ${m.g}">${I[m.ic]}</span><span><b>${m.name}</b><span>${m.desc}</span></span></button>`; };
  app.innerHTML = `
  <div><button class="back" data-act="home">${I.left} All decks</button></div>
  <div class="stack" style="gap:8px;margin:6px 0 22px"><h1>Study decks together</h1><p class="muted" style="max-width:62ch">Pick any decks — one whole class, or a mix from different classes — and study them as one set. Perfect for cumulative exams. Your progress is saved back to each original deck.</p></div>
  <div class="combo-grid">
    <div class="panel stack" style="gap:16px;align-content:start">
      <div class="row" style="gap:8px"><span class="small muted" style="font-weight:700">Quick pick:</span>
        <button class="chip" data-act="pick-all">All decks</button>
        ${cs.filter(c => S.decks.some(d => d.course === c.id)).map(c => `<button class="chip" data-act="pick-only" data-ids="${S.decks.filter(d => d.course === c.id).map(d => d.id).join(',')}"><i style="background:${c.color}"></i>${esc(c.name)}</button>`).join('')}
        ${sel.size ? '<button class="chip ghost" data-act="pick-none">Clear</button>' : ''}
      </div>
      ${cs.map(c => group(esc(c.name), c.color, S.decks.filter(d => d.course === c.id))).join('')}
      ${group(cs.length ? 'Other decks' : 'Your decks', 'var(--surface-3)', S.decks.filter(d => !courseById(d.course)))}
    </div>
    <div class="combo-side">
      <div class="panel stack" style="gap:16px">
        <div><div class="combo-count" data-count="${n}">0</div><p class="muted small" style="font-weight:700">${n === 1 ? 'card' : 'cards'} from ${decks.length} ${decks.length === 1 ? 'deck' : 'decks'}</p></div>
        <div class="stack" style="gap:6px"><span class="small muted" style="font-weight:700">Which cards</span>${seg('combo-filter', [['all','All'],['starred',`★ Starred (${allStar})`],['work',`Needs work (${allWork})`]], cfg.filter)}</div>
        <div class="stack" style="gap:6px"><span class="small muted" style="font-weight:700">Card front shows</span>${seg('combo-front', [['term','Term'],['def','Definition']], cfg.front)}</div>
        ${cfg.filter === 'starred' && !allStar && sel.size ? '<p class="small" style="color:var(--warn);font-weight:700">None of these decks have starred cards yet. Tap ☆ on any card to star it.</p>' : ''}
        ${!sel.size ? '<p class="small muted">Tick at least one deck to start.</p>' : !ok && n < 2 && (cfg.filter === 'all' || n) ? '<p class="small muted">You need at least 2 cards to study.</p>' : ''}
      </div>
    </div>
  </div>
  <p class="group-title" style="margin-top:24px">Study ${esc(combo.title)}</p>
  <div class="modes">${['flash','learn','review','test','write','gap','explain','dump','listen','match','quick','blitz'].map(modeBtn).join('')}</div>`;
  requestAnimationFrame(placeThumbs);
  $$('[data-pick]').forEach(cb => cb.onchange = () => { const c = comboCfg(); c.decks = cb.checked ? [...new Set([...c.decks, cb.dataset.pick])] : c.decks.filter(x => x !== cb.dataset.pick); Store.saveProfile(); sub(); $(`[data-pick="${cb.dataset.pick}"]`)?.focus({ preventScroll:true }); });
};

/* =========================================================
   EDITOR
   ========================================================= */
const LANGS = [['en-US','English'],['es-ES','Spanish'],['fr-FR','French'],['de-DE','German'],['it-IT','Italian'],['pt-BR','Portuguese'],['ja-JP','Japanese'],['zh-CN','Chinese'],['ko-KR','Korean'],['ru-RU','Russian'],['ar-SA','Arabic'],['hi-IN','Hindi'],['la','Latin']];
VIEWS.edit = () => {
  if (!T.draft){
    const src = V.id ? deckById(V.id) : null;
    T.draft = src ? JSON.parse(JSON.stringify(src)) : { id:nid(), title:'', desc:'', course:V.course || '', examDate:'', termLang:'en-US', defLang:'en-US', createdAt:Date.now(), updatedAt:Date.now(), opts:{}, cards:[newCard(), newCard(), newCard()] };
    if (V.prefill){ T.draft.cards = [...V.prefill]; T.dirty = true; }
    if (V.title) T.draft.title = V.title;
    T.tab = V.tab || 'type'; T.isNew = !src;
  }
  const d = T.draft;
  const langSel = (id, v) => `<select class="input" id="${id}">${LANGS.map(([c,n])=>`<option value="${c}" ${c===v?'selected':''}>${n}</option>`).join('')}</select>`;
  const tabs = [['type','Type','One card at a time, with images', I.type], ['paste','Paste a list','From Quizlet, Anki, Excel, notes', I.paste]];
  app.innerHTML = `
  <div><button class="back" data-act="cancel-edit">${I.left} ${T.isNew ? 'Cancel' : 'Back to deck'}</button></div>
  <div class="panel stack" style="margin-top:8px">
    <input class="input title" id="d-title" value="${esc(d.title)}" placeholder="Deck name, e.g. Lecture 4: Cell respiration" maxlength="120" aria-label="Deck name">
    <input class="input" id="d-desc" value="${esc(d.desc)}" placeholder="Description (optional)" maxlength="300" aria-label="Description">
    <div class="row" style="align-items:flex-end">
      <div class="field" style="flex:1;min-width:180px"><label for="d-course">Course</label><select class="input" id="d-course"><option value="">No course</option>${courses().map(c => `<option value="${c.id}" ${c.id===d.course?'selected':''}>${esc(c.name)}</option>`).join('')}<option value="__new">+ New course…</option></select></div>
      <div class="field" style="flex:1;min-width:180px"><label for="d-exam">Exam date (optional)</label><input class="input" type="date" id="d-exam" value="${esc(d.examDate || '')}"></div>
    </div>
    <details class="more"><summary>Read-aloud languages</summary>
      <div class="row" style="align-items:flex-start;margin-top:12px">
        <div class="field" style="flex:1;min-width:160px"><label for="d-tl">Terms are in</label>${langSel('d-tl', d.termLang)}</div>
        <div class="field" style="flex:1;min-width:160px"><label for="d-dl">Definitions are in</label>${langSel('d-dl', d.defLang)}</div>
      </div></details>
  </div>
  <div class="addtabs" role="tablist" aria-label="How to add cards">${tabs.map(([v,b,s,ic]) => `<button class="addtab" role="tab" data-act="etab" data-v="${v}" aria-selected="${T.tab===v}"><span class="ic">${ic}</span><span><b>${b}</b><span>${s}</span></span></button>`).join('')}</div>
  <div id="etab"></div>
  <div class="savebar"><span class="muted small" id="card-count" style="margin-right:auto"></span><button class="btn ghost" data-act="cancel-edit">Cancel</button><button class="btn primary big" data-act="save-deck">${T.isNew ? 'Create deck' : 'Save changes'}</button></div>`;
  const dirty = () => T.dirty = true;
  $('#d-title').oninput = e => { d.title = e.target.value; dirty(); };
  $('#d-desc').oninput = e => { d.desc = e.target.value; dirty(); };
  $('#d-exam').onchange = e => { d.examDate = e.target.value; dirty(); };
  $('#d-course').onchange = e => {
    if (e.target.value === '__new'){ e.target.value = d.course || ''; promptBox('New course', 'Course name', '', 'Add course', v => { const c = addCourse(v); d.course = c.id; dirty(); sub(); }); }
    else { d.course = e.target.value; dirty(); }
  };
  $('#d-tl').onchange = e => { d.termLang = e.target.value; dirty(); }; $('#d-dl').onchange = e => { d.defLang = e.target.value; dirty(); };
  if (T.isNew && !d.title) setTimeout(() => $('#d-title')?.focus(), 350);
  renderETab(); updCount();
};
function updCount(){ const el = $('#card-count'); if (!el) return; const n = T.draft.cards.filter(c => complete(c) || cloze(c.term)).length; el.textContent = n + (n === 1 ? ' card' : ' cards'); }
function imgSlot(c, side){
  const src = c[side + 'Img'];
  return src ? `<span class="thumb-wrap"><img src="${src}" alt="" class="ethumb" data-act="zoom" data-src="${src}"><button class="thumb-x" data-act="img-rm" data-id="${c.id}" data-side="${side}" aria-label="Remove image">${I.x}</button></span>`
    : `<button class="img-btn" data-act="img-add" data-id="${c.id}" data-side="${side}">${I.image} Image</button>`;
}
function rowHTML(c, i){ return `
  <div class="erow" data-id="${c.id}">
    <span class="n">${i+1}</span>
    <div class="eside"><textarea class="input" rows="1" data-f="term" placeholder="Term" aria-label="Term ${i+1}">${esc(c.term)}</textarea><div class="eside-foot"><span class="cap">TERM</span><span class="slot" data-slot="term">${imgSlot(c, 'term')}</span></div></div>
    <div class="eside"><textarea class="input" rows="1" data-f="def" placeholder="Definition" aria-label="Definition ${i+1}">${esc(c.def)}</textarea><div class="eside-foot"><span class="cap">DEFINITION</span><span class="slot" data-slot="def">${imgSlot(c, 'def')}</span></div></div>
    <button class="icon-btn flat" data-act="del-row" data-id="${c.id}" aria-label="Delete card ${i+1}" title="Delete card">${I.trash}</button>
  </div>`; }
async function attachImage(c, side, file){
  if (!file || !file.type.startsWith('image/')) return;
  try { c[side + 'Img'] = await compressImage(file); T.dirty = true; const row = $(`.erow[data-id="${c.id}"]`); if (row) $(`[data-slot="${side}"]`, row).innerHTML = imgSlot(c, side); updCount(); }
  catch(e){ toast('That image could not be loaded.'); }
}
function wireRow(row){
  const card = () => T.draft.cards.find(x => x.id === row.dataset.id);
  $$('textarea', row).forEach(ta => {
    autoSize(ta);
    ta.oninput = () => { const c = card(); if (c){ c[ta.dataset.f] = ta.value; autoSize(ta); updCount(); T.dirty = true; } };
    ta.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f){ e.preventDefault(); attachImage(card(), ta.dataset.f, f); toast('Image added'); } });
  });
  $$('.eside', row).forEach(side => {
    side.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')){ e.preventDefault(); side.classList.add('drop'); } });
    side.addEventListener('dragleave', () => side.classList.remove('drop'));
    side.addEventListener('drop', e => { side.classList.remove('drop'); const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/')); if (!f) return; e.preventDefault(); e.stopPropagation(); attachImage(card(), $('textarea', side).dataset.f, f); });
  });
  const def = $('textarea[data-f="def"]', row);
  def.addEventListener('keydown', e => { if (e.key === 'Tab' && !e.shiftKey && row === $$('#erows .erow').pop()){ e.preventDefault(); addRow(); } });
}
function addRow(){
  const c = newCard(); T.draft.cards.push(c); T.dirty = true;
  const wrap = $('#erows'); wrap.insertAdjacentHTML('beforeend', rowHTML(c, T.draft.cards.length - 1));
  const row = wrap.lastElementChild; row.classList.add('new'); wireRow(row); $('textarea', row).focus();
  row.scrollIntoView({ block:'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}
function renderETab(){
  const d = T.draft, el = $('#etab');
  if (T.tab === 'type'){
    el.innerHTML = `<div class="tipbar">${I.help}<span><b>Formatting:</b> H_2O → H₂O · x^2 → x² · **bold** · *italic* · \\alpha → α · -&gt; → →. <b>Fill in the blank:</b> write a sentence with {{braces}} around the hidden word and leave the definition empty. <b>Images:</b> click Image, paste, or drag one onto a card. <button class="linkbtn" data-act="help">More tips</button></span></div>
      <div class="stack" id="erows" style="gap:10px">${d.cards.map(rowHTML).join('')}</div>
      <button class="btn block" style="margin-top:12px;min-height:54px;border-style:dashed" data-act="add-row">${I.plus} Add card</button>
      <p class="hint-line">Press <span class="kbd">Tab</span> in the last definition to add another card.</p>`;
    $$('#erows .erow').forEach(wireRow);
  } else if (T.tab === 'paste'){
    el.innerHTML = `<div class="panel stack">
      <div><h3>Paste your list</h3><p class="muted small" style="margin-top:4px">One card per line, term first. Works with Quizlet exports, Anki "Notes in plain text" exports, spreadsheets and most notes.</p></div>
      <textarea class="input" id="imp" rows="8" style="overflow:auto;resize:vertical" placeholder="photosynthesis&#9;how plants turn light into chemical energy&#10;osmosis&#9;diffusion of water across a membrane"></textarea>
      <div class="row">
        <div class="field"><label for="imp-sep">Term and definition are separated by</label><select class="input" id="imp-sep"><option value="tab">Tab (Excel, Sheets, Quizlet, Anki)</option><option value="comma">Comma</option><option value="dash">Dash ( - )</option><option value="colon">Colon ( : )</option><option value="custom">Something else…</option></select></div>
        <div class="field hidden" id="imp-custom-f"><label for="imp-custom">Separator</label><input class="input" id="imp-custom" value="=" style="width:90px"></div>
      </div>
      <div id="imp-preview"></div>
      <div class="row"><button class="btn primary" data-act="do-import" id="imp-go" disabled>Add cards</button><button class="btn ghost" data-act="import-file-edit">${I.upload} Choose a file instead</button></div>
      <input type="file" id="filein2" accept=".csv,.txt,.tsv" class="hidden">
    </div>`;
    const upd = () => {
      $('#imp-custom-f').classList.toggle('hidden', $('#imp-sep').value !== 'custom');
      const cards = parsePaste(); $('#imp-go').disabled = !cards.length; $('#imp-go').textContent = cards.length ? `Add ${cards.length} ${cards.length===1?'card':'cards'}` : 'Add cards';
      $('#imp-preview').innerHTML = cards.length ? `<p class="small muted" style="margin-bottom:8px">Preview</p><div class="cardlist">${cards.slice(0,3).map(c => `<div class="crow" style="grid-template-columns:1fr 1.5fr;padding:10px 14px"><div class="t">${fmt(c.term)}</div><div class="d">${fmt(c.def)}</div></div>`).join('')}${cards.length > 3 ? `<p class="small muted">and ${cards.length - 3} more</p>` : ''}</div>` : ($('#imp').value.trim() ? '<p class="small" style="color:var(--bad)">No cards found yet. Try a different separator.</p>' : '');
    };
    ['imp','imp-custom'].forEach(id => $('#'+id).addEventListener('input', upd)); $('#imp-sep').onchange = upd;
    $('#filein2').onchange = async e => { const f = e.target.files[0]; if (!f) return; $('#imp').value = await f.text(); if (/\.csv$/i.test(f.name)) $('#imp-sep').value = 'comma'; upd(); };
    setTimeout(() => $('#imp')?.focus(), 50);
  }
}
function autoSize(ta){ ta.style.height = 'auto'; ta.style.height = Math.max(46, ta.scrollHeight + 3) + 'px'; }
function parsePaste(){
  const text = $('#imp')?.value || '', sepV = $('#imp-sep').value;
  const sep = { tab:'\t', comma:',', dash:' - ', colon:':', custom: $('#imp-custom').value || '=' }[sepV];
  return parseText(text, sep);
}
function parseText(text, sep){
  return text.split(/\r?\n/).map(r => r.trim()).filter(r => r && !r.startsWith('#')).map(r => {
    let s = sep, i = r.indexOf(s);
    if (i < 0 && s === '\t'){ for (const alt of [' - ', ',', ':']){ i = r.indexOf(alt); if (i >= 0){ s = alt; break; } } }
    if (i < 0){ const cz = cloze(r); return cz ? newCard(r, '') : null; }
    const t = r.slice(0, i).trim().replace(/^"|"$/g,''), df = r.slice(i + s.length).trim().replace(/^"|"$/g,'').replace(/""/g,'"').replace(/<br\s*\/?>/gi, '\n');
    return t && df ? newCard(stripTags(t), stripTags(df)) : null;
  }).filter(Boolean);
}
function restoreBackup(text){
  let data; try { data = JSON.parse(text); } catch(e){ return toast('That file is not a Recall backup.'); }
  if (!data || !Array.isArray(data.decks)) return toast('That file is not a Recall backup.');
  data = { ...cleanState(data), hasProfile:!!data.profile };
  confirmBox('Restore this backup?', `It has ${data.decks.length} ${data.decks.length===1?'deck':'decks'}. Decks in the backup replace matching ones here; your other decks stay.`, 'Restore', () => {
    const byId = new Map(S.decks.map(d => [d.id, d]));
    data.decks.forEach(d => { if (d && d.id && Array.isArray(d.cards)) byId.set(d.id, d); });
    S.decks = [...byId.values()].sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
    if (data.hasProfile){ const mine = courses(); S.profile = { ...defaultProfile(), ...data.profile, deleted:[] }; mine.forEach(c => { if (!courseById(c.id)) courses().push(c); }); }
    S.decks.forEach(d => Store.saveDeck(d)); Store.saveProfile();
    toast('Backup restored'); go('home');
  });
}
async function importFile(f){
  if (!f) return;
  if (f.size > 60 * 1024 * 1024) return toast('That file is too big to import.');
  const text = await f.text();
  try {
    if (/\.json$/i.test(f.name)){
      const data = JSON.parse(text); if (data && Array.isArray(data.decks)) return restoreBackup(text);
      const arr = Array.isArray(data) ? data : [data]; let n = 0;
      arr.forEach(x => { if (x.cards){ const deck = { id:nid(), title:x.title||'Imported deck', desc:x.desc||'', course:'', examDate:'', termLang:x.termLang||'en-US', defLang:x.defLang||'en-US', createdAt:Date.now(), updatedAt:Date.now(), opts:{}, cards:x.cards.map(c => ({ ...newCard(c.term || '', c.def ?? c.definition ?? ''), termImg:c.termImg||'', defImg:c.defImg||'', starred:!!c.starred, hint:c.hint||'' })) }; const cd = cleanDeck(deck); if (!cd) return; S.decks.unshift(cd); Store.saveDeck(cd); n++; } });
      if (!n) throw 0; toast(`Imported ${n} ${n===1?'deck':'decks'}`); go('home');
    } else {
      const cards = parseText(text, /\.csv$/i.test(f.name) ? ',' : '\t');
      if (!cards.length) throw 0;
      go('edit', { prefill:cards, title:f.name.replace(/\.[^.]+$/,'') });
    }
  } catch(e){ toast('Could not read that file. Put one card per line: term, then a tab or comma, then the definition.'); }
}
function finalizeDraft(d){
  d.cards = d.cards.map(c => {
    const t = c.term.trim(), df = c.def.trim(), cz = cloze(t);
    if (cz && !df && !c.defImg) return { ...c, term:cz.term, def:cz.answer };
    return { ...c, term:t, def:df };
  }).filter(c => c.term || c.def || c.termImg || c.defImg);
}

/* =========================================================
   STUDY SHELL
   ========================================================= */
function studyTop(title, done, total, extra=''){
  const pct = total ? done/total*100 : 0, prev = T._pct ?? 0; T._pct = pct;
  return `<div class="study-top">
    <button class="icon-btn close" data-act="exit-study" aria-label="Leave ${esc(title)}" title="Leave (Esc)">${I.x}</button>
    <div class="mid"><div class="ttl"><span>${title}</span><span class="counter">${done} / ${total}</span></div><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${prev}%" data-w="${pct}"></span></div></div>
    <div class="row">${extra}</div></div>`;
}
function setProgress(done, total){ const pct = total ? done/total*100 : 0; T._pct = pct; const b = $('.progress span'); if (b) b.style.width = pct + '%'; const c = $('.counter'); if (c) c.textContent = done + ' / ' + total; }
function keyHandler(fn){ const h = e => { if (e.target.matches('input, textarea, select') && !['Enter','Escape'].includes(e.key)) return; if (e.metaKey || e.ctrlKey || e.altKey) return; if ($('#modal-root').innerHTML) return; fn(e); }; document.addEventListener('keydown', h); cleanup.push(() => document.removeEventListener('keydown', h)); }
function onceKeys(fn){ if (keysFor !== V.name){ keysFor = V.name; keyHandler(fn); } }
function answerKey(d, c){ const t = norm(plain(A(d, c))); return t || ('img:' + (AI_(d, c) || c.id)); }
function mcOptions(deck, card, all, n=4){
  const key = answerKey(deck, card), seen = new Set([key]), out = [card];
  for (const c of shuffle(all)){ if (out.length >= n) break; const k = answerKey(deck, c); if (c.id === card.id || seen.has(k)) continue; seen.add(k); out.push(c); }
  return shuffle(out);
}
function optInner(d, c){ return sideHTML(A(d, c), AI_(d, c)); }
function faceHTML(cls, label, text, img, tools, foot){
  const t = String(text || '').trim();
  return `<div class="face ${cls}"><div class="head"><span class="face-tag">${label}</span>${tools}</div>
    <div class="content">${img ? `<img class="cimg" src="${img}" alt="" data-act="zoom" data-src="${img}">` : ''}${t ? `<div class="txt ${isLong(t) || img ? 'long' : ''}">${fmt(t)}</div>` : ''}</div>${foot}</div>`;
}
function fcHTML(c, x, cls, showTap=true){
  const tools = `<div class="row" style="gap:2px"><button class="icon-btn flat" data-act="fc-speak" aria-label="Read aloud" title="Read aloud">${I.speak}</button><button class="icon-btn flat" data-act="fc-star" aria-pressed="${c.starred}" aria-label="Star" title="Star (S)">${c.starred?I.star:I.starO}</button></div>`;
  return `<div class="fc ${cls}" id="fc" role="button" tabindex="0" aria-label="Flashcard. Press space to flip.">
    <div class="fc-inner">
      ${faceHTML('f-front', x.fl, x.f, x.fImg, tools, showTap ? `<div class="tap">${I.turn} Tap to flip<span class="desk">&nbsp;or press space</span></div>` : '<div></div>')}
      ${faceHTML('f-back', x.bl, x.b, x.bImg, tools, c.hint ? `<div class="hook">💡 ${esc(c.hint)}</div>` : '<div></div>')}
    </div></div>`;
}
function tiltable(el){
  if (reduceMotion || !matchMedia('(hover:hover)').matches) return;
  el.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; const r = el.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; el.style.setProperty('--ry', (x * 7) + 'deg'); el.style.setProperty('--rx', (-y * 7) + 'deg'); el.style.setProperty('--mx', ((x + .5) * 100) + '%'); el.style.setProperty('--my', ((y + .5) * 100) + '%'); });
  el.addEventListener('pointerleave', () => { el.style.setProperty('--ry', '0deg'); el.style.setProperty('--rx', '0deg'); });
}
function notEnough(title, msg){
  app.innerHTML = `<div class="study">${studyTop(title, 0, 1)}<div class="panel summary"><h2>Not enough cards for ${title}</h2><p class="muted">${msg}</p><button class="btn primary" data-act="back-deck">Back to deck</button></div></div>`;
}

/* =========================================================
   FLASHCARDS
   ========================================================= */
VIEWS.flash = () => {
  const d = deckById(V.id);
  if (!T.init){ T = { init:true, active:true, cards:sessionPool(d), i:0, flipped:false, know:new Set(), learning:new Set(), swapped:false, auto:false, shuffled:false, busy:false }; }
  if (T.i >= T.cards.length) return flashSummary(d);
  app.innerHTML = `<div class="study">${studyTop('Flashcards', T.i, T.cards.length)}
    <div class="stage" id="stage"></div>
    <div class="sort"><button class="btn s-learn" data-act="fc-sort" data-v="0">${I.turn} Still learning <span class="kbd">1</span></button><button class="btn s-know" data-act="fc-sort" data-v="1">${I.check} Know it <span class="kbd">2</span></button></div>
    <div class="toolbar">
      <div class="row" style="gap:6px">
        <button class="btn" data-act="fc-shuffle" aria-pressed="${T.shuffled}">${I.shuffle}<span class="lbl">Shuffle</span></button>
        <button class="btn" data-act="fc-swap" aria-pressed="${T.swapped}">${I.swap}<span class="lbl">Flip sides</span></button>
        <button class="btn" data-act="fc-auto" aria-pressed="${T.auto}">${T.auto?I.pause:I.play}<span class="lbl">Auto-play</span></button>
      </div>
      <div class="row" style="gap:6px"><button class="icon-btn" data-act="fc-prev" aria-label="Previous card">${I.left}</button><button class="icon-btn" data-act="fc-next" aria-label="Skip to next card">${I.right}</button></div>
    </div>
    <p class="hint-line">Swipe right if you know it, left if you're still learning</p>
  </div>`;
  fcMount('enter');
  onceKeys(e => {
    if (V.name !== 'flash' || T.i >= T.cards.length) return;
    if (e.key === ' '){ e.preventDefault(); fcFlip(); }
    else if (e.key === 'ArrowRight') fcMove(1); else if (e.key === 'ArrowLeft') fcMove(-1);
    else if (e.key === '1') fcSort(0); else if (e.key === '2') fcSort(1);
    else if (e.key.toLowerCase() === 's') fcStar();
  });
};
function fcFaces(d, c){
  const termFront = T.swapped ? frontIs(d) !== 'term' : frontIs(d) === 'term';
  const src = d.isCombo ? d.deckOf.get(c.id) : null, L = src || d, from = src ? ' · ' + esc(src.title) : '';
  return termFront ? { f:c.term, b:c.def, fImg:c.termImg, bImg:c.defImg, fl:'Term' + from, bl:'Definition' + from, fLang:L.termLang, bLang:L.defLang }
                   : { f:c.def, b:c.term, fImg:c.defImg, bImg:c.termImg, fl:'Definition' + from, bl:'Term' + from, fLang:L.defLang, bLang:L.termLang };
}
function fromTag(d, c){ const src = d.isCombo ? d.deckOf.get(c.id) : null; return src ? ` · ${esc(src.title)}` : ''; }
function fcMount(cls){
  const d = deckById(V.id), c = T.cards[T.i], x = fcFaces(d, c);
  T.flipped = false;
  const stage = $('#stage'); stage.classList.toggle('last', T.i >= T.cards.length - 1);
  stage.innerHTML = fcHTML(c, x, cls);
  const el = $('#fc'); tiltable(el);
  el.addEventListener('click', e => { if (e.target.closest('button, [data-act="zoom"]') || T.dragged) return; fcFlip(); });
  let sx = null, dx = 0;
  el.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || e.target.closest('button')) return; sx = e.clientX; dx = 0; T.dragged = false; el.classList.add('dragging'); });
  el.addEventListener('pointermove', e => { if (sx === null) return; dx = e.clientX - sx; if (Math.abs(dx) > 8) T.dragged = true; el.style.setProperty('--sx', dx + 'px'); el.style.setProperty('--sr', (dx/25) + 'deg'); el.classList.toggle('lean-r', dx > 70); el.classList.toggle('lean-l', dx < -70); });
  const end = () => { if (sx === null) return; el.classList.remove('dragging','lean-r','lean-l'); if (Math.abs(dx) > 90) fcSort(dx > 0 ? 1 : 0); else { el.style.setProperty('--sx','0px'); el.style.setProperty('--sr','0deg'); } sx = null; setTimeout(() => T.dragged = false, 50); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
function fcFlip(){ const el = $('#fc'); if (!el || T.busy) return; T.flipped = !T.flipped; el.classList.toggle('flipped', T.flipped); }
function starBtns(c){ $$('[data-act="fc-star"]').forEach(b => { b.setAttribute('aria-pressed', c.starred); b.innerHTML = c.starred ? I.star : I.starO; b.classList.remove('popped'); void b.offsetWidth; b.classList.add('popped'); }); }
function fcStar(){ const d = deckById(V.id), c = T.cards[T.i]; c.starred = !c.starred; Store.saveDeck(d); starBtns(c); }
async function fcMove(n, fly){
  if (T.busy) return; const el = $('#fc'); const ni = Math.max(0, Math.min(T.cards.length, T.i + n)); if (ni === T.i) return;
  T.busy = true;
  if (el){ el.classList.remove('enter','enter-back'); el.classList.add(fly || (n > 0 ? 'fly-up' : 'fly-r')); await wait(fly ? 330 : 260); }
  T.i = ni; T.busy = false;
  if (T.i >= T.cards.length){ stopAuto(); animateView = true; return render(); }
  setProgress(T.i, T.cards.length); fcMount(n > 0 ? 'enter' : 'enter-back');
}
function fcSort(k){ if (T.busy) return; const c = T.cards[T.i]; (k ? T.know : T.learning).add(c.id); (k ? T.learning : T.know).delete(c.id); recordAnswer(c, !!k); Store.saveDeck(deckById(V.id)); fcMove(1, k ? 'fly-r' : 'fly-l'); }
function flashSummary(d){
  stopAuto();
  const k = T.know.size, l = T.learning.size, sorted = k + l;
  if (sorted && !l) confetti();
  app.innerHTML = `<div class="study">${studyTop('Flashcards', T.cards.length, T.cards.length)}
  <div class="panel summary">
    <h2>${!sorted ? 'You reached the end' : l ? 'Nice round! Let\'s focus on the tricky ones.' : 'You know every card here!'}</h2>
    ${sorted ? `<div class="duo"><div style="background:var(--good-soft);color:var(--good)"><b data-count="${k}">0</b>know it</div><div style="background:var(--warn-soft);color:var(--warn)"><b data-count="${l}">0</b>still learning</div></div>` : ''}
    <div class="row center">
      ${l ? `<button class="btn primary big" data-act="fc-again-learning">Study the ${l} I'm still learning</button>` : ''}
      <button class="btn ${l ? '' : 'primary big'}" data-act="fc-restart">Go through all again</button>
      <button class="btn ghost" data-act="mode" data-v="learn">Try Learn next</button>
    </div>
  </div></div>`;
}
function stopAuto(){ clearInterval(T.autoTimer); T.autoTimer = null; }
function toggleAuto(btn){
  T.auto = !T.auto; btn.setAttribute('aria-pressed', T.auto); btn.innerHTML = (T.auto ? I.pause : I.play) + '<span class="lbl">Auto-play</span>';
  if (T.auto){ T.autoTimer = setInterval(() => { if (V.name !== 'flash' || !T.auto) return stopAuto(); if (!T.flipped) fcFlip(); else fcMove(1); }, 2800); cleanup.push(stopAuto); }
  else stopAuto();
}

/* =========================================================
   LEARN
   ========================================================= */
function promptBlock(d, c){
  const q = String(Q(d, c) || '').trim(), img = QI(d, c);
  return `${img ? `<img class="cimg q" src="${img}" alt="" data-act="zoom" data-src="${img}">` : ''}${q ? `<div class="prompt ${isLong(q) ? 'long' : ''}">${fmt(q)}</div>` : ''}`;
}
VIEWS.learn = () => {
  const d = deckById(V.id);
  if (!T.init){ T = { init:true, active:true, all:sessionPool(d) }; learnNewRound(); }
  const total = T.all.length, mastered = T.all.filter(c => c.lv >= 2).length;
  if (!T.round) return learnDone(d);
  if (T.qi >= T.round.length) return learnRoundSummary(d);
  const c = T.round[T.qi], mode = (c.lv === 0 || !hasAText(d, c)) ? 'mc' : 'write';
  T.cur = { c, mode, answered:false };
  if (mode === 'mc') T.cur.opts = mcOptions(d, c, T.all);
  const stage = mode === 'mc' ? 'Pick the right answer' : 'Now type it from memory';
  app.innerHTML = `<div class="study">${studyTop('Learn', mastered, total, `<span class="pill good">${mastered} mastered</span>`)}
  <div class="qcard enter">
    <div class="qhead"><span class="face-tag">${qName(d)}${fromTag(d, c)}</span><span class="row" style="gap:2px"><button class="icon-btn flat" data-act="q-speak" aria-label="Read aloud">${I.speak}</button><button class="icon-btn flat" data-act="q-star" aria-pressed="${c.starred}" aria-label="Star this card" title="Star (S)">${c.starred ? I.star : I.starO}</button></span></div>
    ${promptBlock(d, c)}
    <p class="small muted" style="font-weight:700;margin-bottom:-8px">${stage}</p>
    ${mode === 'mc' ? `<div class="opts">${T.cur.opts.map((o,i) => `<button class="opt" data-act="l-pick" data-i="${i}" style="--i:${i}"><span class="k">${i+1}</span><span class="oc">${optInner(d, o)}</span></button>`).join('')}</div>`
    : `<input class="input answer-in" id="l-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the ${aName(d).toLowerCase()}" aria-label="Your answer">
       <div class="row between"><div class="row" style="gap:4px"><button class="btn ghost" data-act="l-hint">Show a hint</button><button class="btn ghost" data-act="l-idk">I don't know</button></div><button class="btn primary" data-act="l-check">Check</button></div>
       <p class="small muted hidden" id="l-hinttxt"></p>`}
    <div id="fb" class="stack"></div>
  </div></div>`;
  $('#l-in')?.focus();
  onceKeys(e => {
    if (V.name !== 'learn' || !T.cur) return;
    if (T.cur.answered && e.key === 'Enter'){ e.preventDefault(); return learnNext(); }
    if (!T.cur.answered && T.cur.mode === 'mc' && /^[1-4]$/.test(e.key)) $(`[data-act="l-pick"][data-i="${+e.key-1}"]`)?.click();
    if (!T.cur.answered && T.cur.mode === 'write' && e.key === 'Enter'){ e.preventDefault(); learnCheck(); }
    if (e.key.toLowerCase() === 's' && !e.target.matches('input')) $('[data-act="q-star"]')?.click();
  });
};
function learnNewRound(){
  const rem = T.all.filter(c => c.lv < 2);
  if (!rem.length){ T.round = null; return; }
  T.round = shuffle(rem).sort((a,b) => a.lv - b.lv).slice(0, 7); T.qi = 0; T.roundRes = []; T.requeued = new Set();
}
function learnAnswer(correct, userAns){
  const c = T.cur.c; T.cur.answered = true; T.cur.user = userAns;
  recordAnswer(c, correct);
  if (correct) c.lv = Math.min(2, c.lv + 1);
  else if (!T.requeued.has(c.id)){ T.requeued.add(c.id); T.round.push(c); }
  T.roundRes.push({ c, correct }); Store.saveDeck(deckById(V.id));
}
function feedbackHTML(kind, d, c, userAns, override){
  const head = kind === 'right' ? `${I.check} Correct!` : kind === 'close' ? `${I.check} Close enough — check the spelling` : `${I.xmark} Not quite`;
  return `<div class="fb ${kind==='right'?'ok':kind==='close'?'close':'no'}">
    <b class="h">${head}</b>
    ${kind !== 'right' ? `<div>Answer: <span class="ans">${optInner(d, c)}</span></div>` : ''}
    ${kind === 'wrong' && userAns ? `<div class="small">You wrote: ${esc(userAns)}</div>` : ''}
    ${c.hint ? `<div class="small">💡 ${esc(c.hint)}</div>` : ''}
  </div>
  <div class="row between">
    <div class="row" style="gap:4px">${kind === 'wrong' && override ? `<button class="btn ghost" data-act="${override}">Count it — I was right</button>` : ''}</div>
    <button class="btn primary" data-act="next-q" id="next-q">Continue <span class="kbd">Enter</span></button>
  </div>`;
}
function learnFeedback(kind, userAns){
  const d = deckById(V.id), c = T.cur.c;
  $('#fb').innerHTML = feedbackHTML(kind, d, c, userAns, T.cur.mode === 'write' ? 'l-override' : null);
  const inp = $('#l-in'); if (inp){ inp.disabled = true; if (kind === 'wrong') inp.classList.add('shake'); }
  $$('[data-act="l-check"],[data-act="l-idk"],[data-act="l-hint"]').forEach(b => b.disabled = true);
  $('#next-q').focus({ preventScroll:true }); $('#fb').scrollIntoView({ block:'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}
function learnCheck(){
  const inp = $('#l-in'), v = inp.value; if (!v.trim()){ inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); return; }
  const g = grade(v, A(deckById(V.id), T.cur.c)); learnAnswer(g !== 'wrong', v); learnFeedback(g, v);
}
async function fadeQ(){ const q = $('.qcard'); if (q && !reduceMotion){ q.style.transition = 'opacity .18s, transform .18s'; q.style.opacity = 0; q.style.transform = 'translateY(-12px)'; await wait(170); } }
async function learnNext(){ await fadeQ(); T.qi++; sub(); }
function learnRoundSummary(d){
  const right = T.roundRes.filter(r => r.correct).length, total = T.all.length, mastered = T.all.filter(c => c.lv >= 2).length;
  const seen = [...new Map(T.roundRes.map(r => [r.c.id, r.c])).values()];
  app.innerHTML = `<div class="study">${studyTop('Learn', mastered, total)}
  <div class="panel summary">
    <h2>Round complete</h2>
    <div class="duo"><div style="background:var(--good-soft);color:var(--good)"><b data-count="${right}">0</b>correct answers</div><div style="background:var(--accent-soft);color:var(--accent)"><b data-count="${mastered}">0</b>of ${total} mastered</div></div>
    <div class="cardlist">${seen.map(c => `<div class="crow" style="grid-template-columns:1fr 1.5fr auto;align-items:center"><div class="t">${sideHTML(Q(d,c), QI(d,c))}</div><div class="d">${sideHTML(A(d,c), AI_(d,c))}</div><span class="pill ${c.lv>=2?'good':c.lv===1?'warn':''}">${['Not yet','Getting there','Mastered'][c.lv]}</span></div>`).join('')}</div>
    <button class="btn primary big" data-act="l-continue">Keep going</button>
  </div></div>`;
}
function learnDone(d){
  confetti();
  app.innerHTML = `<div class="study">${studyTop('Learn', T.all.length, T.all.length)}
  <div class="panel summary"><div class="bigscore" data-count="100" data-suffix="%">0%</div><h2>You've learned this whole set</h2><p class="muted">Smart Review will bring these cards back right before you'd forget them.</p>
  <div class="row center"><button class="btn primary big" data-act="mode" data-v="test">Take a practice test</button><button class="btn" data-act="l-reset">Start Learn over</button></div></div></div>`;
}

/* =========================================================
   SMART REVIEW
   ========================================================= */
VIEWS.review = () => {
  if (!T.init){
    const decks = V.id ? [deckById(V.id)] : S.decks, now = Date.now(); let due = [], fresh = [];
    decks.forEach(d => { (V.id ? pool(d) : d.cards.filter(complete)).forEach(c => { if (isDue(c, now)) due.push({d,c}); else if (c.srs.state === 'new') fresh.push({d,c}); }); });
    due.sort((a,b) => a.c.srs.due - b.c.srs.due); fresh = fresh.slice(0, newLeftToday());
    T = { init:true, active:true, q:[...shuffle(due), ...fresh], done:0, shown:false, tally:[0,0,0,0], seen:new Set() };
    T.total = T.q.length;
  }
  if (!T.q.length) return reviewDone();
  app.innerHTML = `<div class="study">${studyTop('Smart Review', T.done, T.total)}<div class="stage" id="stage"></div><div id="r-actions"></div>
    <p class="hint-line">Try to remember the answer before you reveal it. <span class="kbd">Space</span> reveal · <span class="kbd">1</span>–<span class="kbd">4</span> rate</p></div>`;
  reviewMount('enter');
  onceKeys(e => {
    if (V.name !== 'review' || !T.q.length || T.busy) return;
    if (e.key === ' '){ e.preventDefault(); if (!T.shown) reviewReveal(); }
    else if (T.shown && /^[1-4]$/.test(e.key)) reviewGrade(+e.key - 1);
  });
};
function reviewMount(cls){
  const { d, c } = T.q[0]; T.shown = false;
  $('#stage').classList.toggle('last', T.q.length <= 1);
  const x = { f:Q(d,c), b:A(d,c), fImg:QI(d,c), bImg:AI_(d,c), fl:`${esc(qName(d))}${!V.id ? ' · ' + esc(d.title) : fromTag(d, c)}${c.srs.state === 'new' ? ' · new' : ''}`, bl:aName(d) };
  $('#stage').innerHTML = fcHTML(c, x, cls, false);
  const el = $('#fc'); tiltable(el); el.addEventListener('click', e => { if (!e.target.closest('button, [data-act="zoom"]') && !T.shown) reviewReveal(); });
  $('#r-actions').innerHTML = `<button class="btn primary big block" style="margin-top:34px" data-act="r-show">Show answer <span class="kbd">Space</span></button>`;
}
function reviewReveal(){
  const { c } = T.q[0]; T.shown = true; $('#fc').classList.add('flipped');
  const p = [0,1,2,3].map(g => fmtIvl(schedule(c.srs, g).due - Date.now()));
  $('#r-actions').innerHTML = `<div class="rate">
    <button class="btn r0" data-act="r-grade" data-g="0">Forgot<small>again in ${p[0]}</small></button>
    <button class="btn r1" data-act="r-grade" data-g="1">Hard<small>${p[1]}</small></button>
    <button class="btn r2" data-act="r-grade" data-g="2">Got it<small>${p[2]}</small></button>
    <button class="btn r3" data-act="r-grade" data-g="3">Easy<small>${p[3]}</small></button></div>`;
}
async function reviewGrade(g){
  if (T.busy) return; T.busy = true;
  const { d, c } = T.q.shift();
  if (c.srs.state === 'new' && !T.seen.has(c.id)){ const p = S.profile; if (p.newToday.day !== dayKey()) p.newToday = { day:dayKey(), n:0 }; p.newToday.n++; }
  T.seen.add(c.id); c.srs = schedule(c.srs, g); recordAnswer(c, g >= 1); T.tally[g]++;
  if (g === 0){ c.lv = 0; T.q.splice(Math.min(3, T.q.length), 0, { d, c }); } else T.done++;
  if (g >= 2) c.lv = Math.max(c.lv, 1);
  Store.saveDeck(d);
  $('#fc')?.classList.add(g === 0 ? 'fly-l' : 'fly-r'); await wait(330); T.busy = false;
  if (!T.q.length){ animateView = true; return render(); }
  setProgress(T.done, T.total); reviewMount('enter');
}
function reviewDone(){
  const next = S.decks.flatMap(d => d.cards).filter(c => c.srs.state !== 'new').map(c => c.srs.due).sort((a,b)=>a-b)[0];
  if (T.total) confetti();
  app.innerHTML = `<div class="study">${studyTop('Smart Review', T.total, T.total)}
  <div class="panel summary">
    <h2>${T.total ? 'Review complete!' : 'Nothing to review right now'}</h2>
    ${T.total ? `<div class="duo">${[['Forgot','bad'],['Hard','warn'],['Got it','good'],['Easy','due']].map(([n,c],i) => `<div class="pill ${c}" style="display:block;border-radius:18px;padding:14px 20px;min-width:0"><b data-count="${T.tally[i]}" style="font-size:32px">0</b>${n}</div>`).join('')}</div>` : ''}
    <p class="muted">${next ? `Your next card comes up in ${fmtIvl(Math.max(MIN, next - Date.now()))}.` : 'Study a few cards and they will join your review schedule.'}${newLeftToday() === 0 ? ' You have reached today\'s limit for new cards.' : ''}</p>
    <div class="row center"><button class="btn primary big" data-act="${V.id ? 'back-deck' : 'home'}">Done</button>${V.id ? '<button class="btn ghost" data-act="mode" data-v="match">Play Match</button>' : ''}</div>
  </div></div>`;
}

/* =========================================================
   WRITE
   ========================================================= */
VIEWS.write = () => {
  const d = deckById(V.id);
  if (!T.init){ T = { init:true, active:true, cards:shuffle(pool(d).filter(c => hasAText(d, c))), i:0, res:[] }; }
  if (!T.cards.length) return notEnough('Write', `Write mode needs cards with a typed ${aName(d).toLowerCase()} to check your answer against. Try switching which side the card front shows.`);
  if (T.i >= T.cards.length) return writeSummary(d);
  const c = T.cards[T.i]; T.answered = false; T.cur = { c };
  app.innerHTML = `<div class="study">${studyTop('Write', T.i, T.cards.length, `<span class="pill good">${T.res.filter(r=>r.ok).length} right</span>`)}
  <div class="qcard enter">
    <div class="qhead"><span class="face-tag">${qName(d)}${fromTag(d, c)}</span><span class="row" style="gap:2px"><button class="icon-btn flat" data-act="q-speak" aria-label="Read aloud">${I.speak}</button><button class="icon-btn flat" data-act="q-star" aria-pressed="${c.starred}" aria-label="Star this card" title="Star (S)">${c.starred ? I.star : I.starO}</button></span></div>
    ${promptBlock(d, c)}
    <input class="input answer-in" id="w-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the ${aName(d).toLowerCase()}" aria-label="Your answer">
    <div class="row between"><button class="btn ghost" data-act="w-skip">Skip</button><button class="btn primary" data-act="w-check">Check <span class="kbd">Enter</span></button></div>
    <div id="fb" class="stack"></div>
  </div></div>`;
  $('#w-in').focus();
  onceKeys(e => { if (V.name !== 'write' || e.key !== 'Enter' || !T.cards.length) return; e.preventDefault(); if (T.answered) writeNext(); else writeCheck(false); });
};
function writeCheck(skip){
  const d = deckById(V.id), c = T.cards[T.i], inp = $('#w-in'), v = skip ? '' : inp.value;
  if (!skip && !v.trim()){ inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); return; }
  const g = skip ? 'wrong' : grade(v, A(d, c));
  T.answered = true; recordAnswer(c, g !== 'wrong'); Store.saveDeck(d);
  T.res.push({ c, ok:g !== 'wrong', user:v }); T.cur = { c, user:v };
  inp.disabled = true; if (g === 'wrong') inp.classList.add('shake');
  $$('[data-act="w-check"],[data-act="w-skip"]').forEach(b => b.disabled = true);
  $('#fb').innerHTML = feedbackHTML(g, d, c, v, skip ? null : 'w-override');
  $('#next-q').focus({ preventScroll:true });
}
async function writeNext(){ await fadeQ(); T.i++; sub(); }
function writeSummary(d){
  const ok = T.res.filter(r => r.ok).length, miss = T.res.filter(r => !r.ok), pct = Math.round(ok / T.res.length * 100);
  if (pct >= 90) confetti();
  app.innerHTML = `<div class="study">${studyTop('Write', T.cards.length, T.cards.length)}
  <div class="panel summary"><div class="bigscore" data-count="${pct}" data-suffix="%">0%</div><p class="muted">${ok} of ${T.res.length} correct</p>
  ${miss.length ? `<div class="cardlist">${miss.map(r => `<div class="crow" style="grid-template-columns:1fr 1fr"><div class="t">${sideHTML(Q(d,r.c), QI(d,r.c))}</div><div><div class="d" style="color:var(--ink)">${fmt(A(d,r.c))}</div>${r.user ? `<div class="small" style="color:var(--bad)">You wrote: ${esc(r.user)}</div>` : ''}</div></div>`).join('')}</div>` : ''}
  <div class="row center">${miss.length ? `<button class="btn primary big" data-act="w-missed">Retry the ${miss.length} I missed</button>` : ''}<button class="btn" data-act="mode" data-v="write">Start over</button></div></div></div>`;
}

/* =========================================================
   MATCH
   ========================================================= */
VIEWS.match = () => {
  const d = deckById(V.id), best = S.profile.best[d.id];
  if (!T.init) T = { init:true, active:true, phase:'ready' };
  if (T.phase === 'ready'){
    app.innerHTML = `<div class="study">${studyTop('Match', 0, 1)}<div class="panel summary">
      <span class="ic g-match" style="width:64px;height:64px;border-radius:20px;display:grid;place-items:center;color:#fff">${I.match.replace('<svg','<svg style="width:32px;height:32px"')}</span>
      <h2>Match each term with its definition</h2>
      <p class="muted">Tap one tile, then tap its partner. Wrong pairs add 1 second.</p>
      ${best ? `<span class="pill due">Your best: ${(best/1000).toFixed(1)}s</span>` : ''}
      <button class="btn primary big" data-act="m-start">Start game</button></div></div>`;
    return;
  }
  if (T.phase === 'done'){
    const t = T.elapsed, isBest = !best || t < best;
    if (isBest){ S.profile.best[d.id] = t; Store.saveProfile(); }
    confetti();
    app.innerHTML = `<div class="study">${studyTop('Match', 1, 1)}<div class="panel summary">
      <div class="bigscore" data-count="${t/1000}" data-dec="1" data-suffix="s">0s</div>
      <h2>${isBest ? (best ? 'New personal best!' : 'Nice! That\'s your first record.') : 'Nice round!'}</h2>
      <p class="muted">${isBest && best ? `You beat ${(best/1000).toFixed(1)}s.` : !isBest ? `Your best is ${(best/1000).toFixed(1)}s.` : ''} ${T.misses ? T.misses + ' wrong ' + (T.misses===1?'pair':'pairs') + '.' : 'No mistakes!'}</p>
      <div class="row center"><button class="btn primary big" data-act="m-start">Play again</button><button class="btn ghost" data-act="back-deck">Back to deck</button></div></div></div>`;
    return;
  }
  app.innerHTML = `<div class="study" style="max-width:920px">${studyTop('Match', 0, T.pairs, `<span class="timer" id="m-t">0.0s</span>`)}
    <div class="mgrid">${T.tiles.map((x,i) => `<button class="tile" data-act="m-tile" data-i="${i}" style="--i:${i}"><span>${String(x.text).trim() ? fmt(x.text) : imgTag(x.img, 'timg')}</span></button>`).join('')}</div></div>`;
  const tick = () => { if (V.name !== 'match' || T.phase !== 'play') return; const el = $('#m-t'); if (el) el.textContent = ((Date.now() - T.t0 + T.penalty) / 1000).toFixed(1) + 's'; T.raf = requestAnimationFrame(tick); };
  cancelAnimationFrame(T.raf); tick(); cleanup.push(() => cancelAnimationFrame(T.raf));
};
function matchStart(){
  const cs = shuffle(pool(deckById(V.id))).slice(0, 6);
  T = { init:true, active:true, phase:'play', tiles:shuffle(cs.flatMap(c => [{ id:c.id, text:c.term, img:c.termImg, card:c }, { id:c.id, text:c.def, img:c.defImg, card:c }])), pairs:cs.length, found:0, sel:null, t0:Date.now(), penalty:0, misses:0, missed:new Set() };
  animateView = true; render();
}
function matchTap(i){
  const x = T.tiles[i], els = $$('.tile'); if (x.gone) return;
  if (T.sel === null){ T.sel = i; els[i].classList.add('sel'); return; }
  if (T.sel === i){ T.sel = null; els[i].classList.remove('sel'); return; }
  const s = T.sel, a = T.tiles[s]; T.sel = null;
  if (a.id === x.id){
    a.gone = x.gone = true; [s, i].forEach(k => { els[k].classList.remove('sel'); els[k].style.animationDelay = '0s'; els[k].classList.add('hit'); });
    recordAnswer(x.card, !T.missed.has(x.id)); T.found++; setProgress(T.found, T.pairs);
    if (T.found === T.pairs){ T.elapsed = Date.now() - T.t0 + T.penalty; T.phase = 'done'; Store.saveDeck(deckById(V.id)); setTimeout(() => { animateView = true; render(); }, 450); }
  } else {
    T.penalty += 1000; T.misses++; T.missed.add(a.id); T.missed.add(x.id);
    [s, i].forEach(k => { els[k].classList.remove('sel','miss'); els[k].style.animationDelay = '0s'; void els[k].offsetWidth; els[k].classList.add('miss'); setTimeout(() => els[k]?.classList.remove('miss'), 450); });
    const t = $('#m-t'); if (t){ t.style.color = 'var(--bad)'; setTimeout(() => t.style.color = '', 400); }
  }
}

/* =========================================================
   PRACTICE TEST (mock exam)
   ========================================================= */
VIEWS.test = () => {
  const d = deckById(V.id), pl = pool(d);
  if (!T.init) T = { init:true, active:true, phase:'setup', n:Math.min(20, pl.length), types:{ mc:true, tf:true, written:true }, timed:0 };
  if (T.phase === 'setup'){
    app.innerHTML = `<div class="study">${studyTop('Practice test', 0, 1)}<div class="panel stack" style="gap:20px">
      <div><h2>Set up your mock exam</h2><p class="muted small" style="margin-top:4px">Answer everything, then get a score and a list of what to review.</p></div>
      <div class="field"><label for="t-n">Number of questions: <b id="t-nv" style="color:var(--ink)">${T.n}</b></label><input type="range" id="t-n" min="1" max="${pl.length}" value="${T.n}"></div>
      <div class="stack" style="gap:8px"><span class="small muted" style="font-weight:700">Question types</span>
        <label class="check"><input type="checkbox" data-t="mc" ${T.types.mc?'checked':''}> Multiple choice</label>
        <label class="check"><input type="checkbox" data-t="tf" ${T.types.tf?'checked':''}> True or false</label>
        <label class="check"><input type="checkbox" data-t="written" ${T.types.written?'checked':''}> Type the answer</label>
      </div>
      <div class="stack" style="gap:8px"><span class="small muted" style="font-weight:700">Time limit (like a real exam)</span>${seg('t-time', [['0','None'],['10','10 min'],['20','20 min'],['30','30 min'],['60','60 min']], String(T.timed))}</div>
      <button class="btn primary big" data-act="t-start">Start test</button></div></div>`;
    requestAnimationFrame(placeThumbs);
    $('#t-n').oninput = e => { T.n = +e.target.value; $('#t-nv').textContent = T.n; };
    $$('[data-t]').forEach(cb => cb.onchange = () => T.types[cb.dataset.t] = cb.checked);
    return;
  }
  const graded = T.phase === 'graded', score = graded ? T.qs.filter(q => q.ok).length : 0, pct = graded ? Math.round(score / T.qs.length * 100) : 0;
  app.innerHTML = `<div class="study">${studyTop('Practice test', graded ? T.qs.length : T.qs.filter(answered).length, T.qs.length, !graded && T.deadline ? `<span class="timer" id="t-clock" style="font-size:20px"></span>` : '')}
  ${graded ? `<div class="panel summary" style="margin-bottom:18px"><div class="bigscore" data-count="${pct}" data-suffix="%">0%</div><p class="muted">${score} of ${T.qs.length} correct${T.timeUsed ? ` · finished in ${mmss(T.timeUsed)}` : ''}</p>
    <div class="row center">${score < T.qs.length ? `<button class="btn primary" data-act="t-missed">Retest the ${T.qs.length-score} I missed</button>` : ''}<button class="btn" data-act="t-new">New test</button></div></div>` : ''}
  <div class="stack stagger">${T.qs.map((q,i) => testQ(d, q, i, graded)).join('')}</div>
  ${graded ? '' : `<div class="savebar"><span class="muted small" style="margin-right:auto" id="t-left"></span><button class="btn primary big" data-act="t-submit">Submit test</button></div>`}</div>`;
  $$('.tq input[type=text]').forEach(inp => inp.oninput = () => { T.qs[+inp.dataset.q].ans = inp.value; testLeft(); });
  testLeft();
  if (!graded && T.deadline){
    const tick = () => { const el = $('#t-clock'); if (!el || T.phase !== 'take') return; const left = T.deadline - Date.now(); if (left <= 0){ toast("Time's up! Your test has been submitted."); return testSubmit(); } el.textContent = mmss(left); el.style.color = left < 60000 ? 'var(--bad)' : ''; };
    clearInterval(T.clock); T.clock = setInterval(tick, 500); tick(); cleanup.push(() => clearInterval(T.clock));
  }
};
const answered = q => q.ans !== undefined && q.ans !== '';
function testQ(d, q, i, graded){
  const c = q.c, sel = on => !graded && on ? 'sel' : '';
  const head = `<div class="row between"><span class="num">${i+1} of ${T.qs.length} · ${({mc:'Multiple choice',tf:'True or false',written:'Type the answer'})[q.type]}</span>${graded ? `<span class="pill ${q.ok?'good':'bad'}">${q.ok?'Correct':'Incorrect'}</span>` : ''}</div>`;
  let body = promptBlock(d, c);
  if (q.type === 'mc'){
    body += `<div class="opts">${q.opts.map((o,k) => {
      const cls = graded ? (o.id === c.id ? 'right' : (q.ans === k ? 'wrong' : 'dim')) : sel(q.ans === k);
      return `<button class="opt ${cls}" data-act="t-pick" data-q="${i}" data-k="${k}" ${graded?'disabled':''} style="animation:none"><span class="k">${'ABCD'[k]}</span><span class="oc">${optInner(d, o)}</span></button>`; }).join('')}</div>`;
  } else if (q.type === 'tf'){
    body += `<div class="fb" style="background:var(--surface-2);color:var(--ink);animation:none"><span class="small muted" style="font-weight:700">Does it match this?</span><span style="font-weight:700" class="oc">${optInner(d, q.shown)}</span></div>
      <div class="tf">${[true,false].map(v => { const cls = graded ? (v === q.truth ? 'right' : (q.ans === v ? 'wrong' : 'dim')) : sel(q.ans === v); return `<button class="opt ${cls}" data-act="t-tf" data-q="${i}" data-v="${v}" ${graded?'disabled':''} style="justify-content:center;animation:none">${v ? 'True' : 'False'}</button>`; }).join('')}</div>`;
  } else {
    body += `<input type="text" class="input" data-q="${i}" value="${esc(q.ans || '')}" ${graded?'disabled':''} placeholder="Type the ${aName(d).toLowerCase()}" autocomplete="off" aria-label="Answer to question ${i+1}">`;
  }
  const fix = graded && !q.ok ? `<div class="fb no" style="animation:none"><div>Correct answer: <span class="ans">${optInner(d, c)}</span></div></div>` : '';
  return `<div class="tq ${graded ? (q.ok ? 'ok' : 'no') : ''}" style="--i:${Math.min(i, 8)}">${head}${body}${fix}</div>`;
}
function testLeft(){ const n = T.qs.filter(q => !answered(q)).length; const el = $('#t-left'); if (el) el.textContent = n ? `${n} left to answer` : 'All answered — ready to submit'; setProgress(T.qs.length - n, T.qs.length); }
function testBuild(cards){
  const d = deckById(V.id), pl = pool(d);
  const types = Object.keys(T.types).filter(k => T.types[k]); if (!types.length) types.push('mc');
  T.qs = shuffle(cards.map((c, i) => {
    let type = types[i % types.length];
    if (type === 'written' && !hasAText(d, c)) type = 'mc';
    if (type !== 'written' && pl.length < 2) type = hasAText(d, c) ? 'written' : 'mc';
    const q = { c, type };
    if (type === 'mc') q.opts = mcOptions(d, c, pl);
    if (type === 'tf'){ const other = shuffle(pl.filter(x => x.id !== c.id && answerKey(d, x) !== answerKey(d, c)))[0]; q.truth = !other || Math.random() < 0.5; q.shown = q.truth ? c : other; }
    return q;
  }));
  T.phase = 'take'; T._pct = 0; T.started = Date.now(); T.deadline = T.timed ? Date.now() + T.timed * MIN : 0;
}
function testSubmit(){
  if (T.phase !== 'take') return;
  clearInterval(T.clock);
  const d = deckById(V.id);
  T.qs.forEach(q => {
    if (q.type === 'mc') q.ok = q.ans !== undefined && q.opts[q.ans].id === q.c.id;
    else if (q.type === 'tf') q.ok = q.ans === q.truth;
    else q.ok = grade(q.ans || '', A(d, q.c)) !== 'wrong';
    recordAnswer(q.c, q.ok);
  });
  T.timeUsed = Date.now() - T.started;
  Store.saveDeck(d); T.phase = 'graded'; animateView = true; render(); window.scrollTo({ top:0 });
  if (T.qs.filter(q => q.ok).length / T.qs.length >= 0.9) confetti();
}

/* =========================================================
   BLITZ
   ========================================================= */
const bQ = c => plain(c.term).length > plain(c.def).length ? c.term : c.def;
const bA = c => plain(c.term).length > plain(c.def).length ? c.def : c.term;
function blitzPool(d){ return pool(d).filter(c => plain(c.term).trim() && plain(c.def).trim()); }
VIEWS.blitz = () => {
  const d = deckById(V.id);
  if (!T.init) T = { init:true, active:true, phase:'ready' };
  if (!blitzPool(d).length) return notEnough('Blitz', 'Blitz needs cards with text on both sides.');
  const hi = S.profile.best['blitz:' + d.id] || 0;
  if (T.phase === 'ready' || T.phase === 'over'){
    const over = T.phase === 'over', isHi = over && T.score > hi;
    if (isHi){ S.profile.best['blitz:' + d.id] = T.score; Store.saveProfile(); confetti(); }
    app.innerHTML = `<div class="study">${studyTop('Blitz', 0, 1)}<div class="panel summary">
      ${over ? `<div class="bigscore" data-count="${T.score}">0</div><h2>${isHi ? 'New high score!' : 'Game over'}</h2>`
        : `<span class="ic g-blitz" style="width:64px;height:64px;border-radius:20px;display:grid;place-items:center;color:#fff">${I.blitz.replace('<svg','<svg style="width:32px;height:32px"')}</span><h2>Type the answer before it lands</h2><p class="muted">Clues fall from the top. Type the matching answer and press Enter. It speeds up as you go — three misses and the game ends.</p>`}
      ${over && T.missedCards.length ? `<div class="cardlist"><p class="small muted" style="font-weight:700">Worth another look</p>${[...new Set(T.missedCards)].map(c => `<div class="crow" style="grid-template-columns:1fr 1fr"><div class="d">${fmt(bQ(c))}</div><div class="t">${fmt(bA(c))}</div></div>`).join('')}</div>` : ''}
      ${hi || isHi ? `<span class="pill due">High score: ${Math.max(hi, over ? T.score : 0)}</span>` : ''}
      <button class="btn primary big" data-act="b-start">${over ? 'Play again' : 'Start'}</button></div></div>`;
    return;
  }
  app.innerHTML = `<div class="study">
    <div class="study-top"><button class="icon-btn close" data-act="exit-study" aria-label="Leave Blitz">${I.x}</button><div></div>
      <div class="hud" id="hud"></div></div>
    <div class="arena" id="arena"></div>
    <input class="input answer-in" id="b-in" style="margin-top:14px" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type an answer and press Enter" aria-label="Your answer">
    <p class="small muted" id="b-msg" style="margin-top:10px;min-height:24px;text-align:center"></p></div>`;
  blitzHud();
  const inp = $('#b-in'); inp.focus();
  inp.addEventListener('keydown', e => { if (e.key !== 'Enter') return; e.preventDefault(); blitzSubmit(inp.value); inp.value = ''; });
};
function blitzStart(){
  T = { init:true, active:true, phase:'play', score:0, lives:3, level:1, streak:0, fallers:[], deck:shuffle(blitzPool(deckById(V.id))), di:0, missedCards:[], lastSpawn:0, last:performance.now() };
  animateView = true; render(); blitzSpawn();
  const loop = now => {
    if (V.name !== 'blitz' || T.phase !== 'play') return;
    const dt = Math.min(50, now - T.last); T.last = now;
    const arena = $('#arena'); if (!arena) return;
    const H = arena.clientHeight, speed = (8 + T.level * 3) / 1000;
    T.fallers.forEach(f => { f.y += speed * dt; if (f.el) f.el.style.top = (f.y / 100 * (H - 50)) + 'px'; });
    T.fallers.filter(f => f.y >= 100).forEach(blitzMiss);
    const maxOn = T.level >= 4 ? 3 : T.level >= 2 ? 2 : 1;
    if ((T.fallers.length < maxOn && now - T.lastSpawn > Math.max(1200, 3400 - T.level*300)) || !T.fallers.length) blitzSpawn();
    T.raf = requestAnimationFrame(loop);
  };
  T.raf = requestAnimationFrame(loop); cleanup.push(() => cancelAnimationFrame(T.raf));
}
function blitzSpawn(){
  if (T.di >= T.deck.length){ T.deck = shuffle(blitzPool(deckById(V.id))); T.di = 0; }
  const c = T.deck[T.di++]; if (!c || T.fallers.find(f => f.c.id === c.id)) return;
  const f = { c, y:0, x:4 + Math.random() * 48 }; T.fallers.push(f); T.lastSpawn = performance.now();
  const arena = $('#arena'); if (!arena) return;
  const el = document.createElement('div'); el.className = 'faller'; el.style.left = f.x + '%'; el.innerHTML = fmt(bQ(c)); arena.appendChild(el); f.el = el;
}
function blitzSubmit(v){
  if (!v.trim()) return;
  const hit = T.fallers.slice().sort((a,b) => b.y - a.y).find(f => grade(v, bA(f.c)) !== 'wrong');
  if (hit){
    T.fallers = T.fallers.filter(f => f !== hit); hit.el.classList.add('hit'); setTimeout(() => hit.el.remove(), 300);
    T.score += 10 * T.level; T.streak++; recordAnswer(hit.c, true);
    if (T.streak % 5 === 0){ T.level++; $('#b-msg').textContent = `Level ${T.level} — faster now!`; } else $('#b-msg').textContent = '';
    blitzHud();
  } else { const inp = $('#b-in'); inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); $('#b-msg').textContent = "That doesn't match anything on screen."; }
}
function blitzMiss(f){
  const d = deckById(V.id);
  T.fallers = T.fallers.filter(x => x !== f); f.el.classList.add('miss'); setTimeout(() => f.el.remove(), 500);
  T.lives--; T.streak = 0; T.missedCards.push(f.c); recordAnswer(f.c, false);
  $('#b-msg').innerHTML = `Missed: <b>${fmt(bQ(f.c))}</b> → ${fmt(bA(f.c))}`;
  blitzHud();
  if (T.lives <= 0){ T.phase = 'over'; cancelAnimationFrame(T.raf); Store.saveDeck(d); setTimeout(() => { animateView = true; render(); }, 600); }
}
function blitzHud(){ const h = $('#hud'); if (h) h.innerHTML = `<span class="pill">Level ${T.level}</span><span class="pill due">Score ${T.score}</span><span class="lives" aria-label="${T.lives} lives left">${'♥'.repeat(Math.max(0,T.lives))}${'♡'.repeat(3-Math.max(0,T.lives))}</span>`; }


/* =========================================================
   MORE WAYS TO LEARN
   ========================================================= */
const STOP = new Set('the a an and or of to in on for with by from at as is are was were be been being that this these those it its into than then which who whom whose what when where why how not no yes can could may might will would should shall do does did have has had also such other most more many much very each every both either neither only own same so too just your their there they them our out over under about between through during before after above below up down off again further once here all any some few used uses using make makes made like via while because'.split(' '));
function sessionPool(d){ if (V.only){ const s = new Set(V.only); return d.cards.filter(c => s.has(c.id) && complete(c)); } return pool(d); }
function words(text){ return [...plain(text).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)].map(m => ({ w:m[0], i:m.index })); }
function keyIdeas(text, n = 6){ const seen = new Set(); return words(text).map(x => x.w).filter(w => w.length >= 4 && !STOP.has(w.toLowerCase()) && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase())).sort((a,b) => b.length - a.length).slice(0, n); }
function mentions(userText, word){
  const u = norm(plain(userText)), w = norm(word); if (!w) return false;
  if (u.includes(w)) return true;
  if (w.length >= 5) return u.split(' ').some(x => Math.abs(x.length - w.length) <= 2 && lev(x, w) <= 1 + (w.length >= 9 ? 1 : 0));
  return false;
}
function resultsList(d, list, getQ, getA){
  return `<div class="cardlist">${list.map(r => `<div class="crow" style="grid-template-columns:1fr 1.4fr auto;align-items:center"><div class="t">${getQ(r)}</div><div class="d" style="color:var(--ink)">${getA(r)}${r.user ? `<div class="small" style="color:var(--bad)">You: ${esc(r.user)}</div>` : ''}</div><span class="pill ${r.ok ? 'good' : 'bad'}">${r.ok ? 'Got it' : 'Missed'}</span></div>`).join('')}</div>`;
}
function scoreSummary(title, res, extra=''){
  const ok = res.filter(r => r.ok).length, pct = res.length ? Math.round(ok / res.length * 100) : 0, miss = res.filter(r => !r.ok).length;
  if (pct >= 90) confetti();
  return `<div class="panel summary"><div class="bigscore" data-count="${pct}" data-suffix="%">0%</div><p class="muted">${ok} of ${res.length} correct</p>${extra}
    <div class="row center">${miss ? `<button class="btn primary big" data-act="retry-missed">Retry the ${miss} I missed</button>` : ''}<button class="btn" data-act="restart-mode">Start over</button><button class="btn ghost" data-act="back-deck">Back</button></div></div>`;
}
async function nextItem(){ await fadeQ(); T.i++; sub(); }

/* ---------------- FILL THE GAP ---------------- */
function gapFor(c){
  const src = plain(c.def).length >= plain(c.term).length ? 'def' : 'term', text = plain(c[src]);
  const ws = words(text); if (ws.length < 3) return null;
  const cands = ws.filter(x => x.w.length >= 4 && !STOP.has(x.w.toLowerCase())); if (!cands.length) return null;
  const maxLen = Math.max(...cands.map(x => x.w.length)), pick = shuffle(cands.filter(x => x.w.length >= Math.min(maxLen, 6)))[0];
  return { src, before:text.slice(0, pick.i), word:pick.w, after:text.slice(pick.i + pick.w.length) };
}
VIEWS.gap = () => {
  const d = deckById(V.id);
  if (!T.init){ const items = shuffle(sessionPool(d)).map(c => ({ c, g:gapFor(c) })).filter(x => x.g); T = { init:true, active:true, items, i:0, res:[] }; }
  if (!T.items.length) return notEnough('Fill the gap', 'Fill the gap needs cards with a sentence or phrase (at least three words) on one side, like a definition.');
  if (T.i >= T.items.length){ app.innerHTML = `<div class="study">${studyTop('Fill the gap', T.items.length, T.items.length)}${scoreSummary('Fill the gap', T.res)}${resultsList(d, T.res.filter(r => !r.ok), r => esc(r.it.g.before) + `<mark>${esc(r.it.g.word)}</mark>` + esc(r.it.g.after), r => sideHTML(r.it.g.src === 'def' ? r.c.term : r.c.def, r.it.g.src === 'def' ? r.c.termImg : r.c.defImg))}</div>`; return; }
  const it = T.items[T.i], c = it.c, other = it.g.src === 'def' ? 'term' : 'def'; T.answered = false; T.cur = { c };
  app.innerHTML = `<div class="study">${studyTop('Fill the gap', T.i, T.items.length, `<span class="pill good">${T.res.filter(r => r.ok).length} right</span>`)}
  <div class="qcard enter">
    <div class="qhead"><span class="face-tag">${other === 'term' ? 'Term' : 'Definition'}${fromTag(d, c)}</span></div>
    <div class="gap-ctx">${sideHTML(c[other], c[other + 'Img'], true)}</div>
    <p class="small muted" style="font-weight:700;margin-bottom:-10px">Type the missing word</p>
    <div class="gap-sent">${esc(it.g.before)}<input class="gap-in" id="g-in" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:calc(${Math.max(4, it.g.word.length)}ch + 28px)" aria-label="Missing word">${esc(it.g.after)}</div>
    <div class="row between"><button class="btn ghost" data-act="g-skip">Show me</button><button class="btn primary" data-act="g-check">Check <span class="kbd">Enter</span></button></div>
    <div id="fb" class="stack"></div>
  </div></div>`;
  $('#g-in').focus();
  onceKeys(e => { if (V.name !== 'gap' || e.key !== 'Enter' || T.i >= (T.items?.length || 0)) return; e.preventDefault(); T.answered ? nextItem() : gapCheck(false); });
};
function gapCheck(skip){
  const it = T.items[T.i], inp = $('#g-in'), v = skip ? '' : inp.value.trim();
  if (!skip && !v){ inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); return; }
  const g = skip ? 'wrong' : grade(v, it.g.word), ok = g !== 'wrong';
  T.answered = true; recordAnswer(it.c, ok); Store.saveDeck(deckById(V.id)); T.res.push({ c:it.c, it, ok, user:v });
  inp.disabled = true; inp.classList.add(ok ? 'good' : 'bad');
  $$('[data-act="g-check"],[data-act="g-skip"]').forEach(b => b.disabled = true);
  $('#fb').innerHTML = `<div class="fb ${g === 'right' ? 'ok' : g === 'close' ? 'close' : 'no'}"><b class="h">${ok ? I.check : I.xmark} ${g === 'right' ? 'Correct!' : g === 'close' ? 'Close enough — check the spelling' : skip ? 'Here it is' : 'Not quite'}</b><div style="color:var(--ink)">${esc(it.g.before)}<mark>${esc(it.g.word)}</mark>${esc(it.g.after)}</div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="next-item" id="next-q">Continue <span class="kbd">Enter</span></button></div>`;
  $('#next-q').focus({ preventScroll:true });
}

/* ---------------- EXPLAIN IT (self-explanation) ---------------- */
VIEWS.explain = () => {
  const d = deckById(V.id);
  if (!T.init){ T = { init:true, active:true, cards:shuffle(sessionPool(d).filter(c => hasAText(d, c))), i:0, res:[] }; }
  if (!T.cards.length) return notEnough('Explain it', `Explain it needs cards with a written ${aName(d).toLowerCase()} to compare against.`);
  if (T.i >= T.cards.length){ app.innerHTML = `<div class="study">${studyTop('Explain it', T.cards.length, T.cards.length)}${scoreSummary('Explain it', T.res, `<p class="small muted">Explaining in your own words is one of the strongest ways to build understanding, not just memory.</p>`)}</div>`; return; }
  const c = T.cards[T.i]; T.cur = { c }; T.revealed = false;
  app.innerHTML = `<div class="study">${studyTop('Explain it', T.i, T.cards.length)}
  <div class="qcard enter">
    <div class="qhead"><span class="face-tag">${qName(d)}${fromTag(d, c)}</span><span class="row" style="gap:2px"><button class="icon-btn flat" data-act="q-speak" aria-label="Read aloud">${I.speak}</button><button class="icon-btn flat" data-act="q-star" aria-pressed="${c.starred}" aria-label="Star this card">${c.starred ? I.star : I.starO}</button></span></div>
    ${promptBlock(d, c)}
    <p class="small muted" style="font-weight:700;margin-bottom:-8px">Explain it in your own words — what is it, why does it matter, how does it connect to other ideas?</p>
    <textarea class="input" id="x-in" rows="4" style="resize:vertical;overflow:auto" placeholder="Write as if you're teaching a friend…"></textarea>
    <div class="row between"><span class="small muted">Don't peek. Rough is fine.</span><button class="btn primary" data-act="x-reveal">Compare with the card</button></div>
    <div id="fb" class="stack"></div>
  </div></div>`;
  $('#x-in').focus();
  onceKeys(e => { if (V.name !== 'explain') return; if (T.revealed && /^[1-3]$/.test(e.key)) $(`[data-act="x-rate"][data-v="${e.key}"]`)?.click(); });
};
function explainReveal(){
  const d = deckById(V.id), c = T.cur.c, user = $('#x-in').value; T.revealed = true; T.cur.user = user;
  const ideas = keyIdeas(A(d, c)), hit = ideas.filter(w => mentions(user, w));
  $('#x-in').disabled = true; $('[data-act="x-reveal"]').disabled = true;
  $('#fb').innerHTML = `<div class="fb" style="background:var(--surface-2);color:var(--ink)"><span class="small muted" style="font-weight:800">THE CARD SAYS</span><div style="font-weight:700">${optInner(d, c)}</div>
    ${ideas.length ? `<span class="small muted" style="font-weight:800;margin-top:6px">KEY IDEAS YOU COVERED · ${hit.length} of ${ideas.length}</span><div class="row" style="gap:6px">${ideas.map(w => `<span class="pill ${hit.includes(w) ? 'good' : ''}">${hit.includes(w) ? '✓ ' : ''}${esc(w)}</span>`).join('')}</div>` : ''}</div>
    <p class="small muted" style="font-weight:700;text-align:center">How did your explanation compare?</p>
    <div class="rate" style="grid-template-columns:repeat(3,1fr);margin-top:0">
      <button class="btn r0" data-act="x-rate" data-v="1">Missed it<small>press 1</small></button>
      <button class="btn r1" data-act="x-rate" data-v="2">Partly<small>press 2</small></button>
      <button class="btn r2" data-act="x-rate" data-v="3">Nailed it<small>press 3</small></button></div>`;
  $('#fb').scrollIntoView({ block:'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}

/* ---------------- BRAIN DUMP (free recall) ---------------- */
VIEWS.dump = () => {
  const d = deckById(V.id);
  if (!T.init){ T = { init:true, active:true, phase:'ready', mins:3, cards:sessionPool(d).filter(c => plain(c.term).trim()) }; }
  if (T.cards.length < 2) return notEnough('Brain dump', 'Brain dump needs at least 2 cards with a written term.');
  if (T.phase === 'ready'){
    app.innerHTML = `<div class="study">${studyTop('Brain dump', 0, 1)}<div class="panel summary">
      <span class="ic g-dump" style="width:64px;height:64px;border-radius:20px;display:grid;place-items:center;color:#fff">${I.brain.replace('<svg','<svg style="width:32px;height:32px"')}</span>
      <h2>Write down everything you remember</h2>
      <p class="muted" style="max-width:52ch">Without looking, list every term you can recall from <b>${esc(d.title)}</b> (${T.cards.length} terms). Pulling ideas out of memory with no hints is one of the most effective ways to study. Then Recall shows what you forgot.</p>
      <div class="stack" style="gap:6px;justify-items:center"><span class="small muted" style="font-weight:700">Time limit</span>${seg('dump-time', [['2','2 min'],['3','3 min'],['5','5 min'],['0','No limit']], String(T.mins))}</div>
      <button class="btn primary big" data-act="dump-start">Start</button></div></div>`;
    requestAnimationFrame(placeThumbs); return;
  }
  if (T.phase === 'write'){
    app.innerHTML = `<div class="study">${studyTop('Brain dump', 0, T.cards.length, T.end ? `<span class="timer" id="dump-t" style="font-size:20px"></span>` : '')}
      <div class="qcard"><p class="small muted" style="font-weight:700">One term per line (or separate with commas). Spelling doesn't need to be perfect.</p>
      <textarea class="input" id="dump-in" rows="12" style="resize:vertical;overflow:auto;font-size:17px;line-height:1.7" placeholder="mitochondria&#10;ribosome&#10;…"></textarea>
      <div class="row between"><span class="small muted" id="dump-n">0 written</span><button class="btn primary" data-act="dump-done">I'm done — check it</button></div></div></div>`;
    const ta = $('#dump-in'); ta.focus(); if (T.text) ta.value = T.text;
    ta.oninput = () => { T.text = ta.value; $('#dump-n').textContent = ta.value.split(/[\n,;]+/).filter(x => x.trim()).length + ' written'; };
    if (T.end){ const tick = () => { const el = $('#dump-t'); if (!el || T.phase !== 'write') return; const left = T.end - Date.now(); if (left <= 0){ toast("Time's up!"); return dumpCheck(); } el.textContent = mmss(left); el.style.color = left < 20000 ? 'var(--bad)' : ''; }; clearInterval(T.clock); T.clock = setInterval(tick, 500); tick(); cleanup.push(() => clearInterval(T.clock)); }
    return;
  }
  const got = T.cards.filter(c => T.hits.has(c.id)), missed = T.cards.filter(c => !T.hits.has(c.id)), pct = Math.round(got.length / T.cards.length * 100);
  if (pct >= 80) confetti();
  app.innerHTML = `<div class="study">${studyTop('Brain dump', got.length, T.cards.length)}
    <div class="panel summary"><div class="bigscore" data-count="${pct}" data-suffix="%">0%</div><p class="muted">You recalled ${got.length} of ${T.cards.length} terms from memory${T.extra.length ? ` · ${T.extra.length} ${T.extra.length === 1 ? 'thing' : 'things'} didn't match a card` : ''}</p>
      <div class="row center">${missed.length ? `<button class="btn primary big" data-act="dump-study">Study the ${missed.length} I forgot</button>` : ''}<button class="btn" data-act="restart-mode">Try again</button><button class="btn ghost" data-act="back-deck">Back</button></div></div>
    ${missed.length ? `<p class="group-title" style="margin-top:22px">Forgot (${missed.length})</p><div class="cardlist">${missed.map(c => `<div class="crow" style="grid-template-columns:1fr 1.5fr"><div class="t">${sideHTML(c.term, c.termImg)}</div><div class="d">${sideHTML(c.def, c.defImg)}</div></div>`).join('')}</div>` : ''}
    ${got.length ? `<p class="group-title" style="margin-top:22px">Remembered (${got.length})</p><div class="chips">${got.map(c => `<span class="pill good">✓ ${fmt(c.term)}</span>`).join('')}</div>` : ''}
    ${T.extra.length ? `<p class="group-title" style="margin-top:22px">Didn't match any card</p><div class="chips">${T.extra.map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div>` : ''}
  </div>`;
};
function dumpCheck(){
  if (T.phase !== 'write') return; clearInterval(T.clock);
  const text = $('#dump-in')?.value || T.text || '', items = text.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean), used = new Set();
  T.hits = new Set();
  T.cards.forEach(c => {
    const term = plain(c.term), alts = [term, ...term.split(/[\/;,(]| or /)].map(x => x.replace(/\)/g, '').trim()).filter(x => x.length > 1);
    const k = items.findIndex(it => alts.some(a => grade(it, a) !== 'wrong' || (norm(a).length >= 4 && norm(it).includes(norm(a)))));
    if (k >= 0){ T.hits.add(c.id); used.add(k); }
  });
  T.extra = items.filter((_, k) => !used.has(k)).slice(0, 30);
  T.cards.forEach(c => recordAnswer(c, T.hits.has(c.id))); Store.saveDeck(deckById(V.id));
  T.phase = 'done'; animateView = true; render();
}

/* ---------------- LISTEN & SPELL ---------------- */
VIEWS.listen = () => {
  const d = deckById(V.id);
  if (!('speechSynthesis' in window)) return notEnough('Listen & spell', "Your browser can't read text aloud, so this mode isn't available here. Try Chrome or Edge.");
  if (!T.init){ T = { init:true, active:true, cards:shuffle(sessionPool(d).filter(c => plain(c.term).trim())), i:0, res:[] }; }
  if (!T.cards.length) return notEnough('Listen & spell', 'Listen & spell needs cards with a written term.');
  if (T.i >= T.cards.length){ app.innerHTML = `<div class="study">${studyTop('Listen & spell', T.cards.length, T.cards.length)}${scoreSummary('Listen & spell', T.res)}${resultsList(d, T.res.filter(r => !r.ok), r => fmt(r.c.term), r => sideHTML(r.c.def, r.c.defImg))}</div>`; return; }
  const c = T.cards[T.i], L = d.isCombo ? (d.deckOf.get(c.id) || d) : d; T.answered = false; T.cur = { c, lang:L.termLang };
  app.innerHTML = `<div class="study">${studyTop('Listen & spell', T.i, T.cards.length, `<span class="pill good">${T.res.filter(r => r.ok).length} right</span>`)}
  <div class="qcard enter">
    <div class="listen-hero"><button class="listen-btn" data-act="ls-play" aria-label="Play the word">${I.speak}</button>
      <div class="row center" style="gap:6px"><button class="btn ghost" data-act="ls-play">Play again</button><button class="btn ghost" data-act="ls-slow">Slow</button><button class="btn ghost" data-act="ls-hint">Show meaning</button></div>
      <div class="small muted hidden" id="ls-hint" style="text-align:center">${sideHTML(c.def, c.defImg)}</div></div>
    <input class="input answer-in" id="w-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type what you hear" aria-label="Your answer">
    <div class="row between"><button class="btn ghost" data-act="ls-skip">Skip</button><button class="btn primary" data-act="ls-check">Check <span class="kbd">Enter</span></button></div>
    <div id="fb" class="stack"></div>
  </div></div>`;
  $('#w-in').focus(); setTimeout(() => lsPlay(1), 350);
  onceKeys(e => { if (V.name !== 'listen' || e.key !== 'Enter' || T.i >= (T.cards?.length || 0)) return; e.preventDefault(); T.answered ? nextItem() : lsCheck(false); });
};
function lsPlay(rate){
  const t = plain(T.cur.c.term); speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = T.cur.lang || 'en-US'; u.rate = rate === 1 ? 0.9 : 0.55; speechSynthesis.speak(u);
  const b = $('.listen-btn'); if (b){ b.classList.remove('ping'); void b.offsetWidth; b.classList.add('ping'); }
}
function lsCheck(skip){
  const d = deckById(V.id), c = T.cur.c, inp = $('#w-in'), v = skip ? '' : inp.value;
  if (!skip && !v.trim()){ inp.classList.remove('shake'); void inp.offsetWidth; inp.classList.add('shake'); return; }
  const target = plain(c.term), exact = norm(v) === norm(target), g = skip ? 'wrong' : grade(v, target), ok = g !== 'wrong';
  T.answered = true; recordAnswer(c, ok); Store.saveDeck(d); T.res.push({ c, ok, user:v });
  inp.disabled = true; if (!ok) inp.classList.add('shake');
  $$('[data-act="ls-check"],[data-act="ls-skip"]').forEach(b => b.disabled = true); $('#ls-hint').classList.remove('hidden');
  $('#fb').innerHTML = `<div class="fb ${exact || g === 'right' ? 'ok' : ok ? 'close' : 'no'}"><b class="h">${ok ? I.check : I.xmark} ${exact || g === 'right' ? 'Spelled right!' : ok ? 'Almost — check the spelling' : 'Not quite'}</b>${exact ? '' : `<div>Correct spelling: <span class="ans">${fmt(c.term)}</span></div>`}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="next-item" id="next-q">Continue <span class="kbd">Enter</span></button></div>`;
  $('#next-q').focus({ preventScroll:true });
}

/* ---------------- QUICK FIRE (60-second true / false) ---------------- */
VIEWS.quick = () => {
  const d = deckById(V.id), best = S.profile.best['quick:' + d.id] || 0;
  if (!T.init) T = { init:true, active:true, phase:'ready' };
  if (T.phase !== 'play'){
    const over = T.phase === 'over', isBest = over && T.score > best;
    if (isBest){ S.profile.best['quick:' + d.id] = T.score; Store.saveProfile(); confetti(); }
    app.innerHTML = `<div class="study">${studyTop('Quick Fire', 0, 1)}<div class="panel summary">
      ${over ? `<div class="bigscore" data-count="${T.score}">0</div><h2>${isBest ? 'New high score!' : "Time's up!"}</h2><p class="muted">${T.right} right · ${T.wrongs.length} wrong · best streak ${T.bestStreak}</p>`
        : `<span class="ic g-quick" style="width:64px;height:64px;border-radius:20px;display:grid;place-items:center;color:#fff">${I.bolt.replace('<svg','<svg style="width:32px;height:32px"')}</span><h2>True or false? You've got 60 seconds.</h2><p class="muted" style="max-width:48ch">Each card shows a term and a definition. Decide fast if they match. Get 5 in a row to multiply your points.</p><p class="small muted">Keys: <span class="kbd">←</span> or <span class="kbd">F</span> false · <span class="kbd">→</span> or <span class="kbd">J</span> true</p>`}
      ${over && T.wrongs.length ? resultsList(d, T.wrongs.map(c => ({ c, ok:false })), r => sideHTML(Q(d, r.c), QI(d, r.c)), r => optInner(d, r.c)) : ''}
      ${best || isBest ? `<span class="pill due">High score: ${Math.max(best, over ? T.score : 0)}</span>` : ''}
      <button class="btn primary big" data-act="qf-start">${over ? 'Play again' : 'Start'}</button></div></div>`;
    return;
  }
  app.innerHTML = `<div class="study">
    <div class="study-top"><button class="icon-btn close" data-act="exit-study" aria-label="Leave Quick Fire">${I.x}</button>
      <div class="mid"><div class="ttl"><span>Quick Fire</span><span id="qf-time">60s</span></div><div class="progress qf-bar"><span id="qf-bar" style="width:100%"></span></div></div>
      <div class="hud"><span class="pill due" id="qf-score">0</span><span class="pill" id="qf-mult">×1</span></div></div>
    <div id="qf-card"></div>
    <div class="tf qf-btns"><button class="btn big qf-no" data-act="qf-ans" data-v="0">${I.xmark} False</button><button class="btn big qf-yes" data-act="qf-ans" data-v="1">${I.check} True</button></div>
  </div>`;
  qfNext();
  onceKeys(e => { if (V.name !== 'quick' || T.phase !== 'play') return; const k = e.key.toLowerCase(); if (k === 'arrowleft' || k === 'f') qfAnswer(false); if (k === 'arrowright' || k === 'j') qfAnswer(true); });
};
function qfStart(){
  T = { init:true, active:true, phase:'play', pool:pool(deckById(V.id)), score:0, streak:0, bestStreak:0, right:0, wrongs:[], end:Date.now() + 60000 };
  animateView = true; render();
  const tick = () => { if (V.name !== 'quick' || T.phase !== 'play') return; const left = Math.max(0, T.end - Date.now()); const b = $('#qf-bar'); if (b) b.style.width = (left / 600) + '%'; const t = $('#qf-time'); if (t) t.textContent = Math.ceil(left / 1000) + 's';
    if (left <= 0){ T.phase = 'over'; Store.saveDeck(deckById(V.id)); animateView = true; return render(); } T.raf = requestAnimationFrame(tick); };
  T.raf = requestAnimationFrame(tick); cleanup.push(() => cancelAnimationFrame(T.raf));
}
function qfNext(){
  const d = deckById(V.id), c = T.pool[Math.floor(Math.random() * T.pool.length)];
  const others = T.pool.filter(x => x.id !== c.id && answerKey(d, x) !== answerKey(d, c));
  const truth = !others.length || Math.random() < 0.5, shown = truth ? c : others[Math.floor(Math.random() * others.length)];
  T.cur = { c, truth, shown };
  $('#qf-card').innerHTML = `<div class="qcard qf-card">${promptBlock(d, c)}<div class="qf-eq">means</div><div class="qf-ans oc">${optInner(d, shown)}</div></div>`;
}
function qfAnswer(v){
  if (T.phase !== 'play' || !T.cur) return;
  const ok = v === T.cur.truth, card = $('.qf-card');
  recordAnswer(T.cur.c, ok);
  if (ok){ T.right++; T.streak++; T.bestStreak = Math.max(T.bestStreak, T.streak); T.score += Math.min(4, 1 + Math.floor(T.streak / 5)); }
  else { T.streak = 0; T.wrongs.push(T.cur.c); }
  const mult = Math.min(4, 1 + Math.floor(T.streak / 5));
  $('#qf-score').textContent = T.score; const m = $('#qf-mult'); m.textContent = '×' + mult; m.className = 'pill ' + (mult > 1 ? 'warn' : '');
  card?.classList.add(ok ? 'qf-ok' : 'qf-bad');
  setTimeout(() => { if (T.phase === 'play') qfNext(); }, ok ? 140 : 380);
  T.cur = null;
}

/* =========================================================
   SEARCH, PRINT, HELP
   ========================================================= */
function searchModal(){
  modal(`<div class="search-box">${I.search}<input class="input" id="q" placeholder="Search every card and deck" autocomplete="off" aria-label="Search"></div><div id="sr" class="sr"></div>`, m => {
    const inp = $('#q', m);
    const run = () => {
      const q = norm(plain(inp.value)); const out = $('#sr', m);
      if (!q){ out.innerHTML = '<p class="muted small" style="padding:6px 4px">Search terms, definitions and deck names across all your courses.</p>'; return; }
      const res = [];
      for (const d of S.decks){
        if (norm(d.title).includes(q)) res.push({ d });
        for (const c of d.cards){ if (res.length >= 60) break; if (norm(plain(c.term)).includes(q) || norm(plain(c.def)).includes(q)) res.push({ d, c }); }
      }
      out.innerHTML = res.length ? res.map(r => r.c
        ? `<button class="sr-item" data-act="goto-card" data-deck="${r.d.id}" data-card="${r.c.id}"><span class="small muted">${esc(r.d.title)}</span><b>${fmt(r.c.term) || '(image)'}</b><span class="muted small">${fmt(r.c.def) || '(image)'}</span></button>`
        : `<button class="sr-item" data-act="open-deck" data-id="${r.d.id}"><span class="small muted">Deck</span><b>${esc(r.d.title)}</b><span class="muted small">${r.d.cards.length} cards</span></button>`).join('')
        : '<p class="muted small" style="padding:6px 4px">No matches.</p>';
    };
    inp.oninput = run; run();
  });
}
function printDeck(d, layout){
  const root = $('#print-root'), c = courseById(d.course);
  const side = (t, img) => `${t ? `<div>${fmt(t)}</div>` : ''}${img ? `<img src="${img}" alt="">` : ''}`;
  root.innerHTML = `<h1>${esc(d.title)}</h1><p class="pmeta">${c ? esc(c.name) + ' · ' : ''}${d.cards.length} cards${d.examDate ? ' · exam ' + niceDate(d.examDate) : ''}</p>` + (layout === 'cards'
    ? `<p class="pmeta">Cut along the lines and fold each card in half.</p><div class="pcards">${d.cards.map(x => `<div class="pcard"><div>${side(x.term, x.termImg)}</div><div>${side(x.def, x.defImg)}</div></div>`).join('')}</div>`
    : `<table><thead><tr><th></th><th>Term</th><th>Definition</th></tr></thead><tbody>${d.cards.map((x, i) => `<tr><td class="pn">${i+1}</td><td>${side(x.term, x.termImg)}</td><td>${side(x.def, x.defImg)}</td></tr>`).join('')}</tbody></table>`);
  setTimeout(() => window.print(), 80);
}
function helpModal(){
  modal(`<h2>How Recall works</h2>
  <div class="help">
    <details open><summary>Getting started</summary><p>Make a <b>deck</b> for each lecture, chapter or topic, and group decks into <b>courses</b> (Settings → Manage courses). Add an <b>exam date</b> to a deck and Recall shows a countdown on the home screen plus how many cards to learn each day to be ready.</p></details>
    <details><summary>Studying several decks at once & starred cards</summary><p>Tap <b>Study decks together</b> on the home screen (or <b>Study all</b> next to a course) to combine decks into one set — a whole class, or a mix from different classes. Every study mode works, and progress is saved back to each original deck.</p><p><b>Star</b> (☆) any card — in the card list, while flipping flashcards (press <span class="kbd">S</span>), or during Learn and Write. Then use <b>Quick study → Starred cards</b> on the home screen to drill just your starred cards from every deck, or pick <b>★ Starred</b> when studying decks together.</p></details>
    <details><summary>Which study mode should I use?</summary>
      <p><b>Flashcards</b> — flip through and sort into "know it" or "still learning". Good for a first pass.<br>
      <b>Learn</b> — a guided quiz: multiple choice first, then typing, until every card is mastered.<br>
      <b>Smart Review</b> — spaced repetition. Shows only cards you're about to forget. Do this daily; it's the best way to remember long-term.<br>
      <b>Practice test</b> — a mock exam with mixed questions and an optional time limit.<br>
      <b>Write</b> — type every answer from memory. Small typos and accents are forgiven.<br>
      <b>Fill the gap</b> — a key word disappears from each definition; type it back. Builds precise recall of details.<br>
      <b>Explain it</b> — explain each term in your own words, then compare with the card and see which key ideas you covered. Best for deep understanding.<br>
      <b>Brain dump</b> — write down every term you remember with no hints, then see what you forgot. One of the most effective ways to prepare for an exam.<br>
      <b>Listen & spell</b> — hear a term read aloud and type it. Ideal for languages and tricky spellings.<br>
      <b>Match</b>, <b>Quick Fire</b> and <b>Blitz</b> — fast games for a study break.</p>
      <p>Not sure? Each deck shows a <b>Recommended next</b> mode based on your progress and exam date.</p></details>
    <details><summary>Formatting, symbols and fill-in-the-blank</summary>
      <table class="htable"><tr><td><code>H_2O</code></td><td>H₂O</td></tr><tr><td><code>x^2</code>, <code>e^{-kt}</code></td><td>x², e<sup>-kt</sup></td></tr><tr><td><code>Ca^2+</code>, <code>[H^+]</code></td><td>Ca<sup>2+</sup>, [H<sup>+</sup>]</td></tr><tr><td><code>**bold**</code>, <code>*italic*</code></td><td><b>bold</b>, <i>italic</i></td></tr><tr><td><code>\\alpha \\beta \\Delta \\pi \\mu</code></td><td>α β Δ π μ</td></tr><tr><td><code>\\pm \\times \\leq \\geq \\infty \\sqrt</code></td><td>± × ≤ ≥ ∞ √</td></tr><tr><td><code>-></code>, <code>&lt;=></code></td><td>→, ⇌</td></tr></table>
      <p><b>Fill in the blank:</b> in the term box, write a sentence with the hidden word in double braces and leave the definition empty, e.g. <code>The {{mitochondria}} produces ATP</code>.</p></details>
    <details><summary>Images and diagrams</summary><p>In the editor, click <b>Image</b> under a term or definition, paste a screenshot straight into a card, or drag a picture onto it. Great for anatomy, graphs, structures and maps. Click any image while studying to zoom in.</p></details>
    <details><summary>Keyboard shortcuts</summary><p><span class="kbd">/</span> search · <span class="kbd">Space</span> flip or reveal · <span class="kbd">←</span> <span class="kbd">→</span> previous / next · <span class="kbd">1</span>–<span class="kbd">4</span> choose an answer or rating · <span class="kbd">S</span> star · <span class="kbd">Enter</span> check / continue · <span class="kbd">Esc</span> leave or close</p></details>
    <details><summary>Where is my data saved?</summary><p>Everything saves automatically in this browser on this computer, every time you make a change. Use <b>Settings → Backup & restore</b> to download a backup file now and then — it protects your decks if you clear your browser data, and moves them to another computer.</p></details>
  </div>
  <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="modal-close">Got it</button></div>`);
}

/* =========================================================
   ACTIONS
   ========================================================= */
const ACT = {
  home: () => go('home'),
  theme: (el, e) => {
    const flip = () => { S.profile.theme = isDark() ? 'light' : 'dark'; applyTheme(); };
    if (!document.startViewTransition || reduceMotion){ flip(); }
    else {
      const x = e?.clientX || innerWidth - 40, y = e?.clientY || 30, r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      const de = document.documentElement; de.style.setProperty('--vx', x + 'px'); de.style.setProperty('--vy', y + 'px'); de.style.setProperty('--vr', r + 'px');
      de.classList.add('theme-vt'); const t = document.startViewTransition(flip); t.finished.finally(() => de.classList.remove('theme-vt'));
    }
    Store.saveProfile();
  },
  settings: el => openMenu(el, [['courses','Manage courses',I.folder], ['set-goal','Daily goal',I.target], ['backup','Backup & restore',I.db], ['theme', isDark() ? 'Light mode' : 'Dark mode', isDark() ? I.sun : I.moon], ['help','Help & tips',I.help]]),
  search: () => searchModal(),
  timer: () => timerModal(),
  help: () => helpModal(),
  courses: () => coursesModal(),
  'exam-help': () => modal(`<h2>Your exam plan</h2><p class="muted">Recall counts the cards in the deck that aren't mastered yet and divides them by the days left until the exam. Learn that many cards a day (with Learn or Smart Review) and you'll have seen everything with time to spare. A card counts as mastered once you've answered it correctly a few times in a row, or once Smart Review has spaced it a week or more apart.</p><div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="modal-close">Got it</button></div>`),
  'focus-go': el => { focusStart(+el.dataset.f, +el.dataset.b); closeModal(); toast(`Focus timer started: ${el.dataset.f} minutes. You've got this.`); },
  'focus-pause': () => { if (Focus.paused){ Focus.end = Date.now() + Focus.left; Focus.paused = false; } else { Focus.left = focusLeft(); Focus.paused = true; } focusTick(); timerModal(); },
  'focus-skip': () => { Focus.paused = false; Focus.end = Date.now() - 1; focusTick(); closeModal(); },
  'focus-stop': () => { focusStop(); closeModal(); toast('Timer stopped'); },
  'retry-missed': () => { const ids = (T.res || []).filter(r => !r.ok).map(r => r.c.id); V.only = ids; T = {}; animateView = true; render(); },
  'restart-mode': () => { T = {}; animateView = true; render(); },
  'next-item': () => nextItem(),
  'g-check': () => gapCheck(false), 'g-skip': () => gapCheck(true),
  'x-reveal': () => explainReveal(),
  'x-rate': el => { const v = +el.dataset.v, c = T.cur.c; recordAnswer(c, v === 3); Store.saveDeck(deckById(V.id)); T.res.push({ c, ok:v === 3, user:'' }); nextItem(); },
  'dump-time': el => { T.mins = +el.dataset.v; segPick(el); },
  'dump-start': () => { T.phase = 'write'; T.end = T.mins ? Date.now() + T.mins * MIN : 0; T.text = ''; animateView = true; render(); },
  'dump-done': () => dumpCheck(),
  'dump-study': () => go('flash', { id:V.id, only:T.cards.filter(c => !T.hits.has(c.id)).map(c => c.id) }),
  'ls-play': () => lsPlay(1), 'ls-slow': () => lsPlay(0.5),
  'ls-hint': el => { $('#ls-hint').classList.toggle('hidden'); el.textContent = $('#ls-hint').classList.contains('hidden') ? 'Show meaning' : 'Hide meaning'; $('#w-in')?.focus(); },
  'ls-check': () => lsCheck(false), 'ls-skip': () => lsCheck(true),
  'qf-start': () => qfStart(),
  'qf-ans': el => qfAnswer(el.dataset.v === '1'),
  'combo-open': () => go('combo'),
  'combo-course': el => startCombo(el.dataset.ids.split(','), 'all'),
  'combo-starred': () => startCombo(starredTotals().decks.map(d => d.id), 'starred'),
  'combo-work': () => startCombo(workTotals().decks.map(d => d.id), 'work'),
  'pick-all': () => { comboCfg().decks = S.decks.map(d => d.id); Store.saveProfile(); sub(); },
  'pick-none': () => { comboCfg().decks = []; Store.saveProfile(); sub(); },
  'pick-only': el => { comboCfg().decks = el.dataset.ids.split(','); Store.saveProfile(); sub(); },
  'pick-group': el => { const c = comboCfg(), ids = el.dataset.ids.split(','); c.decks = el.dataset.on === '1' ? [...new Set([...c.decks, ...ids])] : c.decks.filter(x => !ids.includes(x)); Store.saveProfile(); sub(); },
  'combo-filter': el => { comboCfg().filter = el.dataset.v; Store.saveProfile(); sub(); },
  'combo-front': el => { comboCfg().front = el.dataset.v; Store.saveProfile(); segPick(el); COMBO = null; },
  'combo-mode': el => { const d = buildCombo(); if (d.cards.length < 2) return toast('Pick decks with at least 2 cards'); go(el.dataset.v, { id:'__combo' }); },
  'home-course': el => { S.profile.homeCourse = el.dataset.v; Store.saveProfile(); sub(); },
  'c-color': el => { const c = courseById(el.dataset.id); c.color = COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length]; el.style.background = c.color; Store.saveProfile(); },
  'c-del': el => { const c = courseById(el.dataset.id); const n = S.decks.filter(d => d.course === c.id).length; confirmBox(`Delete "${c.name}"?`, n ? `Its ${n} ${n===1?'deck stays':'decks stay'} — they just won't be in a course anymore.` : 'This course has no decks.', 'Delete course', () => { S.profile.courses = courses().filter(x => x.id !== c.id); S.decks.filter(d => d.course === c.id).forEach(d => { d.course = ''; Store.saveDeck(d); }); if (S.profile.homeCourse === c.id) S.profile.homeCourse = ''; Store.saveProfile(); coursesModal(); }, true); },
  'new-deck': () => go('edit', { course: courseById(S.profile.homeCourse) ? S.profile.homeCourse : '' }),
  'new-paste': () => go('edit', { tab:'paste' }),
  'import-file': () => $('#filein')?.click(),
  'import-file-edit': () => $('#filein2')?.click(),
  'open-deck': el => go('deck', { id:el.dataset.id }),
  'goto-card': el => go('deck', { id:el.dataset.deck, focus:el.dataset.card }),
  'back-deck': () => V.id === '__combo' ? go('combo') : go('deck', { id:V.id }),
  'exit-study': () => V.id === '__combo' ? go('combo') : V.id ? go('deck', { id:V.id }) : go('home'),
  'review-all': () => go('review', {}),
  zoom: el => zoomImage(el.dataset.src),
  backup: () => {
    const cards = S.decks.reduce((n, d) => n + d.cards.length, 0);
    const last = S.profile.lastBackup ? new Date(S.profile.lastBackup).toLocaleDateString() : null;
    modal(`<h2>Backup & restore</h2>
      <p class="muted">Recall saves automatically in this browser, so your decks are here every time you open it. A backup file keeps them safe if you clear your browser data, and lets you move them to another computer or browser.</p>
      <div class="statcard" style="box-shadow:none"><div class="ico" style="background:var(--good-soft);color:var(--good)">${I.check}</div><div><b>${S.decks.length} ${S.decks.length===1?'deck':'decks'}, ${cards} cards</b><div class="lbl">Saved in this browser${last ? ' · last backup ' + last : ' · no backup yet'}</div></div></div>
      <div class="stack" style="gap:8px"><button class="btn primary" id="bk-save">${I.download} Download backup</button><button class="btn" id="bk-load">${I.upload} Restore from a backup file</button></div>
      <input type="file" id="bk-file" accept=".json" class="hidden">`, m => {
      $('#bk-save', m).onclick = async () => {
        const name = 'recall-backup-' + dayKey() + '.json';
        if (await saveFile(name, JSON.stringify({ recallBackup:1, savedAt:new Date().toISOString(), decks:S.decks, profile:S.profile }), 'application/json')){ S.profile.lastBackup = Date.now(); Store.saveProfile(); toast('Backup saved'); closeModal(); }
      };
      $('#bk-load', m).onclick = () => $('#bk-file', m).click();
      $('#bk-file', m).onchange = async e => { const f = e.target.files[0]; if (f) restoreBackup(await f.text()); };
    });
  },
  'set-goal': () => modal(`<h2>Daily goal</h2><p class="muted">How many answers do you want to get through each day? Short daily sessions work better than cramming the night before.</p>
      ${seg('goal', [['20','20'],['40','40'],['80','80'],['150','150']], String(S.profile.goal))}
      <div class="field"><label for="npd">New cards added to Smart Review per day</label><input class="input" type="number" id="npd" min="1" max="500" value="${S.profile.newPerDay}" style="max-width:140px"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="modal-close">Done</button></div>`,
    m => { requestAnimationFrame(placeThumbs); $('#npd', m).onchange = e => { S.profile.newPerDay = Math.max(1, +e.target.value || 20); Store.saveProfile(); }; }, () => { if (!T.active && V.name !== 'edit') sub(); }),
  goal: el => { S.profile.goal = +el.dataset.v; segPick(el); Store.saveProfile(); },
  'modal-close': () => closeModal(),
  'modal-bg': (el, e) => { if (e.target === el) closeModal(); },
  'deck-menu': el => openMenu(el, [['set-exam','Set exam date',I.cal], ['print','Print study sheet / PDF',I.print], ['print-cards','Print cut-out cards',I.cards], ['export','Export or share',I.download], ['reset-progress','Reset progress',I.turn], ['delete-deck','Delete deck',I.trash,'danger']]),
  'set-exam': () => examModal(deckById(V.id)),
  print: () => printDeck(deckById(V.id), 'table'),
  'print-cards': () => printDeck(deckById(V.id), 'cards'),
  'edit-deck': () => go('edit', { id:V.id }),
  'delete-deck': () => {
    const d = deckById(V.id), idx = S.decks.indexOf(d), copy = JSON.parse(JSON.stringify(d));
    confirmBox('Delete this deck?', `"${d.title}" and its ${d.cards.length} cards will be removed.`, 'Delete deck', () => {
      Store.removeDeck(d.id); go('home');
      toast('Deck deleted', { label:'Undo', fn:() => { S.profile.deleted = (S.profile.deleted || []).filter(x => x !== copy.id); S.decks.splice(Math.min(idx, S.decks.length), 0, copy); Store.saveDeck(copy); Store.saveProfile(); toast('Deck restored'); go('deck', { id:copy.id }); } });
    }, true);
  },
  'reset-progress': () => { const d = deckById(V.id); confirmBox('Reset progress?', 'This clears mastery, review schedules and stats for every card in this deck. Your cards stay.', 'Reset progress', () => { d.cards.forEach(c => { c.lv = 0; c.st = {c:0,w:0,s:0}; c.srs = newCard().srs; }); Store.saveDeck(d); toast('Progress reset'); sub(); }, true); },
  export: () => {
    const d = deckById(V.id);
    modal(`<h2>Export "${esc(d.title)}"</h2><p class="muted">CSV opens in Excel and Google Sheets and imports into Anki or Quizlet (text only). The Recall file keeps images, stars and everything else, so you can send it to a classmate.</p>
      <div class="stack" style="gap:8px"><button class="btn primary" id="ex-json">${I.download} Download Recall file (.json)</button><button class="btn" id="ex-csv">${I.download} Download CSV</button><button class="btn ghost" id="ex-copy">Copy as text</button></div>`, m => {
      const csv = d.cards.map(c => [plain(c.term), plain(c.def)].map(x => `"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
      const json = JSON.stringify({ title:d.title, desc:d.desc, termLang:d.termLang, defLang:d.defLang, cards:d.cards.map(c => ({ term:c.term, def:c.def, termImg:c.termImg || '', defImg:c.defImg || '', starred:c.starred, hint:c.hint })) });
      const fname = (d.title || 'deck').replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-').slice(0,40) || 'deck';
      const save = async (ext, text) => { if (await saveFile(fname + '.' + ext, text, ext === 'csv' ? 'text/csv' : 'application/json')) toast('Saved'); };
      $('#ex-csv', m).onclick = () => save('csv', csv); $('#ex-json', m).onclick = () => save('json', json);
      $('#ex-copy', m).onclick = async () => { try { await navigator.clipboard.writeText(d.cards.map(c => plain(c.term) + '\t' + plain(c.def)).join('\n')); toast('Copied. Paste into any flashcard app.'); } catch(e){ toast('Copy was blocked by the browser.'); } };
    });
  },
  filter: el => { const d = deckById(V.id); d.opts.filter = el.dataset.v; Store.saveDeck(d); segPick(el); },
  front: el => { const d = deckById(V.id); d.opts.front = el.dataset.v; Store.saveDeck(d); segPick(el); },
  mode: el => { const d = deckById(V.id); if (!d || pool(d).length < 2) return toast('Add at least 2 complete cards first'); go(el.dataset.v, { id:V.id }); },
  star: el => { const d = deckById(V.id), c = d.cards.find(x => x.id === el.dataset.id); c.starred = !c.starred; Store.saveDeck(d); el.setAttribute('aria-pressed', c.starred); el.innerHTML = c.starred ? I.star : I.starO; el.classList.remove('popped'); void el.offsetWidth; el.classList.add('popped'); const sb = $('[data-act="filter"][data-v="starred"]'); if (sb) sb.textContent = `Starred (${d.cards.filter(x=>x.starred).length})`; placeThumbs(); },
  'speak-card': el => { if (!('speechSynthesis' in window)) return toast('Read-aloud is not supported in this browser'); const d = deckById(V.id), c = d.cards.find(x => x.id === el.dataset.id); speak(c.term, d.termLang); const t = plain(c.def).trim(); if (t){ const u = new SpeechSynthesisUtterance(t); u.lang = d.defLang; speechSynthesis.speak(u); } },
  // editor
  etab: el => { T.tab = el.dataset.v; $$('.addtab').forEach(b => b.setAttribute('aria-selected', b === el)); renderETab(); },
  'add-row': () => addRow(),
  'del-row': async el => { const row = el.closest('.erow'); T.draft.cards = T.draft.cards.filter(c => c.id !== el.dataset.id); T.dirty = true; row.classList.add('removing'); await wait(200); row.remove(); $$('#erows .erow .n').forEach((n, i) => n.textContent = i + 1); updCount(); },
  'img-add': el => { const inp = $('#img-in'); inp.value = ''; inp.onchange = () => { const c = T.draft.cards.find(x => x.id === el.dataset.id); if (c && inp.files[0]) attachImage(c, el.dataset.side, inp.files[0]); }; inp.click(); },
  'img-rm': el => { const c = T.draft.cards.find(x => x.id === el.dataset.id); if (!c) return; c[el.dataset.side + 'Img'] = ''; T.dirty = true; const row = el.closest('.erow'); $(`[data-slot="${el.dataset.side}"]`, row).innerHTML = imgSlot(c, el.dataset.side); updCount(); },
  'do-import': () => { const cards = parsePaste(); if (!cards.length) return; T.draft.cards = [...T.draft.cards.filter(c => c.term.trim() || c.def.trim() || c.termImg || c.defImg), ...cards]; T.dirty = true; toast(`${cards.length} cards added`); T.tab = 'type'; sub(); },
  'cancel-edit': () => { const leave = () => T.isNew ? go('home') : go('deck', { id:V.id }); if (T.dirty) confirmBox('Discard your changes?', "You have edits that haven't been saved.", 'Discard changes', leave, true); else leave(); },
  'save-deck': () => {
    const d = T.draft; finalizeDraft(d);
    if (!d.title.trim()){ $('#d-title').focus(); return toast('Give your deck a name'); }
    if (!d.cards.length) return toast('Add at least one card');
    const i = S.decks.findIndex(x => x.id === d.id);
    if (i >= 0) S.decks[i] = d; else S.decks.unshift(d);
    const missing = d.cards.filter(c => !complete(c)).length;
    Store.saveDeck(d); T.dirty = false;
    toast(missing ? `Saved. ${missing} ${missing===1?'card is':'cards are'} missing a side and won't be studied until you finish ${missing===1?'it':'them'}.` : T.isNew ? 'Deck created' : 'Changes saved');
    if (T.isNew) confetti(); go('deck', { id:d.id });
  },
  // flashcards
  'fc-prev': () => fcMove(-1), 'fc-next': () => fcMove(1), 'fc-sort': el => fcSort(+el.dataset.v),
  'fc-star': () => { if (V.name === 'flash') fcStar(); else { const { d, c } = T.q[0]; c.starred = !c.starred; Store.saveDeck(d); starBtns(c); } },
  'fc-speak': () => {
    if (V.name === 'flash'){ const d = deckById(V.id), x = fcFaces(d, T.cards[T.i]); speak(T.flipped ? x.b : x.f, T.flipped ? x.bLang : x.fLang); }
    else if (T.q?.[0]){ const { d, c } = T.q[0]; T.shown ? speak(A(d,c), aLang(d)) : speak(Q(d,c), qLang(d)); }
  },
  'fc-shuffle': el => { T.shuffled = !T.shuffled; el.setAttribute('aria-pressed', T.shuffled); const d = deckById(V.id), rest = T.cards.slice(T.i + 1); T.cards = [...T.cards.slice(0, T.i + 1), ...(T.shuffled ? shuffle(rest) : rest.sort((a,b) => d.cards.indexOf(a) - d.cards.indexOf(b)))]; toast(T.shuffled ? 'Shuffled' : 'Back in order'); },
  'fc-swap': el => { T.swapped = !T.swapped; el.setAttribute('aria-pressed', T.swapped); fcMount('enter'); },
  'fc-auto': el => toggleAuto(el),
  'fc-again-learning': () => { T.cards = T.cards.filter(c => T.learning.has(c.id)); T.i = 0; T.know = new Set(); T.learning = new Set(); T._pct = 0; animateView = true; render(); },
  'fc-restart': () => { T.cards = T.shuffled ? shuffle(pool(deckById(V.id))) : pool(deckById(V.id)); T.i = 0; T.know = new Set(); T.learning = new Set(); T._pct = 0; animateView = true; render(); },
  'q-star': el => { const c = T.cur?.c; if (!c) return; c.starred = !c.starred; Store.saveDeck(deckById(V.id)); el.setAttribute('aria-pressed', c.starred); el.innerHTML = c.starred ? I.star : I.starO; el.classList.remove('popped'); void el.offsetWidth; el.classList.add('popped'); toast(c.starred ? 'Starred — find it under Starred cards' : 'Unstarred'); },
  'q-speak': () => { const d = deckById(V.id), c = T.cur?.c; if (c) speak(Q(d,c), qLang(d)); },
  'next-q': () => V.name === 'learn' ? learnNext() : writeNext(),
  'l-pick': el => {
    if (T.cur.answered) return; const i = +el.dataset.i, pick = T.cur.opts[i], ok = pick.id === T.cur.c.id;
    $$('.opt').forEach((b, k) => { b.disabled = true; b.style.animationDelay = '0s'; if (T.cur.opts[k].id === T.cur.c.id) b.classList.add('right'); else if (k === i) b.classList.add('wrong'); else b.classList.add('dim'); });
    learnAnswer(ok, null); learnFeedback(ok ? 'right' : 'wrong', null);
  },
  'l-check': () => learnCheck(),
  'l-idk': () => { learnAnswer(false, ''); learnFeedback('wrong', ''); },
  'l-hint': el => { const a = plain(A(deckById(V.id), T.cur.c)), h = $('#l-hinttxt'); h.classList.remove('hidden'); h.textContent = `Starts with "${a.slice(0, Math.max(1, Math.ceil(a.length * 0.2)))}…" (${a.length} characters)`; el.disabled = true; $('#l-in').focus(); },
  'l-override': () => { const c = T.cur.c; c.st.w = Math.max(0, c.st.w - 1); c.st.c++; c.st.s++; c.lv = Math.min(2, c.lv + 1); const li = T.round.lastIndexOf(c); if (li > T.qi) T.round.splice(li, 1); T.requeued.delete(c.id); T.roundRes[T.roundRes.length-1].correct = true; Store.saveDeck(deckById(V.id)); toast('Counted as correct'); learnNext(); },
  'l-continue': () => { learnNewRound(); animateView = true; render(); },
  'l-reset': () => { const d = deckById(V.id); d.cards.forEach(c => c.lv = 0); Store.saveDeck(d); T = {}; animateView = true; render(); },
  'r-show': () => reviewReveal(),
  'r-grade': el => reviewGrade(+el.dataset.g),
  'w-check': () => writeCheck(false), 'w-skip': () => writeCheck(true),
  'w-override': () => { const r = T.res[T.res.length-1]; r.ok = true; r.c.st.w = Math.max(0, r.c.st.w - 1); r.c.st.c++; Store.saveDeck(deckById(V.id)); toast('Counted as correct'); writeNext(); },
  'w-missed': () => { const miss = T.res.filter(r => !r.ok).map(r => r.c); T = { init:true, active:true, cards:shuffle(miss), i:0, res:[] }; animateView = true; render(); },
  'm-start': () => matchStart(), 'm-tile': el => matchTap(+el.dataset.i),
  't-time': el => { T.timed = +el.dataset.v; segPick(el); },
  't-start': () => { if (!Object.values(T.types).some(Boolean)) return toast('Pick at least one question type'); testBuild(shuffle(pool(deckById(V.id))).slice(0, T.n)); animateView = true; render(); },
  't-pick': el => { const q = T.qs[+el.dataset.q]; q.ans = +el.dataset.k; $$(`[data-act="t-pick"][data-q="${el.dataset.q}"]`).forEach(b => b.classList.toggle('sel', +b.dataset.k === q.ans)); testLeft(); },
  't-tf': el => { const q = T.qs[+el.dataset.q]; q.ans = el.dataset.v === 'true'; $$(`[data-act="t-tf"][data-q="${el.dataset.q}"]`).forEach(b => b.classList.toggle('sel', (b.dataset.v === 'true') === q.ans)); testLeft(); },
  't-submit': () => { const n = T.qs.filter(q => !answered(q)).length; if (n) confirmBox('Submit with blanks?', `${n} ${n===1?'question is':'questions are'} unanswered and will count as wrong.`, 'Submit anyway', testSubmit); else testSubmit(); },
  't-missed': () => { testBuild(T.qs.filter(q => !q.ok).map(q => q.c)); animateView = true; render(); window.scrollTo({ top:0 }); },
  't-new': () => { clearInterval(T.clock); T.phase = 'setup'; animateView = true; render(); },
  'b-start': () => blitzStart(),
};
function segPick(el){ const s = el.closest('[data-seg]'); $$('button', s).forEach(b => b.setAttribute('aria-pressed', b === el)); placeThumbs(); }
document.addEventListener('click', e => {
  const inMenu = e.target.closest('.menu');
  if (!e.target.closest('.menu-wrap')) closeMenu();
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  if (el.dataset.act === 'modal-bg'){ fn(el, e); return; }
  e.preventDefault(); if (inMenu) closeMenu(); fn(el, e);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    if ($('.menu')) return closeMenu();
    if ($('#modal-root').innerHTML) return closeModal();
    if (T.active && !e.target.matches('input, textarea')) return ACT['exit-study']();
  }
  if (e.key === '/' && !e.target.matches('input, textarea, select') && !$('#modal-root').innerHTML && !T.active){ e.preventDefault(); searchModal(); }
});
document.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0]; if (!f) return; e.preventDefault();
  if (f.type.startsWith('image/')) return toast(V.name === 'edit' ? 'Drop the image onto a term or definition box.' : 'Open a deck in the editor to add images to cards.');
  if (V.name === 'edit') return toast('To import a file here, use "Paste a list" then "Choose a file".');
  if (T.active) return;
  importFile(f);
});
addEventListener('scroll', () => $('#bar').classList.toggle('scrolled', scrollY > 4), { passive:true });
addEventListener('resize', () => placeThumbs());

/* ---------------- boot ---------------- */
// Hearth sends your decks once it has decrypted them, then any changes made on your other devices.
function hbInit(){
  return new Promise(res => {
    addEventListener('message', e => {
      const m = e.data;
      if (e.source !== parent || !m || m.recall !== 1) return;
      if (m.t === 'init'){ HB.theme = m.theme === 'light' ? 'light' : m.theme === 'dark' ? 'dark' : null; res(m.state || null); }
      else if (m.t === 'remote') hbRemote(m);
      else if (m.t === 'theme'){ HB.theme = m.theme === 'light' ? 'light' : 'dark'; applyTheme(); }
    });
    hbSend('ready', {});
  });
}
function hbRemote(m){
  const byId = new Map(S.decks.map(d => [d.id, d]));
  (Array.isArray(m.decks) ? m.decks : []).forEach(x => { const d = cleanDeck(x); if (!d) return; const cur = byId.get(d.id); if (!cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(d.id, d); });
  (Array.isArray(m.removed) ? m.removed : []).forEach(id => byId.delete(id));
  S.decks = [...byId.values()].sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (m.profile && (m.profile.updatedAt || 0) > (S.profile.updatedAt || 0)) S.profile = cleanProfile(m.profile);
  applyTheme();
  if (T.active || V.name === 'edit') return; // don't pull the rug out mid-session; it shows next time
  if (V.id && V.id !== '__combo' && !S.decks.some(d => d.id === V.id)) V = { name:'home' };
  animateView = false; render();
}

(async function boot(){
  let saved = null;
  if (HB){
    saved = cleanState(await hbInit());
    S = saved; clearSeeds();
    $$('[data-icon]').forEach(b => b.innerHTML = I[b.dataset.icon]);
    applyTheme(); render();
    return;
  }
  try { await IDB.open(); } catch(e){ IDB.db = null; }
  if (window.recallDesktop){ try { const r = window.recallDesktop.load(); if (r) saved = JSON.parse(r); } catch(e){} }
  if (!saved && IDB.db){ try { const r = await IDB.get('state'); if (r) saved = typeof r === 'string' ? JSON.parse(r) : r; } catch(e){} }
  if (!saved){ try { const r = localStorage.getItem(LS_KEY); if (r) saved = JSON.parse(r); } catch(e){} }
  if (saved && Array.isArray(saved.decks)){
    S = { decks:saved.decks, profile:{ ...defaultProfile(), ...saved.profile } };
    if (!Array.isArray(S.profile.courses)) S.profile.courses = [];
    if (clearSeeds().length) Store.saveProfile();
    Store.saveLocal();
  }
  $$('[data-icon]').forEach(b => b.innerHTML = I[b.dataset.icon]);
  applyTheme(); render();
  try { navigator.storage?.persist?.(); } catch(e){}
  if (window.claude && window.claude.use){
    Store.initCloud();
    claude.use('downloads').then(dl => { DOWNLOADS = dl; }).catch(()=>{});
  }
})();
