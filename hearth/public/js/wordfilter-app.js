// Word filter in the app (README "Word filter"). server/wordfilter.js keeps the lists; wordfilter.js does the
// matching. Two lists apply to what you read:
//   - yours: end-to-end encrypted with your personal vault key and synced to your devices. It applies everywhere:
//     server channels, voice channel chats, threads, DMs and group chats;
//   - a server's suggested list, set by people with Manage Server: plain text every member can see, applied in that
//     server only, unless you turn it off for yourself (which servers you turned off is in your encrypted list too).
// A message that matches is hidden behind a "Show" row, or blurred like a spoiler, as the list says (hiding wins
// when both match). Your own messages never are. The same check covers what the app shows of a message elsewhere:
// reply quotes, search results, notification and conversation previews, pins, saved messages and thread cards.
// The server never learns what matched: the lists come whole, matching and "Show" stay on this device, and a hidden
// message still loads what it would have shown (app.js), so even its downloads look the same.
// Your list carries a number that goes up with every save, sealed inside it. This device remembers the highest it has
// opened (and that sealed copy), so a server that hands back an older copy, or none, can't quietly switch your filter
// off: the app keeps using its own copy and says so under Privacy & safety.
import { h, clear, icon, toast } from './util.js';
import { api } from './api.js';
import * as E2EE from './e2ee.js';
import { compile, parseList, readings, LIMITS, ACTIONS, TOO_COSTLY, textOfMessage } from './wordfilter.js';

const PAD = 8192; // the sealed list is padded to a multiple of this, so its size says little about how long it is
const OFF_MAX = 500; // servers whose suggested list you turned off, at most
const EMPTY = Object.freeze({ words: [], action: 'hide', off: [] });
const enc = new TextEncoder();
const HOW = '“cat” catches Cat and CAT but not category. A * stands for any letters inside a word: “cat*” also catches category, “*cat” catches bobcat. Chinese, Japanese and Thai entries match inside longer runs of text. Accents, look-alike letters, formatting, invisible characters, spaced-out (c a t) and stretched letters (caaat) don’t get around it, but a letter written just twice is another word (“god” doesn’t catch “good”, so “caat” isn’t cat): add that spelling if it matters.';

// Words for a result of check(): on the folded row or blurred message, and in previews.
export const filterLabel = (r) => `${r.action === 'blur' ? 'Blurred' : 'Hidden'} by ${r.by === 'server' ? 'this server’s' : 'your'} word filter`;
export const previewLabel = (r) => `Hidden by ${r.by === 'server' ? 'this server’s' : 'your'} word filter`;

// This device's copy of your sealed list: { n, data } in its own storage, per account (the sealed text, nothing
// readable).
const localCopy = (key) => ({
  get() { try { const v = JSON.parse(localStorage.getItem(key()) || 'null'); return v && Number.isSafeInteger(v.n) && typeof v.data === 'string' ? v : null; } catch { return null; } },
  set(v) { try { localStorage.setItem(key(), JSON.stringify(v)); } catch { /* storage full or off: only the check is lost */ } },
});

// S: the app's state; vaultKey(): your personal vault key; serverOf(m): a message's server (null in DMs);
// onChange(): a list changed, so whatever is on screen should be drawn again; store: where this device keeps its
// copy of your sealed list (tests pass their own).
export function createWordFilter({ S, vaultKey, serverOf, onChange = () => {}, store = localCopy(() => `hearth.wordFilter.${S.me && S.me.id}`) }) {
  let mine = { ...EMPTY };
  let at = 0; // the saved list's version (the server's updatedAt)
  let seq = 0; // the number sealed inside the list in use (see the top of the file)
  let unreadable = false; // a saved list this device couldn't open
  let behind = false; // the server's copy is older than one this device has opened, so this device's is used
  let section = null; // Privacy & safety's word filter part, while it's open: { root, refresh }
  let saving = 0; // saves on their way
  let missed = null; // a change announced while one was (it may be this device's own)
  let personal = compile([]);
  const servers = new Map(); // server id -> { at, m }
  let version = 0;
  let cache = new WeakMap(); // a message's decrypted payload -> { key, r }
  const shown = new Set(); // messages the reader chose to see anyway (until the page reloads)

  const changed = () => { version++; cache = new WeakMap(); onChange(); };
  const clean = (o) => {
    const v = o && typeof o === 'object' ? o : {};
    return {
      words: parseList(Array.isArray(v.words) ? v.words.filter((w) => typeof w === 'string') : []).entries,
      action: ACTIONS.includes(v.action) ? v.action : 'hide',
      off: Array.isArray(v.off) ? [...new Set(v.off.filter((x) => typeof x === 'string' && x.length <= 64))].slice(-OFF_MAX) : [],
    };
  };
  const set = (next, quiet = false) => {
    mine = next;
    personal = compile(next.words);
    if (quiet) { version++; cache = new WeakMap(); } else changed();
  };

  const open = async (data) => {
    const body = await E2EE.openVault(await vaultKey(), 'wordfilter', S.me.id, data);
    return { list: clean(body), n: Number.isSafeInteger(body && body.n) && body.n > 0 ? body.n : 0 };
  };
  // The saved list: what GET /me/word-filter answered. quiet: at start-up, before anything is drawn.
  async function apply(r, { quiet = false } = {}) {
    at = (r && r.updatedAt) || 0;
    unreadable = false;
    behind = false;
    let next = { ...EMPTY };
    let n = 0;
    if (r && r.data) {
      try { ({ list: next, n } = await open(r.data)); } catch { unreadable = true; }
    }
    // Older than (or missing next to) a copy this device has opened: the server rolled it back or dropped it. Keep
    // using this device's copy; saving puts it back.
    const local = store.get();
    if (local && local.n > n) {
      try {
        const kept = await open(local.data);
        if (kept.n === local.n) { next = kept.list; n = kept.n; behind = true; unreadable = false; }
      } catch { /* sealed with a key this account no longer has: nothing to compare with */ }
    } else if (r && r.data && !unreadable && n) store.set({ n, data: r.data });
    seq = n;
    set(next, quiet);
    if (!quiet && section && section.root.isConnected) section.refresh();
  }
  const load = async () => apply(await api('GET', '/me/word-filter'));

  // Sealed with your vault key and bound to your account (as additional data), numbered, padded, then saved. base:
  // the version the change was made to (an open editor's, else the latest this device has); if another device saved
  // since, the server refuses and the newer list is loaded.
  async function save(changes, { base = at } = {}) {
    const next = clean({ ...mine, ...changes });
    // Servers you've left don't need remembering.
    next.off = next.off.filter((id) => S.servers.some((s) => s.id === id));
    const local = store.get();
    const n = Math.max(seq, local ? local.n : 0) + 1;
    const body = { v: 1, n, words: next.words, action: next.action, off: next.off, pad: '' };
    const size = enc.encode(JSON.stringify(body)).length;
    body.pad = ' '.repeat((PAD - (size % PAD)) % PAD);
    const data = await E2EE.sealVault(await vaultKey(), 'wordfilter', S.me.id, body);
    saving++;
    try {
      const r = await api('PUT', '/me/word-filter', { data, base });
      at = r.updatedAt;
      store.set({ n, data });
      seq = n;
      unreadable = false;
      behind = false;
      set(next);
    } catch (e) {
      if (e.code === 'stale') await load().catch(() => {});
      throw e;
    } finally {
      // The news of a save can come before its answer: only a version other than the one now in use is loaded.
      if (--saving === 0 && missed) { const p = missed; missed = null; if (p.updatedAt !== at) load().catch(() => {}); }
    }
  }

  // A server's list, compiled once per version of it.
  function serverMatcher(server) {
    const wf = server && server.kind !== 'group' ? server.wordFilter : null;
    if (!wf || !Array.isArray(wf.words) || !wf.words.length) return null;
    let e = servers.get(server.id);
    if (!e || e.at !== wf.updatedAt) { e = { at: wf.updatedAt, m: compile(wf.words) }; servers.set(server.id, e); }
    return e.m;
  }
  // m: a message, or { authorId, dec, serverId, dmId } for a quote. null when nothing applies, else
  // { action: 'hide' | 'blur', by: 'you' | 'server' }.
  function check(m) {
    if (!m || !m.dec || m.dec.error || m.dec.pending || m.dec.forged || !S.me || m.authorId === S.me.id) return null;
    const server = m.dmId ? null : serverOf(m);
    const sm = server && !mine.off.includes(server.id) ? serverMatcher(server) : null;
    if (!personal.size && !sm) return null;
    const key = `${version}|${sm ? server.id + ':' + server.wordFilter.updatedAt : ''}`;
    const hit = cache.get(m.dec);
    if (hit && hit.key === key) return hit.r;
    // As typed and as shown (formatting applied), so c**at** is cat too.
    const text = readings(textOfMessage(m.dec));
    let r = null;
    if (personal.size && personal.test(text)) r = { action: mine.action, by: 'you' };
    if (sm && (!r || r.action !== 'hide') && sm.test(text)) {
      const action = server.wordFilter.action === 'blur' ? 'blur' : 'hide';
      if (!r || action === 'hide') r = { action, by: 'server' };
    }
    cache.set(m.dec, { key, r });
    return r;
  }

  function listen(socket) {
    // Saved on another device (this one's own save comes back with the version it already has).
    socket.on('wordfilter:changed', (p = {}) => {
      if (saving) { missed = p; return; }
      if (p.updatedAt !== at) load().catch(() => {});
    });
    socket.on('server:wordfilter', (p = {}) => {
      const s = S.servers.find((x) => x.id === p.serverId);
      if (!s) return;
      s.wordFilter = p.wordFilter && Array.isArray(p.wordFilter.words) ? p.wordFilter : null;
      changed();
    });
  }

  // ------------------------------------------------------------------ settings
  // The list editor both settings pages use: a box with one entry per line, what's wrong with any of them (as you
  // type), how many there are, and a "Try it" box that runs the list as typed. Returns its parts.
  function editor({ words, label, actionOf }) {
    const ta = h('textarea', { class: 'input wf-list', rows: '6', spellcheck: 'false', autocomplete: 'off', placeholder: 'One word or phrase per line', 'aria-label': label });
    ta.value = words.join('\n');
    const problems = h('ul', { class: 'wf-errors', 'aria-live': 'polite' });
    const count = h('span', { class: 'field-hint wf-count' });
    const tryIn = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: 'Type a message to try the list', 'aria-label': `Try ${label.toLowerCase()}` });
    const tryOut = h('p', { class: 'wf-try-out', 'aria-live': 'polite' });
    let parsed = parseList(ta.value);
    let matcher = compile(parsed.entries);
    const tryIt = () => {
      const text = tryIn.value;
      tryOut.classList.remove('hit');
      if (!text.trim()) { tryOut.textContent = ''; return; }
      const hit = matcher.find(readings(text));
      const done = actionOf() === 'blur' ? 'Blurred' : 'Hidden';
      tryOut.textContent = hit === TOO_COSTLY ? `${done}: it would take too long to check against this list, so it counts as a match.`
        : hit ? `${done}: it matches “${hit}”.` : 'Not filtered: nothing on the list matches.';
      tryOut.classList.toggle('hit', !!hit);
    };
    const refresh = () => {
      parsed = parseList(ta.value);
      matcher = compile(parsed.entries);
      clear(problems).append(...parsed.errors.slice(0, 8).map((e) => h('li', null, e.entry ? `“${e.entry}”: ${e.error}` : e.error)),
        parsed.errors.length > 8 ? h('li', null, `…and ${parsed.errors.length - 8} more.`) : null);
      ta.setAttribute('aria-invalid', parsed.errors.length ? 'true' : 'false');
      count.textContent = `${parsed.entries.length} of ${LIMITS.entries} entries`;
      tryIt();
    };
    ta.addEventListener('input', refresh);
    tryIn.addEventListener('input', tryIt);
    refresh();
    const tryBox = h('div', { class: 'field wf-try' }, h('span', { class: 'field-label' }, 'Try it'), tryIn, tryOut);
    const drawn = ta.value;
    return { ta, problems, count, tryBox, tryIt, parsed: () => parsed, edited: () => ta.value !== drawn };
  }
  const chips = (value, onPick, disabled = false) => {
    const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'When a message matches' });
    const draw = (cur) => clear(wrap).append(...ACTIONS.map((v) => h('button', {
      type: 'button', class: `chip${v === cur ? ' active' : ''}`, role: 'radio', 'aria-checked': String(v === cur), disabled,
      onclick: () => { draw(v); onPick(v); },
    }, v === 'hide' ? 'Hide them' : 'Blur them')));
    draw(value);
    return wrap;
  };
  const switchRow = (labelText, hint, checked, onToggle) => {
    const input = h('input', { type: 'checkbox', checked, onchange: (e) => onToggle(e.target.checked, e.target) });
    return h('label', { class: 'toggle-row' },
      h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, labelText), hint ? h('span', { class: 'field-hint' }, hint) : null),
      h('span', { class: 'switch' }, input, h('span', { class: 'switch-track' })));
  };

  // Settings → Privacy & safety: your own list, and the lists your servers suggest.
  function settingsSection() {
    const root = h('section', { class: 'set-section wf-set', id: 'word-filter' });
    let ed = null;
    let elsewhere = null; // the note shown when another device saved while you were typing here
    // focus: what to put the keyboard back on after drawing it again ('save', or nothing).
    const draw = ({ focus = null } = {}) => {
      clear(root);
      let action = mine.action;
      // Saved against the list as drawn here: if another device saved since, the server refuses (and this redraws).
      const base = at;
      ed = editor({ words: mine.words, label: 'Your word filter', actionOf: () => action });
      const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const p = ed.parsed();
        if (p.errors.length) { toast('Fix the entries listed under the box first.', 'error'); ed.ta.focus(); return; }
        saveBtn.disabled = true;
        try { await save({ words: p.entries }, { base }); toast(p.entries.length ? 'Word filter saved.' : 'Word filter cleared.'); draw({ focus: 'save' }); } catch (e) {
          toast(e.message, 'error');
          if (e.code === 'stale') draw({ focus: 'save' });
        } finally { saveBtn.disabled = false; }
      } }, 'Save word filter');
      const pick = chips(action, async (v) => {
        const was = action;
        action = v;
        ed.tryIt();
        try { await save({ action: v }); toast('Saved.'); } catch (e) { action = was; toast(e.message, 'error'); draw(); }
      });
      elsewhere = h('p', { class: 'wf-note', hidden: true, role: 'status' }, icon('info'),
        h('span', null, 'Your word filter was just changed on another device. ',
          h('button', { class: 'link-btn', type: 'button', onclick: () => draw({ focus: 'list' }) }, 'Show the new list'),
          ' (what you typed here goes), or save yours: it will be refused and the new list shown.'));
      root.append(
        h('h3', { class: 'set-h' }, 'Word filter'),
        h('p', { class: 'set-sub' }, 'Hide or blur messages with words you’d rather not see. Your list is end-to-end encrypted and synced to your devices: the server can’t read it, and never learns what it hides. It only changes what you see. It doesn’t stop anyone from writing these words, and your own messages are never filtered.'),
        unreadable ? h('p', { class: 'wf-note bad' }, icon('lock'), 'Your saved word filter couldn’t be opened on this device (it was saved with a key this account no longer has). Saving starts a new one.') : null,
        behind ? h('p', { class: 'wf-note bad' }, icon('shield'),
          h('span', null, 'The server sent an older copy of your word filter than this device has already seen (or none at all), so this device keeps using its own. ',
            h('button', { class: 'link-btn', type: 'button', onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { await save({}); toast('Your word filter is saved again.'); draw({ focus: 'save' }); } catch (err) { toast(err.message, 'error'); draw(); }
            } }, 'Save this device’s copy again'))) : null,
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Your list'), ed.ta,
          h('span', { class: 'field-hint' }, `${HOW} Up to ${LIMITS.entries} entries of ${LIMITS.length} characters.`), ed.count, ed.problems),
        elsewhere,
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'When a message matches'), pick,
          h('span', { class: 'field-hint' }, 'Hidden messages leave a row you can click to show them; blurred ones show once you click them. Everywhere else (previews, notifications, search) they say they’re hidden.')),
        h('div', { class: 'row gap' }, saveBtn),
        ed.tryBox,
        serverLists(),
      );
      // Drawn again after a save: the keyboard goes back where it was rather than to the top of the page.
      if (focus === 'save') saveBtn.focus();
      else if (focus === 'list') ed.ta.focus();
    };
    // Servers you're in that suggest a list: each one's words (behind a click, they're the words people would rather
    // not see) and a switch to use it or not. Each entry is set apart (<bdi>), so one written right to left can't
    // turn the ones after it around.
    const serverLists = () => {
      const list = S.servers.filter((s) => s.kind !== 'group' && s.wordFilter && Array.isArray(s.wordFilter.words) && s.wordFilter.words.length);
      return h('div', { class: 'wf-servers' },
        h('h4', { class: 'set-h small' }, 'Servers’ suggested lists'),
        h('p', { class: 'field-hint' }, 'People who manage a server can suggest a list for it. It isn’t secret: everyone in the server can see it. Your app applies it in that server’s channels and threads (never in your DMs) unless you turn it off here. Which ones you turn off is saved in your encrypted list, so the server doesn’t know that either.'),
        list.length ? list.map((s) => h('div', { class: 'wf-server' },
          switchRow(`Use ${s.name}’s list`, `${s.wordFilter.words.length} ${s.wordFilter.words.length === 1 ? 'entry' : 'entries'} · ${s.wordFilter.action === 'blur' ? 'blurs' : 'hides'} matching messages`,
            !mine.off.includes(s.id), async (on, input) => {
              try { await save({ off: on ? mine.off.filter((x) => x !== s.id) : [...mine.off, s.id] }); toast(on ? `Using ${s.name}’s word filter.` : `${s.name}’s word filter is off for you.`); } catch (e) { input.checked = !on; toast(e.message, 'error'); }
            }),
          h('details', { class: 'wf-words' }, h('summary', null, 'Show the list'), h('p', { class: 'wf-word-list' }, wordList(s.wordFilter.words)))))
          : h('p', { class: 'field-hint' }, 'None of your servers suggests a word filter.'));
    };
    draw();
    // A newer list came (saved on another device): drawn again if nothing was typed here, else a note says so.
    section = { root, refresh: () => {
      if (ed && ed.edited()) { if (elsewhere) elsewhere.hidden = false; return; }
      draw({ focus: root.contains(document.activeElement) ? 'list' : null });
    } };
    return root;
  }
  const wordList = (words) => words.flatMap((w, i) => [i ? ', ' : null, h('bdi', null, w)]).filter(Boolean);

  // Server settings → Word filter (Manage Server): the server's suggested list.
  function serverTab(s, body) {
    const wf = s.wordFilter || { words: [], action: 'hide' };
    let action = wf.action === 'blur' ? 'blur' : 'hide';
    const ed = editor({ words: wf.words || [], label: 'This server’s word filter', actionOf: () => action });
    const submit = async (words) => {
      const r = await api('PUT', `/servers/${s.id}/word-filter`, { words, action });
      // The live update (server:wordfilter) does the same; this way it's right at once.
      s.wordFilter = r.words && r.words.length ? r : null;
      changed();
      return r;
    };
    const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const p = ed.parsed();
      if (p.errors.length) { toast('Fix the entries listed under the box first.', 'error'); ed.ta.focus(); return; }
      saveBtn.disabled = true;
      try { await submit(p.entries); toast(p.entries.length ? 'Word filter saved.' : 'Word filter cleared.'); } catch (e) { toast(e.message, 'error'); } finally { saveBtn.disabled = false; }
    } }, 'Save word filter');
    const off = mine.off.includes(s.id);
    body.append(
      h('h3', null, 'Word filter'),
      h('p', { class: 'muted-p' }, 'Suggest words for members’ apps to hide or blur in this server: in its channels, voice channel chats and threads. Messages are end-to-end encrypted, so the server can’t check them. Each member’s app does, on their own device, and never reports back.'),
      h('div', { class: 'wf-note' }, icon('info'),
        h('span', null, 'This list isn’t secret: everyone in the server can see it (Settings → Privacy & safety). It’s a suggestion, not a rule: members can turn it off for themselves, and it doesn’t stop anyone from posting these words. Changes are listed in the audit log.')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Words and phrases'), ed.ta,
        h('span', { class: 'field-hint' }, `${HOW} Up to ${LIMITS.entries} entries of ${LIMITS.length} characters.`), ed.count, ed.problems),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'When a message matches'), chips(action, (v) => { action = v; ed.tryIt(); }),
        h('span', { class: 'field-hint' }, 'Hidden messages leave a row members can click to show them; blurred ones show once clicked.')),
      h('div', { class: 'row gap' }, saveBtn),
      ed.tryBox,
      off ? h('p', { class: 'field-hint' }, 'You turned this server’s list off for yourself (Privacy & safety), so your own app doesn’t apply it.') : null,
    );
  }

  return {
    apply, load, save, check, listen, settingsSection, serverTab,
    reveal: (id) => { shown.add(id); },
    isShown: (id) => shown.has(id),
    // For "Export my data": your list as you see it (decrypted here).
    exportable: () => ({ words: mine.words.slice(), action: mine.action, serversTurnedOff: mine.off.slice() }),
    get active() { return personal.size > 0 || S.servers.some((s) => serverMatcher(s) && !mine.off.includes(s.id)); },
  };
}
