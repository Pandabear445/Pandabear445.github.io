// Message usability helpers: composer drafts kept on this device, one notification per message across tabs,
// quiet hours, and "Export my data" (decrypted here, packed into a zip here; the server only hands out ciphertext).

// ---------------------------------------------------------------- drafts (this device only)
// What you were typing in each conversation, kept across switching conversations and reloads. Stays in this
// browser (never sent anywhere), is cleared when you send, and old ones are dropped after 30 days.
const DRAFT_MAX = 200;
const DRAFT_AGE = 30 * 86400000;
export function createDrafts(userId) {
  const key = `hearth.drafts.${userId}`;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { all = {}; }
  const cutoff = Date.now() - DRAFT_AGE;
  for (const [k, v] of Object.entries(all)) if (!v || typeof v.t !== 'string' || !(v.at > cutoff)) delete all[k];
  let timer = 0;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, DRAFT_MAX);
      all = Object.fromEntries(keep);
      try { if (keep.length) localStorage.setItem(key, JSON.stringify(all)); else localStorage.removeItem(key); } catch { /* full or blocked */ }
    }, 300);
  };
  // Another tab typed somewhere: pick it up so the next conversation switch shows it.
  window.addEventListener('storage', (e) => { if (e.key === key) { try { all = JSON.parse(e.newValue || '{}') || {}; } catch { /* keep ours */ } } });
  return {
    get: (k) => (all[k] ? all[k].t : ''),
    set(k, t) { if (t) all[k] = { t: String(t).slice(0, 4000), at: Date.now() }; else delete all[k]; save(); },
    delete(k) { delete all[k]; save(); },
    entries: () => Object.entries(all).map(([k, v]) => [k, v.t]),
    flush() { clearTimeout(timer); try { localStorage.setItem(key, JSON.stringify(all)); } catch { /* ignore */ } },
    clear() { all = {}; clearTimeout(timer); try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };
}
export const clearAllDrafts = () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith('hearth.drafts.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
};

// ---------------------------------------------------------------- one notification per message
// With Hearth open in several tabs, each gets every message. Only the first to claim a message shows its
// notification and plays its sound. A Web Lock makes the claim atomic between tabs; a short list in
// localStorage covers tabs that check a moment later.
const CLAIMED = 'hearth.notified';
function claimedList() { try { return JSON.parse(localStorage.getItem(CLAIMED) || '[]') || []; } catch { return []; } }
function claimLocal(id) {
  const seen = claimedList();
  if (seen.includes(id)) return false;
  try { localStorage.setItem(CLAIMED, JSON.stringify([...seen.slice(-199), id])); } catch { /* storage off: show it */ }
  return true;
}
export async function claimOnce(id) {
  if (!id) return true;
  try {
    if (navigator.locks && navigator.locks.request) return await navigator.locks.request(`hearth-notify-${id}`, { ifAvailable: true }, (lock) => (lock ? claimLocal(id) : false));
  } catch { /* fall back */ }
  return claimLocal(id);
}
// Read somewhere else (another tab or device): close what's still on screen for that conversation.
const shown = new Map(); // tag -> Notification shown by this tab
export function rememberNotification(tag, n) { if (tag && n) { shown.set(tag, n); n.addEventListener('close', () => { if (shown.get(tag) === n) shown.delete(tag); }); } }
export function closeNotifications(tag) {
  const n = shown.get(tag);
  if (n) { try { n.close(); } catch { /* gone */ } shown.delete(tag); }
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.getNotifications({ tag })).then((list) => list.forEach((x) => x.close())).catch(() => {});
  }
}

// ---------------------------------------------------------------- quiet hours
// The same rule the server uses for push (server/usability.js dndActive): days are when a quiet period starts.
export function quietNow(settings, t = Date.now()) {
  const d = settings && settings.dnd;
  if (!d || !d.on) return false;
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: settings.tz || 'UTC', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(t)); } catch { return false; }
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const toMin = (s) => { const m = /^(\d\d):(\d\d)$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
  const start = toMin(d.start); const end = toMin(d.end);
  const on = (x) => (d.days || []).includes((x + 7) % 7);
  if (start === end) return on(day);
  if (start < end) return on(day) && mins >= start && mins < end;
  return (on(day) && mins >= start) || (on(day - 1) && mins < end);
}

// ---------------------------------------------------------------- zip (stored, no compression)
// Just enough of the zip format to pack an export: files stored as they are (attachments are mostly already
// compressed), with CRC-32s. No dependency needed. Kept under 4 GB (no zip64): the export caps sizes well below.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
export function createZip() {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  function unique(name) {
    let n = name; let i = 1;
    while (names.has(n)) { const dot = name.lastIndexOf('.'); n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`; i++; }
    names.add(n);
    return n;
  }
  return {
    // data: string or Uint8Array. Returns the name actually used (made unique if needed).
    add(name, data, date = new Date()) {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      const used = unique(name);
      const nameBytes = enc.encode(used);
      const crc = crc32(bytes);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); // UTF-8 names
      head.setUint16(8, 0, true); head.setUint16(10, dosTime(date), true); head.setUint16(12, dosDate(date), true);
      head.setUint32(14, crc, true); head.setUint32(18, bytes.length, true); head.setUint32(22, bytes.length, true);
      head.setUint16(26, nameBytes.length, true); head.setUint16(28, 0, true);
      parts.push(head.buffer, nameBytes, bytes);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, dosTime(date), true); cd.setUint16(14, dosDate(date), true);
      cd.setUint32(16, crc, true); cd.setUint32(20, bytes.length, true); cd.setUint32(24, bytes.length, true);
      cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, offset, true);
      central.push(cd.buffer, nameBytes);
      offset += 30 + nameBytes.length + bytes.length;
      return used;
    },
    get size() { return offset; },
    blob() {
      const cdSize = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
      const end = new DataView(new ArrayBuffer(22));
      const count = central.length / 2;
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    },
  };
}

// ---------------------------------------------------------------- export my data
export const EXPORT_LIMITS = { messages: 200000, perConversation: 50000, attachmentBytes: 500 * 1024 * 1024, fileBytes: 100 * 1024 * 1024 };
const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'file';
const README = `Hearth data export
==================

This archive was put together on your own device. The server sent your messages encrypted, and your app
decrypted them before writing them here, so nobody else saw this copy being made.

What's inside
- account.json         Your account: username, email (if any), profile, privacy settings, servers and groups
                       you're in (with your roles and the channels you can read), your direct-message list,
                       friends, blocked people, saved messages, notification settings, read markers and the
                       reports you filed.
- conversations/       One JSON file per channel, group chat or direct message you can read right now, with
                       every message the app could decrypt: who sent it, when, the text, replies, threads,
                       reactions, polls and attachment details. Messages it couldn't decrypt are listed as such.
- attachments/         The files attached to those messages, decrypted, up to the size limit below.
- manifest.json        What was exported, what was skipped and why.

What's not inside
- Other people's private details: only the names and ids already shown to you in Hearth.
- Conversations you can no longer see (servers you left, channels you lost access to).
- Passwords, keys and sign-in sessions.

Limits: up to 200,000 messages (50,000 per conversation) and 500 MB of attachments (100 MB per file).
`;

// ctx: { token, S, sec, decryptMessage, onProgress(text, fraction), signal }
export async function runExport(ctx) {
  const { token, S, onProgress = () => {}, signal } = ctx;
  const headers = { Authorization: 'Bearer ' + (localStorage.getItem('hearth.token') || ''), 'X-Export-Token': token };
  const get = async (path) => {
    if (signal && signal.aborted) throw new Error('Export cancelled.');
    const r = await fetch('/api' + path, { headers, signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, code: data.code });
    return data;
  };
  const zip = createZip();
  const manifest = { exportedAt: new Date().toISOString(), conversations: [], skipped: [], limits: EXPORT_LIMITS, totals: { messages: 0, undecryptable: 0, attachments: 0, attachmentBytes: 0 } };
  onProgress('Getting your account details…', 0);
  const account = await get('/me/export/account');
  zip.add('account.json', JSON.stringify(account, null, 2));
  const people = new Map();
  const nameOf = (id) => { const u = S.users[id]; return u ? { id, username: u.username, displayName: (u.profile && u.profile.displayName) || u.username } : { id }; };
  const convs = [];
  for (const s of account.servers) for (const c of s.channels) convs.push({ conv: 'c:' + c.id, serverId: s.id, label: s.kind === 'group' ? `group-${safeName(s.name || s.id)}` : `${safeName(s.name)}-${safeName(c.name)}`, meta: { kind: s.kind === 'group' ? 'group' : 'channel', server: s.name, channel: c.name, channelId: c.id, serverId: s.id } });
  for (const d of account.dms) convs.push({ conv: 'd:' + d.id, label: `dm-${safeName(d.with.username || d.with.id)}`, meta: { kind: 'dm', with: d.with, dmId: d.id } });
  let total = 0;
  let bytes = 0;
  for (let i = 0; i < convs.length; i++) {
    const cv = convs[i];
    const out = [];
    let after = '';
    for (;;) {
      if (total >= EXPORT_LIMITS.messages || out.length >= EXPORT_LIMITS.perConversation) { manifest.skipped.push({ conversation: cv.label, reason: 'message limit reached' }); break; }
      onProgress(`Reading ${cv.meta.kind === 'dm' ? 'a conversation' : cv.label} (${i + 1} of ${convs.length}) — ${total.toLocaleString()} messages so far`, i / convs.length);
      let page;
      try { page = await get(`/me/export/messages?conv=${encodeURIComponent(cv.conv)}&limit=500${after ? `&after=${after}` : ''}`); } catch (e) {
        if (e.code === 'export_limit') { manifest.skipped.push({ conversation: cv.label, reason: 'export limit reached' }); break; }
        if (e.status === 404) { manifest.skipped.push({ conversation: cv.label, reason: 'no longer available' }); break; }
        throw e;
      }
      for (const m of page.messages) {
        await ctx.decryptMessage(m).catch(() => {});
        const ok = m.dec && !m.dec.error && !m.dec.pending;
        const rec = { id: m.id, author: nameOf(m.authorId), sentAt: new Date(m.createdAt).toISOString(), editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : undefined, replyTo: m.replyTo || undefined, threadId: m.threadId || undefined, pinned: m.pinnedAt ? true : undefined,
          reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.userIds.length, byMe: r.userIds.includes(S.me.id) })) };
        people.set(m.authorId, rec.author);
        if (m.legacy) { rec.text = m.content || ''; rec.note = 'sent before end-to-end encryption'; } else if (ok) {
          rec.text = m.dec.t || '';
          if (m.dec.p) rec.poll = { question: m.dec.p.q, options: m.dec.p.o };
          rec.attachments = [];
          for (const f of m.dec.f || []) {
            const a = { name: f.name || 'file', type: f.type || '', size: f.size || 0 };
            if (!f.url) { rec.attachments.push(a); continue; }
            if ((f.size || 0) > EXPORT_LIMITS.fileBytes || bytes + (f.size || 0) > EXPORT_LIMITS.attachmentBytes) { a.skipped = 'size limit'; manifest.skipped.push({ attachment: a.name, message: m.id, reason: 'size limit' }); rec.attachments.push(a); continue; }
            try {
              const r = await fetch(f.url, { signal });
              if (!r.ok) throw new Error('gone');
              const plain = new Uint8Array(await ctx.sec.decryptAttachment(m, f, await r.arrayBuffer()));
              bytes += plain.length;
              a.file = zip.add(`attachments/${m.id}-${safeName(a.name)}`, plain, new Date(m.createdAt));
              manifest.totals.attachments++;
            } catch { a.skipped = 'couldn’t be downloaded or decrypted'; }
            rec.attachments.push(a);
          }
          if (!rec.attachments.length) delete rec.attachments;
        } else { rec.encrypted = true; manifest.totals.undecryptable++; }
        out.push(rec);
      }
      total += page.messages.length;
      if (!page.hasMore || !page.messages.length) break;
      after = page.messages[page.messages.length - 1].id;
    }
    const file = zip.add(`conversations/${cv.label}.json`, JSON.stringify({ ...cv.meta, messages: out }, null, 2));
    manifest.conversations.push({ file, ...cv.meta, messages: out.length });
  }
  manifest.totals.messages = total;
  manifest.totals.attachmentBytes = bytes;
  manifest.people = [...people.values()];
  zip.add('manifest.json', JSON.stringify(manifest, null, 2));
  zip.add('README.txt', README);
  onProgress('Packing the download…', 1);
  return { blob: zip.blob(), manifest };
}
