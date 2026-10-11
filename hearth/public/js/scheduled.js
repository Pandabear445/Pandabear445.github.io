// Scheduled messages, "Send later" (server/scheduled.js has the rules). The composer encrypts a message exactly as
// it would to send it now and hands the server that ciphertext and a time, with your own copy of it (`draft`, sealed
// with your personal vault key and bound to its ref, conversation and thread). This module keeps your list (synced
// across your devices by scheduled:update / scheduled:remove), draws the picker for when, the bar above the
// composer and the list per conversation (from your own copies, opened here on your device), and re-encrypts a
// message the server is holding because the conversation's key changed after you wrote it, or because your sign-in
// got a new token since (a password change, two-factor turned on, other devices signed out: a copy of the old token
// could have scheduled it, and only one you wrote has a copy that opens here):
//   - by itself, as soon as it can, when its time is still ahead or passed less than 10 minutes ago (it then goes
//     out at once), and only when it's sure this is that scheduled message (see below);
//   - later than that, only when you say so (Send now or a new time): a message sent days late might not be one
//     you still want to send. Saving an edit of one like that asks too;
//   - never one scheduled from a session that has been signed out since: that waits for you (Keep, Send now…).
// The time it goes out is inside it (binding.js ts, so readers' apps can tell a message the server re-dated), so
// Reschedule and Send now re-encrypt it too: Send now hands the server a copy that says "now" to post at once. Only
// you change that time (scheduling it, Reschedule, Send now). Every other re-encrypt keeps the one in your own copy,
// never the time the server says it has (its sendAt): otherwise a server could mark one held and "due", get this app
// to re-encrypt it saying "now", and post it early with nothing to show for it. One the server has down for earlier
// than your copy says isn't re-encrypted by itself at all; it waits for you.
// It only ever re-encrypts from your own copy, never from the ciphertext the server hands back: the server (or
// someone with a stolen session, who has no identity key) can't make one that opens, so it can't get this app to
// re-sign a forged message, or one of your old messages under a newer key. One whose copy doesn't open here shows
// as "can't confirm you wrote this" and can only be cancelled.
// A copy that opens isn't enough to do it by itself, though: a stolen session can read your copies from the list and
// put one back as a new scheduled message after you sent or cancelled it, to have your app re-encrypt and re-sign
// those words under a new key (readable by people who joined since, and as often as it likes). So each copy is bound
// to the scheduled message it belongs to: sid inside it is that message's id (the server picks it, so the composer
// seals the copy again with it as soon as the server answers, and every re-encrypt keeps it). This app re-encrypts by
// itself only one whose copy names it, or one this device scheduled itself (its ids are kept here, for when that
// second step didn't happen). Any other copy that opens is one you confirm: it waits for you (Keep, Send now, Edit,
// Reschedule), and confirming it binds it. A copy that names another scheduled message is a copy of that one, put
// here: it shows as "can't confirm" and can only be cancelled.
// What this doesn't stop (SECURITY.md): a copy names its scheduled message, not which version of it, so a stolen
// session can put an earlier copy of the same one back (its words before you edited it), and that one is
// re-encrypted by itself after a key change.
// Everything you wrote is put on screen as text nodes, never as HTML.
import { h, clear, icon, toast, fmtTime, copyText } from './util.js';
import { api } from './api.js';
import { modal, menu, confirmDialog, showError, field } from './ui.js';
import { linkedUrls } from './markdown.js';
import { label as timerLabel } from './disappear.js';
import { bindingOf, bindScheduled } from './binding.js';

const LATE_OK = 10 * 60 * 1000; // re-encrypted by itself (and sent at once) up to this long after its time
const MAX_DAYS = 30;
const MIN = 60 * 1000;

const HERE_MAX = 100; // ids of scheduled messages this device made, kept per account (at most 25 are waiting at once)

const keyOf = (it) => (it.dmId ? 'd:' + it.dmId : 'c:' + it.channelId);
const readable = (dec) => !!dec && !dec.error;
// When it's due: the time inside your own copy (binding.js ts), which only you set. A copy from before that has only
// the server's time (and gets no time inside when it's re-encrypted, binding.js bindScheduled).
const dueOf = (it, dec) => (readable(dec) && dec.b && dec.b.ts > 0 ? dec.b.ts : it.sendAt);
const CANT_CONFIRM = 'This device can’t confirm you scheduled this message, so it won’t re-encrypt it. Cancel it if you don’t recognize it.';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "Today at 3:45 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM" within a week, else the date.
export function whenLabel(ts) {
  const d = new Date(ts);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  const t = fmtTime(ts);
  if (diff === 0) return `Today at ${t}`;
  if (diff === 1) return `Tomorrow at ${t}`;
  if (diff === -1) return `Yesterday at ${t}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} at ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })} at ${t}`;
}
// The same in the middle of a sentence: "today at 3:45 PM", "tomorrow at 9:00 AM", "Monday at 9:00 AM".
export const whenPhrase = (ts) => whenLabel(ts).replace(/^(Today|Tomorrow|Yesterday) /, (w) => w.toLowerCase());
// "at 3:45 PM", "tomorrow at 9:00 AM", "on Monday at 9:00 AM": the end of "…, the next …".
function nextPhrase(ts) {
  const w = whenLabel(ts);
  if (w.startsWith('Today ')) return w.slice(6);
  if (w.startsWith('Tomorrow ')) return 'tomorrow ' + w.slice(9);
  return 'on ' + w;
}
// The quick picks: a time at the start of a minute, so what the menu says is what you get.
const roundUp = (t) => Math.ceil(t / MIN) * MIN;
function at(daysAhead, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
export function quickPicks(now = Date.now()) {
  const picks = [['In 1 hour', roundUp(now + 60 * MIN)], ['In 3 hours', roundUp(now + 180 * MIN)]];
  const evening = at(0, 19);
  if (evening - now > 90 * MIN) picks.push(['This evening', evening]);
  picks.push(['Tomorrow morning', at(1, 9)]);
  const toMonday = (8 - new Date(now).getDay()) % 7 || 7; // days until next Monday
  if (toMonday > 1) picks.push(['Monday morning', at(toMonday, 9)]);
  return picks;
}
// "2026-10-12T09:30" for a datetime-local field, in this device's time zone.
const localInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * MIN); return d.toISOString().slice(0, 16); };

// deps (from app.js):
//   me()                       the signed-in user
//   openDraft(item)            your own copy of what it says (the payload), or throws if it doesn't open with your keys
//   sealFor(key, payload, keep) { ciphertext, epoch?, mentions?, everyone?, ttl, draft } for a message to that
//                              conversation now (ttl beside it: its disappearing timer as it is now; x inside: the
//                              stricter of that and keep.x, the timer the message was written for), with your own copy
//                              bound to keep = { ref, threadId }, and naming keep.sid inside it (the scheduled
//                              message's id)
//   withKeyRetry(serverId, fn) runs fn again once if the server says the key is out of date
//   clock()                    now, by the server's clock as this app knows it (the time a message says it went out)
//   refreshTimer(key)          fetches the conversation's disappearing timer (the server said it changed)
//   placeOf(item)              where it goes: { label, dm } ("#general · Hearth HQ", "Ana", a group's name)
//   onChange(key)              the list for that conversation changed (the composer bar redraws; the header's ⋯ menu
//                              counts them when it opens)
//   openKey(key)               show that conversation
export function createScheduled(deps) {
  const items = new Map(); // id -> item from the server
  const opened = new Map(); // id -> { draft, dec }: what each says, from your own copy, opened once per copy
  const busy = new Set(); // ids being re-encrypted
  const tried = new Map(); // id -> ciphertext an automatic re-encrypt already failed for (not tried again for it)
  // Ids sent or cancelled. One re-encrypted after its time goes out at once, and the live scheduled:remove can arrive
  // before the answer to that PATCH: the answer mustn't bring it back into the list.
  const gone = new Set();
  let view = null; // the open list: { key, draw }
  let loaded = false;

  // Ids of the scheduled messages this device made (the server's answer to the composer), kept in this browser for
  // this account: one of those whose copy doesn't name it yet (the composer couldn't seal it again) is still
  // re-encrypted by itself here. Only ever ids the server gave this device for something it scheduled: a new
  // scheduled message gets a new id, so a copy put back in one never matches.
  // Read afresh each time (another tab may have scheduled one); `here` is this tab's own, for when storage is off.
  let here = new Set();
  const hereKey = () => { const u = deps.me && deps.me(); return u && u.id ? `hearth.schedHere.${u.id}` : null; };
  function madeHere() {
    const all = new Set(here);
    try {
      const k = hereKey();
      const v = k ? JSON.parse(localStorage.getItem(k) || '[]') : [];
      if (Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string') all.add(x); });
    } catch { /* storage off: this tab's own only */ }
    return all;
  }
  function keepHere(ids) {
    here = new Set([...ids].slice(-HERE_MAX));
    try {
      const k = hereKey();
      if (!k) return;
      if (here.size) localStorage.setItem(k, JSON.stringify([...here])); else localStorage.removeItem(k);
    } catch { /* full or blocked */ }
  }
  function forgetHere(ids) {
    const all = madeHere();
    if (ids.some((id) => all.has(id))) keepHere([...all].filter((id) => !ids.includes(id)));
  }
  // Re-encrypted by itself: one whose copy names this scheduled message, or one this device made.
  const trusted = (it, dec) => readable(dec) && (dec.sid === it.id || (!dec.sid && madeHere().has(it.id)));
  // Held, and waiting for you: one from a session signed out since, or one whose copy opens but that this app can't
  // tell is still one you want sent (dec: what it says, or null while it's being opened).
  const waitsForYou = (it, dec) => it.status === 'held' && (it.reason === 'session_ended' || (!!dec && readable(dec) && !trusted(it, dec)));
  const shownDec = (it) => { const o = opened.get(it.id); return o && o.draft === it.draft ? o.dec : null; };

  const clock = () => (deps.clock ? deps.clock() : Date.now());
  const changed = (key) => { deps.onChange(key); if (view && (!view.key || view.key === key)) view.draw(); };
  function apply(it) {
    if (gone.has(it.id)) return;
    const old = items.get(it.id);
    items.set(it.id, it);
    // Told once, here, when one can't go: the push covers devices with no app open.
    if (it.status === 'failed' && old && old.status !== 'failed') toast(`A scheduled message wasn’t sent. ${it.note || ''}`.trim(), 'error');
    changed(keyOf(it));
    if (it.status === 'held') fixHeld();
  }
  function drop(id) {
    if (id) { gone.add(id); forgetHere([id]); }
    const it = items.get(id);
    if (!it) return;
    items.delete(id);
    opened.delete(id);
    changed(keyOf(it));
  }

  // ------------------------------------------------------------------ opening and re-encrypting
  // What it says, from your own copy (never from the ciphertext the server holds): { t, f, p?, l?, x?, b?, sid? }, or
  // { error: true } when the copy is missing, doesn't open with your keys, or names another scheduled message (a
  // copy of that one, put here). x is the disappearing timer it was written for (seconds), which every re-encrypt
  // keeps (see reseal); b is where it belongs (binding.js: its id, reply and thread, fixed when it was scheduled);
  // sid, the scheduled message it was sealed for (see the top of this file).
  async function open(it) {
    const o = opened.get(it.id);
    if (o && o.draft === it.draft) return o.dec;
    let dec = { error: true };
    try {
      const p = it.draft && it.ref ? await deps.openDraft(it) : null;
      if (p && typeof p === 'object' && !Array.isArray(p) && (p.sid === undefined || p.sid === it.id)) {
        dec = { t: typeof p.t === 'string' ? p.t : '', f: Array.isArray(p.f) ? p.f : [], ...(p.p && typeof p.p === 'object' ? { p: p.p } : {}), l: Array.isArray(p.l) ? p.l : [],
          ...(Number.isInteger(p.x) && p.x > 0 ? { x: p.x } : {}), ...(bindingOf(p) ? { b: bindingOf(p) } : {}),
          ...(p.sid === it.id ? { sid: it.id } : {}) };
      }
    } catch { /* doesn't open: can't confirm it's yours */ }
    opened.set(it.id, { draft: it.draft, dec });
    return dec;
  }
  // New ciphertext for it with the conversation's current keys (and new words, if given), always from your own copy.
  // The poll, files and the link previews whose links are still in the text stay, as when editing a message. So does
  // the disappearing timer it was written for: sealFor puts the stricter of that and the conversation's timer now
  // inside it, and the server keeps the same one. A timer turned off or made longer since never makes it last longer
  // than you wrote it for, so re-encrypting it (by itself after a key change, or for an edit, Keep or Send now) never
  // needs asking about the timer the way sending a message you wrote earlier does. Its id, reply and thread stay the
  // ones it was scheduled with; at is the time it says it goes out (binding.js ts): readers' apps flag one the server
  // posts more than a few minutes before that, or more than a day after. at: a time you just picked, or now for Send
  // now; anything else keeps the time in your own copy (dueOf).
  // The new copy names this scheduled message (sid), so your apps re-encrypt it by themselves from then on.
  async function sealed(it, { text, at }) {
    const dec = await open(it);
    if (!readable(dec)) throw new Error(CANT_CONFIRM);
    const t = text !== undefined ? text : dec.t || '';
    const still = linkedUrls(t, { skipSpoilers: true });
    const links = (dec.l || []).filter((x) => x && still.includes(x.url));
    const payload = { t, f: dec.f || [], ...(dec.p ? { p: dec.p } : {}), ...(links.length ? { l: links } : {}),
      ...bindScheduled(dec.b, { at: at || dueOf(it, dec) }) };
    return deps.sealFor(keyOf(it), payload, { ref: it.ref, threadId: it.threadId, x: dec.x || 0, sid: it.id });
  }
  // request(body) with a freshly sealed copy (sealed above). Checked against the conversation's disappearing timer as
  // it is now (ttl): changed meanwhile (409 disappear_changed), fetch it and encrypt again, once; the same for a key
  // that changed under it (withKeyRetry).
  async function withFresh(it, opts, request) {
    const once = async () => request(await sealed(it, opts));
    const go = async () => {
      try { return await once(); } catch (e) {
        if (!(e.status === 409 && e.code === 'disappear_changed') || !deps.refreshTimer) throw e;
        await deps.refreshTimer(keyOf(it));
        return once();
      }
    };
    return it.serverId ? deps.withKeyRetry(it.serverId, go) : go();
  }
  // Re-encrypts it in place (PATCH). sendAt: a new time you picked (it says that inside). now: you said Send now, so it
  // may go at once (the server refuses otherwise, 409 overdue) and says now inside. auto: re-encrypted by itself after
  // a key change: it may go at once too, if its time has just passed, but keeps the time in your own copy.
  async function reseal(it, { text, sendAt, now = false, auto = false } = {}) {
    const at = sendAt || (now ? clock() : null);
    const fresh = await withFresh(it, { text, at }, async (body) => api('PATCH', `/scheduled-messages/${it.id}`, {
      ...body, ...(sendAt ? { sendAt } : {}), ...(now || auto ? { sendNow: true } : {}),
    }));
    apply(fresh);
    return fresh;
  }
  // Held ones whose time is ahead (or just passed) because a key changed or the sign-in got a new token: re-encrypted
  // without asking, if this app can tell it's that very scheduled message (trusted: its copy names it, or this device
  // made it). One that can't be (no key yet, a safety number to check, a copy that doesn't open) waits for the next
  // change of keys, or for you. Never one from a session that was signed out since, nor one whose copy opens but
  // doesn't name it (it could be a copy of one you already sent or cancelled, put back): you confirm those yourself.
  // A try turned away as signed out (401) isn't held against it: the news that it's held can arrive just before this
  // tab has the new token, and it's tried again when the app reconnects with it (load).
  // "Its time" is the one in your own copy (dueOf), not the server's: one due more than 10 minutes ago by your copy
  // waits for you, and so does one the server has down for earlier than your copy says (only a server re-dating it
  // does that; slow mode and retries only ever make it later). A server that marks one held and "due" therefore gets
  // either nothing or a copy that still says when you scheduled it, which readers' apps flag if it goes out early.
  async function fixHeld({ force = false } = {}) {
    for (const it of [...items.values()]) {
      if (it.status !== 'held' || it.reason === 'session_ended' || busy.has(it.id)) continue;
      if (!force && tried.get(it.id) === it.ciphertext) continue;
      busy.add(it.id);
      try {
        const dec = await open(it);
        if (readable(dec) && !trusted(it, dec)) {
          // Waiting for you: the composer bar and the list say so.
          tried.set(it.id, it.ciphertext);
          changed(keyOf(it));
          continue;
        }
        const due = dueOf(it, dec);
        if (readable(dec) && (due < clock() - LATE_OK || it.sendAt < due)) continue;
        await reseal(it, { auto: true });
        tried.delete(it.id);
      } catch (e) { if (!e || e.status !== 401) tried.set(it.id, it.ciphertext); } finally { busy.delete(it.id); }
    }
  }

  // The time in your own copy, when it's open on this device and has one (else null).
  function ownTime(it) {
    const o = opened.get(it.id);
    return o && o.draft === it.draft && readable(o.dec) && o.dec.b && o.dec.b.ts > 0 ? o.dec.b.ts : null;
  }

  // ------------------------------------------------------------------ actions
  // Re-encrypted with the moment it really goes out (binding.js ts), so readers' apps don't take it for a message the
  // server re-dated, and handed over with "send it now": the server posts that copy, or, if it can't go now (slow mode,
  // lost permission…), says why and leaves the scheduled one exactly as it was.
  async function sendNow(it) {
    const cur = items.get(it.id) || it;
    try {
      await withFresh(cur, { at: clock() }, async (body) => api('POST', `/scheduled-messages/${cur.id}/send`, body));
      toast('Sent.');
    } catch (e) {
      // Already gone out meanwhile (its time came while it was being re-encrypted).
      if (e.status === 404 && !items.has(it.id)) toast('Sent.'); else toast(e.message, 'error');
    }
  }
  // Always re-encrypted: the time it goes out is inside it (binding.js ts).
  async function reschedule(it, sendAt) {
    try {
      await reseal(it, { sendAt });
      toast(`Rescheduled for ${whenPhrase(sendAt)}.`);
    } catch (e) { toast(e.message, 'error'); }
  }
  // Its time has passed while it was held: going on (keeping it, or saving an edit) would send it at once, so ask
  // first. then({ now: true }) or then({ sendAt }). The server decides that its time has passed (it refuses to post an
  // overdue one otherwise); when your own copy says a later time, that's said too.
  function askLate(it, then) {
    const due = ownTime(it);
    modal({
      title: 'Its time has passed', size: 'sm',
      body: h('p', { class: 'muted-p' }, `It was due ${whenPhrase(it.sendAt)}.`,
        due && due > it.sendAt + MIN ? ` (You scheduled it for ${whenPhrase(due)}: your server has an earlier time for it.)` : '',
        ' Send it now, or pick a new time?'),
      actions: [{ label: 'Cancel' },
        { label: 'Pick a new time', action: () => { customTime((t) => then({ sendAt: t }), { title: 'Pick a new time', current: null }); } },
        { label: 'Send now', kind: 'primary', action: () => { then({ now: true }); } }],
    });
  }
  // Held because the session that scheduled it was signed out: you say it should still go, as it is.
  function keep(it) {
    const go = async (opts) => {
      try {
        const fresh = await reseal(items.get(it.id) || it, opts);
        toast(opts.now ? 'Sent.' : `Kept. It goes out ${whenPhrase(fresh.sendAt)}.`);
      } catch (e) { toast(e.message, 'error'); }
    };
    if (it.sendAt <= Date.now()) askLate(it, go); else go({});
  }
  async function cancel(it) {
    const failed = it.status === 'failed';
    if (!failed && !(await confirmDialog({ title: 'Cancel this scheduled message?', text: 'It won’t be sent, and its files are deleted.', confirm: 'Cancel message', danger: true }))) return;
    try { await api('DELETE', `/scheduled-messages/${it.id}`); drop(it.id); } catch (e) { toast(e.message, 'error'); }
  }

  // ------------------------------------------------------------------ choosing when
  // A menu of quick picks under `anchor`, then onPick(ms). current: the time it has now (for rescheduling).
  function pickTime(anchor, onPick, { title = 'Send later', current = null } = {}) {
    const items = quickPicks().map(([label, t]) => ({ label, icon: 'clock', hint: whenLabel(t).replace(/^Today at /, ''), action: () => onPick(t) }));
    menu(anchor, [{ header: title }, ...items, '-', { label: 'Pick a date and time…', icon: 'edit', action: () => customTime(onPick, { title, current }) }], { side: 'top', align: 'end' });
  }
  function customTime(onPick, { title, current }) {
    const now = Date.now();
    const input = h('input', { type: 'datetime-local', class: 'input', step: '60', min: localInput(now + MIN), max: localInput(now + MAX_DAYS * 86400000), required: true });
    input.value = localInput(current && current > now ? current : roundUp(now + 60 * MIN));
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* unknown */ }
    const { box } = modal({
      title, size: 'sm',
      body: h('div', { class: 'stack' },
        field('Send it at', input, `In your time zone${zone ? ` (${zone})` : ''}. Up to ${MAX_DAYS} days ahead.`),
        h('p', { class: 'field-hint' }, 'Your app encrypts it now, as if you sent it now; your Hearth server keeps it, still encrypted, and posts it then. You can change or cancel it until then.')),
      actions: [{ label: 'Cancel' }, {
        label: 'Schedule', kind: 'primary', action: () => {
          const t = new Date(input.value).getTime();
          if (!input.value || !Number.isFinite(t)) { showError(box, 'Pick a date and a time.', input); return false; }
          if (t <= Date.now() + 15000) { showError(box, 'Pick a time in the future.', input); return false; }
          if (t > Date.now() + MAX_DAYS * 86400000) { showError(box, `You can schedule a message up to ${MAX_DAYS} days ahead.`, input); return false; }
          onPick(t);
          return true;
        },
      }],
    });
  }

  // ------------------------------------------------------------------ the composer bar
  const mineIn = (key) => [...items.values()].filter((it) => keyOf(it) === key).sort((a, b) => a.sendAt - b.sendAt || (a.id < b.id ? -1 : 1));
  // A bar above the composer while this conversation has scheduled messages, or null.
  function bar(key) {
    const list = mineIn(key);
    if (!list.length) return null;
    const failed = list.filter((x) => x.status === 'failed').length;
    const stuck = list.filter((x) => x.status === 'held' && (waitsForYou(x, shownDec(x)) || x.sendAt < Date.now() - LATE_OK)).length;
    const waiting = list.length - failed;
    const next = list.find((x) => x.status === 'pending');
    const text = failed ? `${plural(failed, 'scheduled message', 'scheduled messages')} here ${failed === 1 ? 'wasn’t' : 'weren’t'} sent.`
      : stuck ? `${plural(stuck, 'scheduled message is', 'scheduled messages are')} waiting for you.`
        : `${plural(waiting, 'message', 'messages')} scheduled here${next ? `, the next ${nextPhrase(next.sendAt)}` : ''}.`;
    return h('div', { class: `key-bar sched-bar${failed || stuck ? ' bad' : ''}` }, icon('clock'), h('span', null, text),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openList(key) }, 'View'));
  }

  // ------------------------------------------------------------------ the list
  // key: one conversation, or null for all of them (a push about one opens this).
  function openList(key) {
    const list = h('ul', { class: 'sched-list', 'aria-label': 'Scheduled messages' });
    const place = key ? deps.placeOf(key.startsWith('d:') ? { dmId: key.slice(2) } : { channelId: key.slice(2) }) : null;
    const editing = new Set();
    let alive = true;
    const draw = () => {
      if (!alive || !list.isConnected) { if (view && view.draw === draw) view = null; return; }
      const focusId = document.activeElement && list.contains(document.activeElement) ? (document.activeElement.closest('[data-sid]') || {}).dataset : null;
      const focusAct = focusId ? document.activeElement.getAttribute('data-act') : null;
      clear(list);
      const shown = key ? mineIn(key) : [...items.values()].sort((a, b) => a.sendAt - b.sendAt);
      if (!shown.length) {
        list.append(h('li', { class: 'panel-empty' }, icon('clock'), h('p', null, key ? 'Nothing scheduled here. Use the clock next to the send button to send a message later.' : 'You have no scheduled messages.')));
      }
      for (const it of shown) list.append(card(it, { all: !key, editing, redraw: draw, close: () => dlg && dlg.close() }));
      if (focusId && focusId.sid) {
        const again = list.querySelector(`[data-sid="${focusId.sid}"]`);
        const btn = again && (again.querySelector(`[data-act="${focusAct}"]`) || again.querySelector('button'));
        if (btn) btn.focus({ preventScroll: true });
      }
    };
    view = { key, draw };
    // What this device couldn't open before (a key that hadn't arrived) gets another try.
    for (const [id, o] of opened) if (!readable(o.dec)) opened.delete(id);
    const dlg = modal({
      title: 'Scheduled messages', size: 'md', className: 'sched-modal',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted-p' }, place ? `${place.dm ? 'To' : 'In'} ${place.label}. ` : '', 'Encrypted on your device; your server holds them until it’s time, without being able to read them.'),
        list),
      onClose: () => { alive = false; if (view && view.draw === draw) view = null; },
    });
    draw();
    if (loaded) fixHeld({ force: true }).then(draw);
  }
  function card(it, { all, editing, redraw, close }) {
    const dec = shownDec(it);
    if (!dec) open(it).then(() => { if (view) view.draw(); });
    const late = it.sendAt < Date.now();
    const needsYou = waitsForYou(it, dec);
    // Its copy opens but doesn't say it's this scheduled message, and this device didn't make it.
    const unbound = needsYou && it.reason !== 'session_ended';
    const when = it.status === 'failed' ? `Not sent · was due ${whenPhrase(it.sendAt)}`
      : it.status === 'held' ? `${late ? 'Waiting · was due' : needsYou ? 'Waiting for you · sends' : 'Waiting to be re-encrypted · sends'} ${whenPhrase(it.sendAt)}`
        : `Sends ${whenPhrase(it.sendAt)}`;
    const files = it.files ? h('span', { class: 'sched-files' }, icon('file'), plural(it.files, 'file', 'files')) : null;
    let body;
    if (editing.has(it.id) && readable(dec)) {
      const ta = h('textarea', { class: 'edit-input sched-edit', rows: '3', maxlength: '4000', 'aria-label': 'Edit scheduled message' });
      ta.value = dec.t || '';
      const save = async () => {
        if (!ta.value.trim() && !(dec.f || []).length) return toast('Write something, or cancel the message.', 'error');
        const text = ta.value;
        const done = async (opts) => {
          try { await reseal(items.get(it.id) || it, { text, ...opts }); editing.delete(it.id); redraw(); toast(opts.now ? 'Sent.' : 'Saved.'); } catch (e) { toast(e.message, 'error'); }
        };
        // Held past its time: saving would send it at once, so that's asked first.
        const cur = items.get(it.id) || it;
        if (cur.status === 'held' && cur.sendAt <= Date.now()) return askLate(cur, done);
        return done({});
      };
      const stop = () => { editing.delete(it.id); redraw(); };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
      });
      setTimeout(() => ta.focus(), 0);
      body = h('div', { class: 'edit-wrap' }, ta, h('div', { class: 'edit-hint' }, 'Esc to ', h('button', { class: 'link-btn', type: 'button', onclick: stop }, 'cancel'), ' · Enter to ', h('button', { class: 'link-btn', type: 'button', onclick: save }, 'save')));
    } else if (!dec) body = h('p', { class: 'sched-text muted' }, 'Opening…');
    else if (!readable(dec)) body = h('p', { class: 'sched-text muted' }, 'This device can’t confirm you wrote this one.');
    else body = h('p', { class: 'sched-text' }, dec.t || (dec.f && dec.f.length ? 'Attachment' : ''));
    const btn = (act, label, onclick, kind = 'ghost') => h('button', { class: `btn sm ${kind}`, type: 'button', 'data-act': act, onclick }, label);
    const actions = [];
    if (it.status === 'failed') {
      if (readable(dec) && dec.t) actions.push(btn('copy', 'Copy text', () => copyText(dec.t).then(() => toast('Copied.'))));
      actions.push(btn('cancel', 'Dismiss', () => cancel(it)));
    } else if (!readable(dec)) {
      // Not one this device can confirm (or still opening): cancelling it is all that's offered.
      actions.push(btn('cancel', 'Cancel', () => cancel(it), 'ghost danger-text'));
    } else {
      if (needsYou) actions.push(btn('keep', 'Keep', () => keep(items.get(it.id) || it), 'primary'));
      actions.push(btn('send', 'Send now', () => sendNow(items.get(it.id) || it), needsYou ? 'ghost' : 'primary'));
      if (!editing.has(it.id)) actions.push(btn('edit', 'Edit', () => { editing.add(it.id); redraw(); }));
      actions.push(btn('time', 'Reschedule', (e) => pickTime(e.currentTarget, (t) => reschedule(items.get(it.id) || it, t), { title: 'Reschedule', current: it.sendAt })));
      actions.push(btn('cancel', 'Cancel', () => cancel(it), 'ghost danger-text'));
    }
    // Why this device can't confirm it: every message your apps schedule carries a copy only your keys open.
    const doubt = dec && !readable(dec) && it.status !== 'failed'
      ? h('p', { class: 'sched-note bad' }, 'Each message your apps schedule carries a copy that only your own keys open, and this one’s doesn’t open here, so it isn’t re-encrypted or changed from here. If you didn’t schedule it, cancel it and sign out the sessions you don’t recognize (Settings → Signed-in devices).')
      : null;
    // Why it waits: your words, but this device can't tell they're still meant to go (see the top of this file).
    const waits = unbound
      ? h('p', { class: 'sched-note' }, 'Your app re-encrypts a scheduled message by itself only on the device that scheduled it, or once you’ve confirmed it, so this one waits for you. Keep it if you still want it sent. If you already sent or cancelled these words, cancel it and sign out the sessions you don’t recognize (Settings → Signed-in devices).')
      : null;
    // The server has it down for earlier than you scheduled it (it only ever makes one later by itself: slow mode).
    const own = it.status !== 'failed' ? ownTime(it) : null;
    const moved = own && it.sendAt < own - MIN
      ? h('p', { class: 'sched-note bad' }, `You scheduled it for ${whenPhrase(own)}, but your server has an earlier time for it. Your app won’t re-encrypt it by itself, and if it goes out early, everyone’s apps flag it. Reschedule it, send it now or cancel it.`)
      : null;
    const where = all ? deps.placeOf(it) : null;
    return h('li', { class: `sched-item ${it.status}`, dataset: { sid: it.id } },
      h('div', { class: 'sched-head' }, icon(it.status === 'failed' ? 'ban' : 'clock'), h('strong', { class: 'sched-when' }, when),
        it.threadId ? h('span', { class: 'sched-tag' }, 'In a thread') : null, files,
        // Encrypted for a disappearing timer: it goes that long after it's posted (sooner if the conversation's timer
        // is shorter by then).
        it.ttl > 0 ? h('span', { class: 'sched-tag', title: 'Disappearing messages: it disappears this long after it\u2019s sent, or sooner if the conversation\u2019s timer is shorter by then.' }, `Disappears after ${timerLabel(it.ttl).toLowerCase()}`) : null),
      where ? h('button', { class: 'link-btn sched-where', type: 'button', onclick: () => { close(); deps.openKey(keyOf(it)); } }, where.label) : null,
      body,
      doubt || moved, waits, doubt || waits ? null : (it.note && it.status !== 'pending' ? h('p', { class: `sched-note${it.status === 'failed' ? ' bad' : ''}` }, it.note) : null),
      h('div', { class: 'sched-actions' }, actions));
  }

  return {
    // At start-up and after reconnecting: the whole list (the server checks keys first, so what needs
    // re-encrypting says so), then what can be re-encrypted now is.
    async load() {
      try {
        const before = madeHere(); // (one scheduled while the list was on its way isn't in it yet)
        const r = await api('GET', '/scheduled-messages');
        const keys = new Set([...items.values()].map(keyOf));
        items.clear();
        for (const it of r.items || []) if (!gone.has(it.id)) { items.set(it.id, it); keys.add(keyOf(it)); }
        // What this device made and is gone since (sent or cancelled) needn't be kept.
        forgetHere([...before].filter((id) => !items.has(id)));
        loaded = true;
        keys.forEach((k) => changed(k));
        fixHeld();
      } catch { /* the list just stays as it was */ }
    },
    onUpdate: (it) => { if (it && it.id) apply(it); },
    onRemove: ({ id } = {}) => drop(id),
    // New keys arrived (a server key, a checked safety number): what was waiting for them can go.
    onKeys: () => fixHeld({ force: true }),
    // After the composer scheduled one (the live event may come first or not at all): this device made it.
    added: (it) => {
      if (!it || !it.id) return;
      if (!gone.has(it.id)) keepHere([...madeHere(), it.id]);
      apply(it);
    },
    forKey: mineIn,
    bar, openList, pickTime, whenLabel, whenPhrase,
    // Signing out: nothing of this account's is kept in this browser.
    reset() {
      try { const k = hereKey(); if (k) localStorage.removeItem(k); } catch { /* storage off */ }
      items.clear(); opened.clear(); tried.clear(); gone.clear(); loaded = false; here = new Set();
    },
  };
}
