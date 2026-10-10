// Study tools = Recall (public/recall/), a flashcard app with Learn, Smart Review, Write, Match, practice tests,
// Blitz and more, plus courses, exam dates and a focus timer.
//
// Recall runs in a sandboxed frame with an origin of its own: it can't see your Hearth sign-in, can't store
// anything in the browser and can't reach the network. This module is its storage. It decrypts your study items,
// hands them to the frame, and encrypts every change the frame sends back with a key only your devices can derive
// (E2EE.vaultKey) before syncing it, so the server only ever holds ciphertext.
//
// Items on the server (kind / id):
//   deck      r-<deck id>     one Recall deck; its pictures are replaced by "hearth-img:<id>" references
//   img       img-<sha256>    one picture (stored once, however many cards use it)
//   settings  recall-profile  Recall's profile: courses, goals, streak, theme
// Decks from the earlier Hearth study tools (kind deck, other ids) are moved into Recall the first time.
import { h, toast } from './util.js';
import { api } from './api.js';
import * as E2EE from './e2ee.js';

const PROFILE_ID = 'recall-profile';
const IMG_REF = 'hearth-img:';
const ID_RE = /^[\w-]{1,40}$/;
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const GC_AGE = 15 * 60000; // pictures nobody uses any more are removed once they're this old (another device may be mid-save)

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createRecall(ctx) {
  // ctx: { S, onEnabled() }
  const items = new Map(); // id -> { kind, obj, updatedAt }
  let key = null; let since = 0; let loading = null; let loaded = false;
  let layer = null; let frame = null; let ready = false; let slot = null; let raf = 0;
  const $ = (sel) => document.querySelector(sel);
  const pending = new Map(); // item id -> timer
  const saved = new Map(); // item id -> JSON last uploaded (skip saves that change nothing)
  let warnedBig = false;

  // ------------------------------------------------------------------ encrypted sync
  async function vkey() { if (!key) key = await E2EE.vaultKey(ctx.S.privateKey, ctx.S.me.publicKey); return key; }
  // Pull everything changed since last time. Returns the ids that changed (deleted ones included).
  // The server answers a page at a time (`more` = there's another), and everything has to be in before the first
  // load counts as done: tidying up (migrate, unused pictures) on half a list would overwrite or delete the rest.
  function sync() {
    if (loading) return loading;
    loading = (async () => {
      const k = await vkey();
      const changed = [];
      for (let more = true; more;) {
        let r;
        try { r = await api('GET', `/me/study?since=${since}&paged=1`); } catch (e) {
          if (!loaded) throw e;
          break; // later pages come with the next sync
        }
        for (const it of r.items) {
          since = Math.max(since, it.updatedAt);
          if (it.deleted) { if (items.delete(it.id)) changed.push(it.id); continue; }
          try {
            const obj = await E2EE.openVault(k, it.kind, it.id, it.data);
            items.set(it.id, { kind: it.kind, obj, updatedAt: it.updatedAt });
            saved.set(it.id, JSON.stringify(obj));
            changed.push(it.id);
          } catch { /* unreadable (made before a reset with new keys) */ }
        }
        more = !!r.more && r.items.length > 0;
      }
      loaded = true;
      return changed;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function put(kind, id, obj) {
    const json = JSON.stringify(obj);
    if (saved.get(id) === json) return;
    const data = await E2EE.sealVault(await vkey(), kind, id, obj);
    const r = await api('PUT', `/me/study/${id}`, { kind, data });
    items.set(id, { kind, obj, updatedAt: r.updatedAt });
    saved.set(id, json);
  }
  async function del(id) {
    items.delete(id); saved.delete(id);
    await api('DELETE', `/me/study/${id}`).catch(() => {});
  }
  const deckItemId = (deckId) => 'r-' + deckId;

  // Pictures travel as their own items so a deck full of them still fits; the deck keeps a reference.
  async function storeImages(deck) {
    const out = { ...deck, cards: [] };
    for (const c of deck.cards || []) {
      const card = { ...c };
      for (const side of ['termImg', 'defImg']) {
        const src = card[side];
        if (typeof src !== 'string' || !DATA_IMG.test(src)) { card[side] = ''; continue; }
        const id = 'img-' + (await sha256Hex(src)).slice(0, 40);
        if (!items.has(id)) await put('img', id, { data: src });
        card[side] = IMG_REF + id;
      }
      out.cards.push(card);
    }
    return out;
  }
  function withImages(deck) {
    const img = (ref) => {
      if (typeof ref !== 'string' || !ref.startsWith(IMG_REF)) return '';
      const it = items.get(ref.slice(IMG_REF.length));
      return it && it.kind === 'img' && typeof it.obj.data === 'string' ? it.obj.data : '';
    };
    return { ...deck, cards: (deck.cards || []).map((c) => ({ ...c, termImg: img(c.termImg), defImg: img(c.defImg) })) };
  }
  // Remove pictures no deck uses any more.
  async function collectImages() {
    const used = new Set();
    for (const [, it] of items) {
      if (it.kind !== 'deck') continue;
      for (const c of it.obj.cards || []) for (const s of [c.termImg, c.defImg]) if (typeof s === 'string' && s.startsWith(IMG_REF)) used.add(s.slice(IMG_REF.length));
    }
    const old = Date.now() - GC_AGE;
    for (const [id, it] of [...items]) if (it.kind === 'img' && !used.has(id) && it.updatedAt < old) await del(id);
  }

  function recallDecks() {
    return [...items].filter(([id, it]) => it.kind === 'deck' && id.startsWith('r-')).map(([, it]) => withImages(it.obj));
  }

  // The first time: bring decks made with the earlier Hearth study tools into Recall.
  async function migrate() {
    if (items.has(PROFILE_ID)) return;
    const old = [...items].filter(([id, it]) => it.kind === 'deck' && !id.startsWith('r-'));
    const now = Date.now();
    for (const [oldId, it] of old) {
      const d = it.obj || {};
      const id = ('h' + oldId.replace(/[^\w-]/g, '')).slice(0, 36);
      const deck = {
        id, title: String(d.name || 'Flashcards').slice(0, 200), desc: '', course: '', examDate: '', termLang: 'en-US', defLang: 'en-US',
        createdAt: now, updatedAt: now, opts: {},
        cards: (d.cards || []).filter((c) => c && (c.front || c.back)).map((c, i) => ({
          id: ID_RE.test(c.id || '') ? c.id : `${id}-${i}`, term: String(c.front || ''), def: String(c.back || ''), termImg: '', defImg: '', starred: false, hint: '', lv: 0,
          st: { c: 0, w: 0, s: 0 },
          srs: { state: c.reps ? 'review' : 'new', ease: +c.ease || 2.5, ivl: +c.interval || 0, due: +c.due || 0, reps: +c.reps || 0, lapses: +c.lapses || 0 },
        })),
      };
      try { await put('deck', deckItemId(id), deck); await del(oldId); } catch { /* try again next time */ }
    }
    await put('settings', PROFILE_ID, { updatedAt: 0 }).catch(() => {});
    if (old.length) toast(`Moved ${old.length} flashcard ${old.length === 1 ? 'deck' : 'decks'} into Recall.`);
  }

  // ------------------------------------------------------------------ talking to the frame
  const post = (msg) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage({ recall: 1, ...msg }, '*'); };
  const hearthTheme = () => {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!m) return 'dark';
    const [r, g, b] = m.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? 'light' : 'dark';
  };
  function queue(id, fn, ms = 900) {
    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(() => { pending.delete(id); fn().catch((e) => {
      if (/too big|full|413/i.test(e.message || '') && !warnedBig) { warnedBig = true; toast(e.message, 'error'); }
    }); }, ms));
  }
  let gcTimer = null;
  async function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.recall !== 1 || typeof m.t !== 'string') return;
    if (m.t === 'ready') {
      ready = true;
      try {
        if (!loaded) await sync();
        await migrate();
        const p = items.get(PROFILE_ID);
        post({ t: 'init', theme: hearthTheme(), state: { decks: recallDecks(), profile: p && p.obj.updatedAt ? p.obj : null } });
      } catch (err) { toast(`Couldn't open your study decks: ${err.message}`, 'error'); }
    } else if (m.t === 'deck' && m.deck && typeof m.deck.id === 'string' && ID_RE.test(m.deck.id)) {
      const deck = m.deck; const id = deckItemId(deck.id);
      queue(id, async () => { await put('deck', id, await storeImages(deck)); clearTimeout(gcTimer); gcTimer = setTimeout(() => collectImages().catch(() => {}), 30000); });
    } else if (m.t === 'profile' && m.profile && typeof m.profile === 'object') {
      const profile = m.profile;
      queue(PROFILE_ID, () => put('settings', PROFILE_ID, profile));
    } else if (m.t === 'remove' && typeof m.id === 'string' && ID_RE.test(m.id)) {
      const id = deckItemId(m.id);
      clearTimeout(pending.get(id)); pending.delete(id);
      await del(id);
    } else if (m.t === 'file' && typeof m.text === 'string' && m.text.length < 80 * 1024 * 1024) {
      // Backups and exports: saved by Hearth, since the sandboxed frame can't download on every platform.
      const type = ['text/csv', 'application/json', 'text/plain'].includes(m.type) ? m.type : 'text/plain';
      const name = String(m.name || 'recall.txt').replace(/[^\w .()-]+/g, '_').slice(0, 120) || 'recall.txt';
      const url = URL.createObjectURL(new Blob([m.text], { type }));
      const a = h('a', { href: url, download: name, hidden: true });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  addEventListener('message', (e) => { onMessage(e); });

  // Another device saved something: pass the decks that changed on to Recall.
  async function onRemoteChange() {
    if (!loaded) return;
    const changed = await sync();
    if (!ready || !changed.length) return;
    const decks = []; const removed = []; let profile = null;
    for (const id of changed) {
      if (id === PROFILE_ID) { const p = items.get(id); if (p) profile = p.obj; continue; }
      if (!id.startsWith('r-')) continue;
      const it = items.get(id);
      if (it) decks.push(withImages(it.obj)); else removed.push(id.slice(2));
    }
    if (decks.length || removed.length || profile) post({ t: 'remote', decks, removed, profile });
  }

  // ------------------------------------------------------------------ the frame on screen
  // The frame lives for the whole session (so a focus timer or a study round keeps going while you chat) and is
  // laid over the Study page's space while it's open.
  function ensureFrame() {
    if (layer) return;
    frame = h('iframe', {
      src: '/recall/', title: 'Recall study tools', class: 'recall-frame',
      sandbox: 'allow-scripts allow-modals allow-downloads',
      referrerpolicy: 'no-referrer',
    });
    layer = h('div', { class: 'recall-layer', hidden: true }, frame);
    ($('#app') || document.body).append(layer);
  }
  function place() {
    raf = 0;
    if (!slot || !slot.isConnected) { if (layer) layer.hidden = true; slot = null; return; }
    const r = slot.getBoundingClientRect();
    Object.assign(layer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    layer.hidden = r.width < 2 || r.height < 2;
    raf = requestAnimationFrame(place);
  }
  function view() {
    ensureFrame();
    slot = h('div', { class: 'recall-slot' });
    const main = $('#main');
    if (main) { const r = getComputedStyle(main).borderBottomLeftRadius; layer.style.borderRadius = `0 0 ${r} ${r}`; }
    if (!raf) raf = requestAnimationFrame(place);
    // Hearth's light/dark may have changed since the frame opened.
    if (ready) post({ t: 'theme', theme: hearthTheme() });
    return slot;
  }

  // ------------------------------------------------------------------ settings
  function settingsSection({ section, toggle }) {
    const host = h('div', { class: 'stack' });
    const draw = () => {
      host.replaceChildren(section(null, toggle('Show study tools', !!ctx.S.me.studyEnabled, async (v) => {
        const r = await api('PATCH', '/me/study-settings', { enabled: v }); ctx.S.me.studyEnabled = r.enabled; ctx.onEnabled(); draw();
      }, 'Adds Study (Recall) under More in your sidebar: flashcards with Learn, Smart Review, Write, Match, practice tests and games, courses with exam dates, and a focus timer. Your decks are end-to-end encrypted and follow you to every device.')));
    };
    draw();
    return host;
  }

  return { view, settingsSection, onRemoteChange: () => onRemoteChange().catch(() => {}) };
}
