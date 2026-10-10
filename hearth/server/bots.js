// Bots and integrations: accounts that programs drive, installed into servers by the people who run them.
//
// What a bot is: a users row with is_bot = 1 (it can never sign in) plus a bots row (who made it, its webhook).
// A server's owner, or anyone with Manage Server, installs it with scopes and a channel allow-list they approve
// in a dialog. It then acts through the bot API (/api/bot/v1, "Authorization: Bot hb_<id>.<secret>") and hears
// about things through signed webhooks.
//
// The rules that keep it safe:
//  - Channel messages from people are end-to-end encrypted, so the server can't hand their text to a bot and
//    never tries: events carry ids, authors and times only. Text reaches a bot only when a person deliberately
//    sends it one, with a slash command, after a warning that it goes to the bot unencrypted.
//  - Every API call and every event checks the installation's scopes and channels. Nothing is granted by
//    default; the installer picks from what the bot asks for.
//  - Tokens are stored as SHA-256 hashes, shown once, rotatable and revocable, never accepted in a URL, never
//    logged. Creating, rotating and revoking them is audit-logged.
//  - Webhooks go through netguard (https only, private addresses refused unless BOT_WEBHOOK_ALLOW_PRIVATE=1),
//    with a timeout, a per-bot concurrency cap, retries with backoff, then a dead-letter list.
//  - A bot's own actions never come back to it as events, and no bot code ever runs inside Hearth.
// See docs/BOTS.md for the developer side.
const crypto = require('crypto');
const jobs = require('./jobs');
const netguard = require('./netguard');

const SCOPES = {
  'messages.send': 'Post messages in the channels you pick. Bot messages aren’t end-to-end encrypted, and they’re marked that way.',
  'messages.read.metadata': 'See when messages are posted or deleted in those channels, and by whom. Never what they say: that stays end-to-end encrypted.',
  'channels.read': 'See the names and topics of those channels, and when channels are made or deleted.',
  'members.read': 'See who’s in this server, and who joins and leaves.',
  'reactions.write': 'Add reactions to messages in those channels.',
  commands: 'Offer slash commands. What people type after a command goes to the bot without end-to-end encryption (they’re warned first).',
  'webhooks.manage': 'Choose which events it gets, and see and retry its failed deliveries.',
};
const SCOPE_NAMES = Object.keys(SCOPES);
// Which scope each event needs (null: every installation gets it).
const EVENTS = {
  'message.created': 'messages.read.metadata',
  'message.deleted': 'messages.read.metadata',
  'reaction.added': 'messages.read.metadata',
  'member.joined': 'members.read',
  'member.left': 'members.read',
  'channel.created': 'channels.read',
  'channel.deleted': 'channels.read',
  'bot.installed': null,
  'bot.uninstalled': null,
  'command.invoked': 'commands',
};
const ARG_TYPES = ['string', 'number', 'user', 'channel'];
const MAX_CONTENT = 2000;
const MAX_ATTEMPTS = 6;
const TOKEN_RE = /^hb_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ERROR_CODES = { 400: 'bad_request', 401: 'bad_token', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 410: 'gone', 413: 'too_large', 429: 'rate_limited', 503: 'unavailable' };

// Tunables. The defaults are for real use; the tests shrink the waits.
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const cfg = () => ({
  allowPrivate: process.env.BOT_WEBHOOK_ALLOW_PRIVATE === '1',
  timeout: num(process.env.BOT_WEBHOOK_TIMEOUT_MS, 5000),
  retryBase: num(process.env.BOT_RETRY_BASE_MS, 15000),
  interactionTimeout: num(process.env.BOT_INTERACTION_TIMEOUT_MS, 10000),
  perBot: num(process.env.BOT_MAX_CONCURRENCY, 4),
});

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const parseList = (s, d = []) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : d; } catch { return d; } };
// The signature a bot checks: HMAC-SHA256 over "<timestamp>.<raw body>" with its webhook secret.
const sign = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

module.exports = function setupBots(ctx) {
  const { api, express, db, fail, HttpError, wrap, rateLimit, newId, seal, unseal, sealSecret, openSecret, auth, stepUp, auditLog, checkWords,
    perms, PM, getUserRow, publicUser, requireServer, requireChannel, serializeMessage, toChannel, reactionsFor, deleteMessageTree, emitServer,
    getIo, features, isStaff, isInstanceAdmin, maintenance, newsBot } = ctx;
  const now = () => Date.now();
  const io = () => getIo() || { to: () => ({ emit() {} }), sockets: { sockets: new Map() } };

  // ------------------------------------------------------------------ rows and checks
  const botRow = (id) => db.prepare('SELECT * FROM bots WHERE id = ?').get(String(id || ''));
  const installRow = (botId, serverId) => db.prepare('SELECT * FROM bot_installations WHERE bot_id = ? AND server_id = ?').get(botId, serverId);
  const scopesOf = (inst) => parseList(inst.scopes).filter((s) => SCOPE_NAMES.includes(s));
  const hasScope = (inst, scope) => scopesOf(inst).includes(scope);
  // The channel allow-list is either "*" (every channel @everyone can see, including ones made later) or a list
  // of ids the installer picked (which may include private channels they could see themselves).
  const allChannels = (inst) => inst.channels === '"*"';
  const channelIds = (inst) => (allChannels(inst) ? null : parseList(inst.channels).map(String));
  function channelAllowed(inst, c, srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id)) {
    if (!c || !srv || c.server_id !== inst.server_id) return false;
    if (allChannels(inst)) return !perms.restricted(srv, c);
    return channelIds(inst).includes(c.id);
  }
  const allowedChannels = (inst) => {
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(inst.server_id);
    return db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, created_at').all(inst.server_id).filter((c) => channelAllowed(inst, c, srv));
  };
  const botUsable = (bot) => {
    if (!bot || bot.disabled) return false;
    const u = getUserRow(bot.id);
    return !!u && !u.deleted_at && !u.suspended_at;
  };
  // Health comes from the last thing that actually worked (a delivery or an API call), not from the bot existing.
  function health(inst) {
    if (!inst.enabled) return 'paused';
    if (inst.last_error_at && (!inst.last_ok_at || inst.last_error_at > inst.last_ok_at)) return 'failing';
    if (!inst.last_ok_at) return 'waiting';
    return 'ok';
  }
  const markOk = (instId) => db.prepare('UPDATE bot_installations SET last_ok_at = ? WHERE id = ? AND (last_ok_at IS NULL OR last_ok_at < ?)').run(now(), instId, now() - 30000);
  const markError = (instId, msg) => db.prepare('UPDATE bot_installations SET last_error = ?, last_error_at = ? WHERE id = ?').run(String(msg).slice(0, 200), now(), instId);

  // Which bots appear in a server's member list (next to the news bot): the ones installed and switched on.
  const serverBots = (serverId) => db.prepare(`SELECT i.bot_id FROM bot_installations i JOIN bots b ON b.id = i.bot_id
      WHERE i.server_id = ? AND i.enabled = 1 AND b.disabled = 0 ORDER BY i.created_at`).all(serverId).map((r) => r.bot_id);

  // ------------------------------------------------------------------ tokens
  // hb_<16 hex id>.<43 chars of base64url secret>: 256 random bits. Only a hash of the secret is kept.
  function issueToken(botId, installationId, userId) {
    const id = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO bot_tokens (id, bot_id, installation_id, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, botId, installationId || null, sha256(`${id}.${secret}`), userId || null, now());
    return { id, token: `hb_${id}.${secret}` };
  }
  function tokenFor(raw) {
    const m = TOKEN_RE.exec(String(raw || ''));
    if (!m) return null;
    const t = db.prepare('SELECT * FROM bot_tokens WHERE id = ?').get(m[1]);
    if (!t || t.revoked_at) return null;
    const want = Buffer.from(t.token_hash, 'hex');
    const got = Buffer.from(sha256(`${m[1]}.${m[2]}`), 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? t : null;
  }
  const tokenOut = (t) => ({ id: t.id, installationId: t.installation_id || null, createdAt: t.created_at, lastUsedAt: t.last_used_at || null, revokedAt: t.revoked_at || null });

  // ------------------------------------------------------------------ outgoing events
  // A delivery body is fixed when the event happens (same id on every retry, so a bot can drop duplicates); the
  // timestamp header and signature are made fresh for each attempt.
  function envelope(type, bot, inst, data, id = newId()) {
    return { id, body: JSON.stringify({ v: 1, id, type, createdAt: now(), botId: bot.id, installationId: inst ? inst.id : null, serverId: inst ? inst.server_id : null, data }) };
  }
  function enqueue(type, bot, inst, data) {
    const e = envelope(type, bot, inst, data);
    db.prepare('INSERT INTO bot_deliveries (id, bot_id, installation_id, server_id, type, body, status, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?)')
      .run(e.id, bot.id, inst ? inst.id : null, inst ? inst.server_id : null, type, e.body, now(), now());
    setImmediate(pumpSafely);
    return e.id;
  }
  // Something happened in a server: tell every installation allowed to know. `channel` is the channel it
  // happened in (checked against each installation's allow-list); `actorId` is who did it (a bot never hears
  // about its own actions, so a bot answering an event can't set off an endless loop with itself).
  function event(type, serverId, data, { channel = null, actorId = null } = {}) {
    const scope = EVENTS[type];
    if (scope === undefined || type === 'command.invoked') return;
    const rows = db.prepare(`SELECT i.* FROM bot_installations i JOIN bots b ON b.id = i.bot_id
        WHERE i.server_id = ? AND i.enabled = 1 AND b.disabled = 0 AND b.webhook_url IS NOT NULL`).all(serverId);
    if (!rows.length) return;
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    for (const inst of rows) {
      if (inst.bot_id === actorId) continue;
      if (scope && !hasScope(inst, scope)) continue;
      const wanted = inst.events ? parseList(inst.events) : null;
      if (wanted && !wanted.includes(type)) continue;
      if (channel && !channelAllowed(inst, channel, srv)) continue;
      enqueue(type, botRow(inst.bot_id), inst, data);
    }
  }

  // One POST to the bot's webhook. Resolves { ok, status, error }; never throws.
  async function post(bot, type, deliveryId, body, timeout = cfg().timeout) {
    const ts = Math.floor(now() / 1000);
    const secret = openSecret(bot.webhook_secret);
    if (!bot.webhook_url || !secret) return { ok: false, status: null, error: 'The bot has no webhook address.' };
    try {
      const r = await netguard.request(bot.webhook_url, {
        method: 'POST', protocols: ['https:'], allowPrivate: cfg().allowPrivate, maxRedirects: 0, timeout, maxBytes: 64 * 1024, truncate: true, decompress: false,
        headers: {
          'Content-Type': 'application/json', 'User-Agent': 'HearthBots/1 (+self-hosted chat)', 'X-Hearth-Event': type, 'X-Hearth-Delivery': deliveryId,
          'X-Hearth-Timestamp': String(ts), 'X-Hearth-Signature': `v1=${sign(secret, ts, body)}`,
        },
        body,
      });
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
      return { ok: false, status: r.status, error: `The bot’s server answered ${r.status}.` };
    } catch (e) {
      return { ok: false, status: null, error: e instanceof netguard.GuardError ? e.message : 'Couldn’t reach the bot.' };
    }
  }
  // Waits after failed attempt n (1-based): base, 2×, 4×, 8×, 16× with ±25% jitter so retries from many bots
  // don't line up. Capped at an hour.
  const backoff = (n) => Math.min(3600000, Math.round(cfg().retryBase * 2 ** (n - 1) * (0.75 + Math.random() * 0.5)));

  const inflight = new Map(); // bot id -> deliveries being sent right now
  const sending = new Set(); // delivery ids being sent
  let pumping = false; let again = false; let wake = null;
  // The wake-ups (after a send, at the next retry) run it as a safe job too: a database error is logged and shown
  // in Admin → Health instead of stopping the server.
  const pumpSafely = jobs.job('bots.deliveries', pump);
  function pump() {
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do {
        again = false;
        const due = db.prepare("SELECT * FROM bot_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 200").all(now());
        for (const d of due) {
          if (sending.has(d.id) || (inflight.get(d.bot_id) || 0) >= cfg().perBot || sending.size >= 64) continue;
          attempt(d);
        }
      } while (again);
    } finally { pumping = false; }
    // Sleep until the next retry is due (the interval below is only a safety net).
    const next = db.prepare("SELECT MIN(next_at) t FROM bot_deliveries WHERE status = 'pending'").get().t;
    if (wake) clearTimeout(wake);
    // (Deliveries already due but waiting for a busy bot start when one of its sends finishes, so there's no
    // need to spin for them: look again in a quarter of a second at the soonest.)
    wake = next ? setTimeout(pumpSafely, next <= now() ? 250 : Math.max(20, next - now() + 5)) : null;
    if (wake) wake.unref();
  }
  async function attempt(d) {
    sending.add(d.id);
    inflight.set(d.bot_id, (inflight.get(d.bot_id) || 0) + 1);
    try {
      const bot = botRow(d.bot_id);
      const inst = d.installation_id ? db.prepare('SELECT * FROM bot_installations WHERE id = ?').get(d.installation_id) : null;
      // Uninstalled since (only its own "uninstalled" event still goes) or turned off: nothing to send.
      if (!bot || (d.installation_id && !inst && d.type !== 'bot.uninstalled')) { db.prepare('DELETE FROM bot_deliveries WHERE id = ?').run(d.id); return; }
      const r = botUsable(bot) ? await post(bot, d.type, d.id, d.body) : { ok: false, status: null, error: 'The bot is turned off.' };
      const tries = d.attempts + 1;
      if (r.ok) {
        db.prepare("UPDATE bot_deliveries SET status = 'ok', attempts = ?, last_status = ?, last_error = NULL, done_at = ? WHERE id = ?").run(tries, r.status, now(), d.id);
        if (inst) markOk(inst.id);
      } else {
        const dead = tries >= MAX_ATTEMPTS;
        db.prepare('UPDATE bot_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_at = ?, done_at = ? WHERE id = ?')
          .run(dead ? 'dead' : 'pending', tries, r.status, r.error, dead ? null : now() + backoff(tries), dead ? now() : null, d.id);
        if (inst) markError(inst.id, r.error);
      }
    } finally {
      sending.delete(d.id);
      inflight.set(d.bot_id, inflight.get(d.bot_id) - 1);
      setImmediate(pumpSafely);
    }
  }
  // Also on a timer (a safe job: errors are logged and counted in Admin → Health), in case a wake-up was missed.
  jobs.every('bots.deliveries', 5000, pump, { firstDelay: 1000 });
  // Delivered events are kept 3 days (for "recent deliveries"), dead letters 30 days, at most 500 per bot.
  jobs.every('bots.prune_deliveries', 3600000, () => {
    const t = now();
    db.prepare("DELETE FROM bot_deliveries WHERE (status = 'ok' AND done_at < ?) OR (status = 'dead' AND done_at < ?)").run(t - 3 * 86400000, t - 30 * 86400000);
    for (const b of db.prepare('SELECT bot_id FROM bot_deliveries GROUP BY bot_id HAVING COUNT(*) > 500').all()) {
      db.prepare("DELETE FROM bot_deliveries WHERE bot_id = ? AND status != 'pending' AND id NOT IN (SELECT id FROM bot_deliveries WHERE bot_id = ? ORDER BY created_at DESC LIMIT 500)").run(b.bot_id, b.bot_id);
    }
  });

  const deliveryOut = (d) => {
    let data = {};
    try { data = JSON.parse(d.body).data || {}; } catch { /* */ }
    return { id: d.id, type: d.type, status: d.status, attempts: d.attempts, lastStatus: d.last_status, lastError: d.last_error, createdAt: d.created_at, doneAt: d.done_at, nextAt: d.status === 'pending' ? d.next_at : null, data };
  };
  const deliveriesOf = (inst) => ({
    recent: db.prepare("SELECT * FROM bot_deliveries WHERE installation_id = ? AND status != 'dead' ORDER BY created_at DESC LIMIT 30").all(inst.id).map(deliveryOut),
    dead: db.prepare("SELECT * FROM bot_deliveries WHERE installation_id = ? AND status = 'dead' ORDER BY created_at DESC LIMIT 100").all(inst.id).map(deliveryOut),
  });
  function retryDead(inst, ids) {
    const st = db.prepare("UPDATE bot_deliveries SET status = 'pending', attempts = 0, next_at = ?, done_at = NULL WHERE id = ? AND installation_id = ? AND status = 'dead'");
    let n = 0;
    const list = Array.isArray(ids) ? ids.slice(0, 100).map(String) : db.prepare("SELECT id FROM bot_deliveries WHERE installation_id = ? AND status = 'dead'").all(inst.id).map((r) => r.id);
    db.transaction(() => list.forEach((id) => { n += st.run(now(), id, inst.id).changes; }))();
    setImmediate(pumpSafely);
    return n;
  }
  const clearDead = (inst) => db.prepare("DELETE FROM bot_deliveries WHERE installation_id = ? AND status = 'dead'").run(inst.id).changes;

  // ------------------------------------------------------------------ checking what people and bots send
  function cleanContent(v) {
    if (typeof v !== 'string' || !v.trim()) fail(400, 'Send some text in "content".', 'bad_content');
    if (v.length > MAX_CONTENT) fail(400, `Messages can be up to ${MAX_CONTENT} characters.`, 'too_long');
    try { checkWords(v); } catch (e) { fail(400, e.message, 'blocked_word'); }
    return v;
  }
  function cleanScopes(list, { from = SCOPE_NAMES } = {}) {
    if (!Array.isArray(list)) fail(400, 'Scopes must be a list.', 'bad_scopes');
    const out = [...new Set(list.map(String))];
    const unknown = out.find((s) => !SCOPE_NAMES.includes(s));
    if (unknown) fail(400, `Unknown scope: ${unknown.slice(0, 40)}.`, 'bad_scopes');
    const extra = out.find((s) => !from.includes(s));
    if (extra) fail(400, `This bot doesn’t ask for ${extra}.`, 'bad_scopes');
    return SCOPE_NAMES.filter((s) => out.includes(s));
  }
  // An allow-list from an installer: "*" (all public channels), or channels of this server they can see.
  function cleanChannels(v, srv, userId) {
    if (v === '*') return '*';
    if (!Array.isArray(v)) fail(400, 'Pick the channels the bot may use, or "*" for every public channel.', 'bad_channels');
    const ids = [...new Set(v.map(String))].slice(0, 200);
    for (const id of ids) {
      const c = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(id, srv.id);
      if (!c || !(perms.channel(srv, c, userId) & PM.VIEW_CHANNEL)) fail(400, 'One of those channels isn’t in this server (or you can’t see it).', 'bad_channels');
    }
    return ids;
  }
  async function checkWebhookUrl(url) {
    if (url === undefined || url === null || url === '') return null;
    const s = String(url).trim();
    if (s.length > 500) fail(400, 'That address is too long.', 'bad_webhook');
    try {
      return (await netguard.checkPublicUrl(s, { protocols: ['https:'], allowPrivate: cfg().allowPrivate })).href;
    } catch (e) {
      if (e instanceof netguard.GuardError) fail(400, e.code === 'PRIVATE' ? `${e.message} Webhooks have to be on the public internet.` : e.message, e.code === 'PRIVATE' ? 'private_address' : 'bad_webhook');
      throw e;
    }
  }
  // Slash command definitions from a bot.
  function cleanCommands(list) {
    if (!Array.isArray(list) || list.length > 25) fail(400, 'Send up to 25 commands in "commands".', 'bad_commands');
    const seen = new Set();
    return list.map((c) => {
      const name = String((c && c.name) || '').toLowerCase();
      if (!COMMAND_NAME.test(name)) fail(400, 'Command names are 1–32 lowercase letters, numbers, - and _.', 'bad_commands');
      if (seen.has(name)) fail(400, `Command /${name} is listed twice.`, 'bad_commands');
      seen.add(name);
      const options = Array.isArray(c.options) ? c.options : [];
      if (options.length > 10) fail(400, `/${name}: up to 10 arguments.`, 'bad_commands');
      const argNames = new Set();
      let optional = false;
      const opts = options.map((o) => {
        const n = String((o && o.name) || '').toLowerCase();
        if (!COMMAND_NAME.test(n) || argNames.has(n)) fail(400, `/${name}: argument names must be unique, 1–32 lowercase letters, numbers, - and _.`, 'bad_commands');
        argNames.add(n);
        if (!ARG_TYPES.includes(o.type)) fail(400, `/${name} ${n}: the type must be one of ${ARG_TYPES.join(', ')}.`, 'bad_commands');
        const required = o.required !== false;
        if (required && optional) fail(400, `/${name}: required arguments come before optional ones.`, 'bad_commands');
        if (!required) optional = true;
        return { name: n, description: String(o.description || '').slice(0, 100), type: o.type, required };
      });
      const permission = c.permission == null || c.permission === '' ? null : String(c.permission);
      if (permission && !Object.hasOwn(PM, permission)) fail(400, `/${name}: unknown permission ${permission.slice(0, 40)}.`, 'bad_commands');
      return { name, description: String(c.description || '').slice(0, 100), options: opts, permission };
    });
  }
  const commandOut = (r) => ({ name: r.name, description: r.description, options: parseList(r.options), permission: r.permission || null });
  // Checks the arguments someone typed against a command's definition. Returns { name: value } with user and
  // channel arguments as ids (a user must be in this server, a channel one the invoker can see).
  function checkArgs(cmd, args, srv, userId) {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const defs = parseList(cmd.options);
    const known = new Set(defs.map((d) => d.name));
    const stray = Object.keys(a).find((k) => !known.has(k));
    if (stray) fail(400, `/${cmd.name} has no argument called ${stray.slice(0, 32)}.`, 'bad_args');
    const out = {};
    for (const d of defs) {
      const v = a[d.name];
      if (v === undefined || v === null || v === '') {
        if (d.required) fail(400, `/${cmd.name} needs ${d.name}.`, 'bad_args');
        continue;
      }
      if (d.type === 'number') {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (!Number.isFinite(n)) fail(400, `${d.name} has to be a number.`, 'bad_args');
        out[d.name] = n;
      } else if (d.type === 'string') {
        if (typeof v !== 'string' || v.length > 1000) fail(400, `${d.name} has to be text (up to 1000 characters).`, 'bad_args');
        out[d.name] = v;
      } else if (d.type === 'user') {
        if (typeof v !== 'string' || !db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(srv.id, v)) fail(400, `${d.name} has to be someone in this server.`, 'bad_args');
        out[d.name] = v;
      } else if (d.type === 'channel') {
        const c = typeof v === 'string' && db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(v, srv.id);
        if (!c || !(perms.channel(srv, c, userId) & PM.VIEW_CHANNEL)) fail(400, `${d.name} has to be a channel in this server.`, 'bad_args');
        out[d.name] = c.id;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ posting as a bot
  function postAsBot(bot, inst, c, content, replyTo) {
    rateLimit(`botmsg:${bot.id}:${c.id}`, 10, 10000);
    rateLimit('botmsgh:' + bot.id, 1000, 3600000);
    let reply = replyTo ? String(replyTo) : null;
    if (reply && !db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(reply, c.id)) reply = null;
    const id = newId();
    // Stored like the news bot's posts: sealed with the server's at-rest key, marked as a bot post.
    db.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL)')
      .run(id, c.id, bot.id, seal({ content, attachments: [], bot: true }), reply, now());
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    toChannel(c).emit('message:new', serializeMessage(row, c));
    event('message.created', c.server_id, metaOf(row, c), { channel: c, actorId: bot.id });
    markOk(inst.id);
    return row;
  }
  const isBotUser = (id) => !!(getUserRow(id) || {}).is_bot;
  const metaOf = (m, c) => ({ messageId: m.id, channelId: c.id, authorId: m.author_id, authorIsBot: isBotUser(m.author_id), createdAt: m.created_at, editedAt: m.edited_at || null, threadId: m.thread_id || null, replyTo: m.reply_to || null });

  // ------------------------------------------------------------------ the bot API: /api/bot/v1
  const bapi = express.Router();
  // A token in the address ends up in proxy logs, browser history and Referer headers, so it's refused there
  // even when it's right (and the request goes no further).
  const TOKEN_IN_URL = /hb_[0-9a-f]{8,}/i;
  function botAuth(req, res, next) {
    try {
      const query = String(req.originalUrl || '').split('?').slice(1).join('?');
      let decoded = query;
      try { decoded = decodeURIComponent(query); } catch { /* keep it raw */ }
      if (TOKEN_IN_URL.test(decoded) || Object.keys(req.query || {}).some((k) => /^(token|access_token|bot_token|authorization)$/i.test(k))) {
        fail(400, 'Send the bot token in the Authorization header ("Authorization: Bot <token>"), never in the address.', 'token_in_url');
      }
      const m = /^Bot\s+(\S+)$/.exec(String(req.headers.authorization || '').trim());
      const t = m && tokenFor(m[1]);
      if (!t) {
        rateLimit('botbad:' + req.ip, 30, 60000);
        fail(401, m ? 'That bot token isn’t valid: it’s wrong, or it was rotated or revoked.' : 'Send your token as "Authorization: Bot <token>".', 'bad_token');
      }
      const bot = botRow(t.bot_id);
      if (!botUsable(bot)) fail(403, 'This bot is turned off.', 'bot_disabled');
      rateLimit('botapi:' + bot.id, 60, 10000);
      rateLimit('botapih:' + bot.id, 5000, 3600000);
      if (maintenance()) fail(503, 'This Hearth is under maintenance. Try again later.', 'maintenance');
      if (!t.last_used_at || now() - t.last_used_at > 60000) db.prepare('UPDATE bot_tokens SET last_used_at = ? WHERE id = ?').run(now(), t.id);
      req.bot = bot;
      req.botToken = t;
      next();
    } catch (e) { next(e); }
  }
  bapi.use(botAuth);
  // The installation this request may act in. A token made for one installation works only there.
  function myInstall(req, { serverId = null, id = null } = {}) {
    const inst = id ? db.prepare('SELECT * FROM bot_installations WHERE id = ? AND bot_id = ?').get(String(id), req.bot.id) : installRow(req.bot.id, serverId);
    if (!inst || (req.botToken.installation_id && req.botToken.installation_id !== inst.id)) fail(404, 'This bot isn’t installed there.', 'not_installed');
    if (!inst.enabled) fail(403, 'This installation is paused by the server.', 'installation_paused');
    return inst;
  }
  const needScope = (inst, scope) => { if (!hasScope(inst, scope)) fail(403, `This installation didn’t grant the ${scope} scope.`, 'missing_scope'); };
  // A channel the bot may act in with `scope`: installed in its server, scope granted, channel on the allow-list.
  function botChannel(req, channelId, scope) {
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(String(channelId));
    if (!c) fail(404, 'No such channel.', 'not_found');
    const inst = myInstall(req, { serverId: c.server_id });
    needScope(inst, scope);
    if (!channelAllowed(inst, c)) fail(403, 'This bot isn’t allowed in that channel.', 'channel_not_allowed');
    return { c, inst };
  }
  const botMessage = (req, id, scope) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(String(id));
    if (!m) fail(404, 'No such message.', 'not_found');
    return { m, ...botChannel(req, m.channel_id, scope) };
  };
  const instOut = (inst) => {
    const srv = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(inst.server_id) || {};
    return { id: inst.id, serverId: inst.server_id, serverName: srv.name || '', scopes: scopesOf(inst), allChannels: allChannels(inst), channelIds: allowedChannels(inst).map((c) => c.id),
      events: inst.events ? parseList(inst.events) : null, enabled: !!inst.enabled, createdAt: inst.created_at };
  };

  bapi.get('/me', (req, res) => {
    const u = publicUser(getUserRow(req.bot.id));
    res.json({ id: req.bot.id, username: u.username, name: req.bot.name, description: req.bot.description, avatar: req.bot.avatar || null, requestedScopes: parseList(req.bot.requested_scopes),
      token: { id: req.botToken.id, installationId: req.botToken.installation_id || null }, webhook: !!req.bot.webhook_url });
  });
  bapi.get('/installations', (req, res) => {
    const rows = db.prepare('SELECT * FROM bot_installations WHERE bot_id = ? ORDER BY created_at').all(req.bot.id)
      .filter((i) => !req.botToken.installation_id || i.id === req.botToken.installation_id);
    res.json({ installations: rows.map(instOut) });
  });
  bapi.get('/installations/:id/channels', (req, res) => {
    const inst = myInstall(req, { id: req.params.id });
    needScope(inst, 'channels.read');
    markOk(inst.id);
    res.json({ channels: allowedChannels(inst).map((c) => ({ id: c.id, name: c.name, type: c.type, topic: c.topic || '', category: c.category || '' })) });
  });
  bapi.get('/installations/:id/members', (req, res) => {
    const inst = myInstall(req, { id: req.params.id });
    needScope(inst, 'members.read');
    markOk(inst.id);
    const after = String(req.query.after || '');
    const rows = db.prepare(`SELECT m.user_id, m.joined_at, u.username, u.profile FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.server_id = ? AND m.user_id > ? ORDER BY m.user_id LIMIT 1000`).all(inst.server_id, after);
    res.json({ members: rows.map((r) => { let p = {}; try { p = JSON.parse(r.profile || '{}'); } catch { /* */ } return { id: r.user_id, username: r.username, displayName: p.displayName || r.username, joinedAt: r.joined_at }; }), next: rows.length === 1000 ? rows[rows.length - 1].user_id : null });
  });
  // Message metadata (never content: people's messages are end-to-end encrypted, and other bots' posts aren't
  // this bot's business either).
  bapi.get('/channels/:id/messages', (req, res) => {
    const { c, inst } = botChannel(req, req.params.id, 'messages.read.metadata');
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const rows = req.query.before
      ? db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(c.id, String(req.query.before), limit)
      : db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(c.id, limit);
    markOk(inst.id);
    res.json({ messages: rows.map((m) => metaOf(m, c)) });
  });
  bapi.post('/channels/:id/messages', (req, res) => {
    const { c, inst } = botChannel(req, req.params.id, 'messages.send');
    if (c.type !== 'text') fail(400, 'Bots can only post in text channels.', 'bad_channel');
    const content = cleanContent((req.body || {}).content);
    const row = postAsBot(req.bot, inst, c, content, (req.body || {}).replyTo);
    res.json({ message: { ...metaOf(row, c), content } });
  });
  bapi.patch('/messages/:id', (req, res) => {
    const { m, c, inst } = botMessage(req, req.params.id, 'messages.send');
    if (m.author_id !== req.bot.id) fail(403, 'Bots can only edit their own messages.', 'not_author');
    const content = cleanContent((req.body || {}).content);
    rateLimit(`botmsg:${req.bot.id}:${c.id}`, 10, 10000);
    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(seal({ content, attachments: [], bot: true }), now(), m.id);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id);
    toChannel(c).emit('message:update', serializeMessage(row, c));
    markOk(inst.id);
    res.json({ message: { ...metaOf(row, c), content } });
  });
  bapi.delete('/messages/:id', (req, res) => {
    const { m, c, inst } = botMessage(req, req.params.id, 'messages.send');
    if (m.author_id !== req.bot.id) fail(403, 'Bots can only delete their own messages.', 'not_author');
    deleteMessageTree(m.id);
    toChannel(c).emit('message:delete', { id: m.id, channelId: c.id, threadId: m.thread_id || null });
    event('message.deleted', c.server_id, { messageId: m.id, channelId: c.id, authorId: m.author_id, threadId: m.thread_id || null, deletedBy: req.bot.id }, { channel: c, actorId: req.bot.id });
    markOk(inst.id);
    res.json({ ok: true });
  });
  const reactionTarget = (req) => {
    const r = botMessage(req, req.params.id, 'reactions.write');
    const emoji = String(req.params.emoji || '');
    if (!emoji || emoji.length > 64) fail(400, 'Pick an emoji (up to 64 characters).', 'bad_emoji');
    return { ...r, emoji };
  };
  const emitReactions = (c, m) => toChannel(c).emit('reaction:update', { messageId: m.id, channelId: c.id, reactions: reactionsFor([m.id])[m.id] || [] });
  bapi.put('/messages/:id/reactions/:emoji', (req, res) => {
    const { m, c, inst, emoji } = reactionTarget(req);
    rateLimit('botreact:' + req.bot.id, 20, 10000);
    if (!db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.bot.id, emoji)) {
      if (db.prepare('SELECT COUNT(DISTINCT emoji) n FROM reactions WHERE message_id = ?').get(m.id).n >= 20) fail(400, 'That message has too many different reactions.', 'too_many_reactions');
      db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(m.id, req.bot.id, emoji, now());
      emitReactions(c, m);
      event('reaction.added', c.server_id, { messageId: m.id, channelId: c.id, userId: req.bot.id, emoji }, { channel: c, actorId: req.bot.id });
    }
    markOk(inst.id);
    res.json({ ok: true });
  });
  bapi.delete('/messages/:id/reactions/:emoji', (req, res) => {
    const { m, c, inst, emoji } = reactionTarget(req);
    if (db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.bot.id, emoji).changes) emitReactions(c, m);
    markOk(inst.id);
    res.json({ ok: true });
  });
  // Slash commands belong to the bot (the same list everywhere it's installed); an installation only offers
  // them if it granted the commands scope. So only a whole-bot token can change them.
  bapi.get('/commands', (req, res) => {
    res.json({ commands: db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY name').all(req.bot.id).map(commandOut) });
  });
  bapi.put('/commands', (req, res) => {
    if (req.botToken.installation_id) fail(403, 'Registering commands needs a whole-bot token, not one made for a single server.', 'bot_token_needed');
    rateLimit('botcmds:' + req.bot.id, 10, 60000);
    const list = cleanCommands((req.body || {}).commands);
    db.transaction(() => {
      db.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(req.bot.id);
      const add = db.prepare('INSERT INTO bot_commands (bot_id, name, description, options, permission, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      list.forEach((c) => add.run(req.bot.id, c.name, c.description, JSON.stringify(c.options), c.permission, now()));
    })();
    res.json({ commands: list });
  });
  // Answering a slash command (see "slash commands" below).
  bapi.post('/interactions/:id/callback', (req, res) => {
    const it = interactions.get(String(req.params.id));
    if (!it || it.botId !== req.bot.id || (req.botToken.installation_id && req.botToken.installation_id !== it.installationId)) fail(404, 'No such interaction.', 'unknown_interaction');
    if (it.done || now() > it.expires) fail(410, 'Too late: the person was already told the bot didn’t answer.', 'interaction_expired');
    const b = req.body || {};
    const content = cleanContent(b.content);
    const inst = myInstall(req, { id: it.installationId });
    needScope(inst, 'commands');
    if (b.ephemeral) {
      // Only the person who ran the command sees it, on the connection they ran it from. Never stored.
      finish(it, 'ok', { ephemeral: { content } });
      markOk(inst.id);
      return res.json({ ok: true, ephemeral: true });
    }
    const { c } = botChannel(req, it.channelId, 'messages.send');
    const row = postAsBot(req.bot, inst, c, content, null);
    finish(it, 'ok', { messageId: row.id });
    res.json({ ok: true, message: { ...metaOf(row, c), content } });
  });
  // Deliveries for one installation (webhooks.manage).
  bapi.put('/installations/:id/events', (req, res) => {
    const inst = myInstall(req, { id: req.params.id });
    needScope(inst, 'webhooks.manage');
    const v = (req.body || {}).events;
    let events = null;
    if (v !== null && v !== undefined) {
      if (!Array.isArray(v) || v.some((e) => !Object.hasOwn(EVENTS, e))) fail(400, `Events must be a list of: ${Object.keys(EVENTS).join(', ')} (or null for all).`, 'bad_events');
      events = [...new Set(v)];
    }
    db.prepare('UPDATE bot_installations SET events = ? WHERE id = ?').run(events ? JSON.stringify(events) : null, inst.id);
    markOk(inst.id);
    res.json(instOut(db.prepare('SELECT * FROM bot_installations WHERE id = ?').get(inst.id)));
  });
  bapi.get('/installations/:id/deliveries', (req, res) => {
    const inst = myInstall(req, { id: req.params.id });
    needScope(inst, 'webhooks.manage');
    res.json(deliveriesOf(inst));
  });
  bapi.post('/installations/:id/deliveries/retry', (req, res) => {
    const inst = myInstall(req, { id: req.params.id });
    needScope(inst, 'webhooks.manage');
    rateLimit('botretry:' + req.bot.id, 20, 60000);
    res.json({ retried: retryDead(inst, (req.body || {}).ids) });
  });
  bapi.use((req, res) => res.status(404).json({ error: 'No such bot API route.', code: 'not_found' }));
  // Bot API errors are always { error, code }.
  bapi.use((err, req, res, next) => {
    if (!(err instanceof HttpError)) return next(err);
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    res.status(err.status).json({ error: err.message, code: err.code || ERROR_CODES[err.status] || 'error' });
  });
  api.use('/bot/v1', bapi);

  // Every people-side route counts against one allowance (the busier ones have their own on top).
  const limitUi = (req, res, next) => { try { rateLimit('botui:' + req.userId, 120, 60000); next(); } catch (e) { next(e); } };

  // ------------------------------------------------------------------ slash commands (people's side)
  // In memory only: an interaction lives for BOT_INTERACTION_TIMEOUT_MS (10 s), then the person is told the bot
  // didn't answer. Nothing a person typed after a command is written to the database.
  const interactions = new Map();
  function finish(it, status, extra = {}) {
    if (it.done) return;
    it.done = true;
    clearTimeout(it.timer);
    setTimeout(() => interactions.delete(it.id), 60000).unref();
    const sock = it.socketId && io().sockets.sockets.get(it.socketId);
    const target = sock && sock.userId === it.userId ? it.socketId : `user:${it.userId}`;
    io().to(target).emit('bot:interaction', { interactionId: it.id, botId: it.botId, channelId: it.channelId, command: it.command, status, ...extra });
  }
  // The commands someone may use in a channel: from bots installed in its server with the commands scope, allowed
  // in this channel, whose required permission they have.
  function commandsIn(c, srv, userId) {
    const rows = db.prepare(`SELECT k.*, i.id AS installation_id, i.scopes, i.channels, i.server_id FROM bot_commands k
        JOIN bot_installations i ON i.bot_id = k.bot_id JOIN bots b ON b.id = k.bot_id
        WHERE i.server_id = ? AND i.enabled = 1 AND b.disabled = 0 AND b.webhook_url IS NOT NULL ORDER BY k.name`).all(c.server_id);
    return rows.filter((r) => hasScope(r, 'commands') && channelAllowed(r, c, srv) && (!r.permission || (perms.channel(srv, c, userId) & PM[r.permission]) === PM[r.permission]));
  }
  api.get('/channels/:id/commands', auth, limitUi, (req, res) => {
    const c = requireChannel(req.params.id, req.userId);
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
    if (c.type !== 'text' || !(perms.channel(srv, c, req.userId) & PM.SEND_MESSAGES)) return res.json({ commands: [] });
    res.json({ commands: commandsIn(c, srv, req.userId).map((r) => ({ botId: r.bot_id, botName: (botRow(r.bot_id) || {}).name || '', ...commandOut(r) })) });
  });
  api.post('/channels/:id/commands', auth, limitUi, (req, res) => {
    const c = requireChannel(req.params.id, req.userId);
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
    if (c.type !== 'text') fail(400, 'Commands work in text channels.', 'bad_channel');
    if (!(perms.channel(srv, c, req.userId) & PM.SEND_MESSAGES)) fail(403, 'You don’t have permission to send messages here.', 'forbidden');
    rateLimit('cmd:' + req.userId, 20, 10000);
    const b = req.body || {};
    const cmd = db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? AND name = ?').get(String(b.botId || ''), String(b.name || ''));
    const inst = cmd && installRow(cmd.bot_id, c.server_id);
    const bot = cmd && botRow(cmd.bot_id);
    if (!cmd || !inst || !inst.enabled || !botUsable(bot) || !bot.webhook_url || !hasScope(inst, 'commands') || !channelAllowed(inst, c, srv)) fail(404, 'That command isn’t available here.', 'unknown_command');
    if (cmd.permission && (perms.channel(srv, c, req.userId) & PM[cmd.permission]) !== PM[cmd.permission]) fail(403, `You need the ${cmd.permission.replace(/_/g, ' ').toLowerCase()} permission to use /${cmd.name}.`, 'missing_permission');
    // The app shows a warning first: what's typed after a command goes to the bot without end-to-end encryption.
    if (b.ack !== true) fail(400, 'This sends what you typed to the bot without end-to-end encryption. Confirm that first.', 'needs_ack');
    const args = checkArgs(cmd, b.args, srv, req.userId);
    rateLimit('cmdbot:' + bot.id, 60, 10000);
    const timeout = cfg().interactionTimeout;
    const it = { id: `in_${crypto.randomBytes(18).toString('base64url')}`, botId: bot.id, installationId: inst.id, serverId: c.server_id, channelId: c.id, userId: req.userId,
      socketId: typeof b.socketId === 'string' ? b.socketId.slice(0, 64) : null, command: cmd.name, expires: now() + timeout, done: false };
    it.timer = setTimeout(() => finish(it, 'timeout'), timeout);
    it.timer.unref();
    interactions.set(it.id, it);
    // Sent once, straight away, never queued (a retry would arrive after the person stopped waiting).
    const e = envelope('command.invoked', bot, inst, { interactionId: it.id, command: cmd.name, args, channelId: c.id, userId: req.userId, respondBy: it.expires });
    post(bot, 'command.invoked', e.id, e.body, Math.min(timeout, cfg().timeout)).then((r) => {
      if (r.ok) markOk(inst.id);
      else { markError(inst.id, r.error); finish(it, 'failed', { error: 'The bot couldn’t be reached.' }); }
    });
    res.status(202).json({ interactionId: it.id, respondBy: it.expires });
  });

  // ------------------------------------------------------------------ managing bots (people's side)
  const canCreate = (uid) => {
    const who = features().createBots || 'admins';
    return who === 'everyone' || (who === 'staff' && isStaff(uid)) || isInstanceAdmin(uid);
  };
  const myBot = (id, uid, { admin = false } = {}) => {
    const b = botRow(id);
    if (!b || !(b.owner_id === uid || (admin && isInstanceAdmin(uid)))) fail(404, 'No such bot.');
    return b;
  };
  const botBrief = (b) => ({ id: b.id, name: b.name, description: b.description, avatar: b.avatar || null, requestedScopes: parseList(b.requested_scopes), listed: !!b.listed,
    disabled: !!b.disabled, ownerId: b.owner_id, ownerName: ((b.owner_id && getUserRow(b.owner_id)) || {}).username || null, username: (getUserRow(b.id) || {}).username, createdAt: b.created_at });
  const botFull = (b) => ({ ...botBrief(b), webhookUrl: b.webhook_url || '',
    tokens: db.prepare('SELECT * FROM bot_tokens WHERE bot_id = ? ORDER BY created_at DESC LIMIT 50').all(b.id).map(tokenOut),
    installations: db.prepare('SELECT i.*, s.name AS server_name FROM bot_installations i JOIN servers s ON s.id = i.server_id WHERE i.bot_id = ? ORDER BY i.created_at').all(b.id)
      .map((i) => ({ id: i.id, serverId: i.server_id, serverName: i.server_name, health: health(i), lastOkAt: i.last_ok_at, lastError: i.last_error })),
    commands: db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY name').all(b.id).map(commandOut) });
  const cleanName = (v) => {
    const n = String(v || '').trim().replace(/\s+/g, ' ').slice(0, 32);
    if (n.length < 2) fail(400, 'Give the bot a name (2–32 characters).');
    return n;
  };
  // A bot's username: its name made safe, with "_bot" on the end, numbered if taken.
  function freeUsername(name) {
    const base = (name.toLowerCase().replace(/[^a-z0-9_.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 16) || 'bot') + '_bot';
    let u = base;
    for (let i = 2; db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(u); i++) u = `${base}${i}`;
    return u;
  }
  const syncUser = (b) => {
    const u = getUserRow(b.id);
    let p = {};
    try { p = JSON.parse(u.profile || '{}'); } catch { /* */ }
    db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify({ ...p, displayName: b.name, bio: b.description.slice(0, 190) }), b.id);
  };
  // Everyone in the servers it's in sees the change (the member list shows bots).
  const refreshServers = (botId) => {
    const pu = publicUser(getUserRow(botId));
    for (const r of db.prepare('SELECT server_id FROM bot_installations WHERE bot_id = ?').all(botId)) { io().to(`server:${r.server_id}`).emit('user:update', pu); emitServer(r.server_id); }
  };

  api.get('/bots', auth, limitUi, (req, res) => {
    const mine = db.prepare('SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at').all(req.userId).map(botFull);
    // What can be installed: bots listed on this instance by their makers, and your own.
    const available = db.prepare('SELECT * FROM bots WHERE disabled = 0 AND (listed = 1 OR owner_id = ?) ORDER BY name COLLATE NOCASE LIMIT 200').all(req.userId).map(botBrief);
    res.json({ canCreate: canCreate(req.userId), scopes: SCOPES, events: Object.keys(EVENTS), argTypes: ARG_TYPES, mine, available });
  });
  api.post('/bots', auth, limitUi, wrap(async (req, res) => {
    if (!canCreate(req.userId)) fail(403, 'On this Hearth, only some people can create bots. Ask an admin.');
    rateLimit('botcreate:' + req.userId, 10, 3600000);
    const b = req.body || {};
    const name = cleanName(b.name);
    const description = String(b.description || '').trim().slice(0, 300);
    checkWords(name, description);
    const requested = cleanScopes(b.scopes || []);
    const webhook = await checkWebhookUrl(b.webhookUrl);
    if (db.prepare('SELECT COUNT(*) n FROM bots WHERE owner_id = ?').get(req.userId).n >= 25) fail(400, 'You can have up to 25 bots.');
    const id = newId();
    const secret = crypto.randomBytes(32).toString('base64url');
    let token;
    db.transaction(() => {
      db.prepare(`INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, profile, created_at, is_bot) VALUES (?, ?, ?, '', '', ?, ?, 1)`)
        .run(id, freeUsername(name), `!${crypto.randomBytes(16).toString('hex')}`, JSON.stringify({ displayName: name, bio: description.slice(0, 190) }), now());
      db.prepare('INSERT INTO bots (id, owner_id, name, description, webhook_url, webhook_secret, requested_scopes, listed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, req.userId, name, description, webhook, sealSecret(secret), JSON.stringify(requested), b.listed ? 1 : 0, now());
      token = issueToken(id, null, req.userId);
    })();
    auditLog(req, 'bot_created', id, name);
    auditLog(req, 'bot_token_created', id, `token ${token.id} (whole bot)`);
    // The token and the webhook secret are shown this once: only a hash of the token is kept.
    res.json({ bot: botFull(botRow(id)), token: token.token, webhookSecret: secret });
  }));
  api.patch('/bots/:id', auth, limitUi, wrap(async (req, res) => {
    const b = req.body || {};
    // Instance admins can switch any bot off (abuse); everything else is its maker's.
    const bot = myBot(req.params.id, req.userId, { admin: b.disabled !== undefined && Object.keys(b).every((k) => k === 'disabled') });
    if (b.name !== undefined || b.description !== undefined) {
      const name = b.name !== undefined ? cleanName(b.name) : bot.name;
      const description = b.description !== undefined ? String(b.description || '').trim().slice(0, 300) : bot.description;
      checkWords(name, description);
      db.prepare('UPDATE bots SET name = ?, description = ? WHERE id = ?').run(name, description, bot.id);
    }
    if (b.webhookUrl !== undefined) db.prepare('UPDATE bots SET webhook_url = ? WHERE id = ?').run(await checkWebhookUrl(b.webhookUrl), bot.id);
    // Asking for more scopes changes nothing by itself: each server approves them before they apply there.
    if (b.scopes !== undefined) db.prepare('UPDATE bots SET requested_scopes = ? WHERE id = ?').run(JSON.stringify(cleanScopes(b.scopes)), bot.id);
    if (b.listed !== undefined) db.prepare('UPDATE bots SET listed = ? WHERE id = ?').run(b.listed ? 1 : 0, bot.id);
    if (b.disabled !== undefined && !!b.disabled !== !!bot.disabled) {
      db.prepare('UPDATE bots SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, bot.id);
      auditLog(req, b.disabled ? 'bot_disabled' : 'bot_enabled', bot.id, bot.name);
    }
    const next = botRow(bot.id);
    syncUser(next);
    refreshServers(bot.id);
    res.json(botFull(next));
  }));
  // A new token (optionally for one installation), shown once. rotate: true also revokes the others of the same
  // kind, in one step, so swapping a leaked token leaves no gap and no leftover.
  api.post('/bots/:id/tokens', auth, limitUi, wrap(async (req, res) => {
    const bot = myBot(req.params.id, req.userId);
    rateLimit('bottoken:' + req.userId, 20, 3600000);
    await stepUp(req, req.body);
    const b = req.body || {};
    let instId = null;
    if (b.installationId) {
      const inst = db.prepare('SELECT * FROM bot_installations WHERE id = ? AND bot_id = ?').get(String(b.installationId), bot.id);
      if (!inst) fail(404, 'This bot isn’t installed there.');
      instId = inst.id;
    }
    let token; let revoked = 0;
    db.transaction(() => {
      if (b.rotate) {
        revoked = db.prepare(`UPDATE bot_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL AND ${instId ? 'installation_id = ?' : 'installation_id IS NULL'}`)
          .run(now(), bot.id, ...(instId ? [instId] : [])).changes;
      }
      if (db.prepare('SELECT COUNT(*) n FROM bot_tokens WHERE bot_id = ? AND revoked_at IS NULL').get(bot.id).n >= 10) fail(400, 'A bot can have up to 10 working tokens. Revoke one first.');
      token = issueToken(bot.id, instId, req.userId);
    })();
    auditLog(req, b.rotate ? 'bot_token_rotated' : 'bot_token_created', bot.id, `token ${token.id}${instId ? ` (installation ${instId})` : ' (whole bot)'}${b.rotate ? `, ${revoked} revoked` : ''}`);
    res.json({ token: token.token, id: token.id, revoked, bot: botFull(botRow(bot.id)) });
  }));
  api.delete('/bots/:id/tokens/:tid', auth, limitUi, (req, res) => {
    const bot = myBot(req.params.id, req.userId);
    const t = db.prepare('SELECT * FROM bot_tokens WHERE id = ? AND bot_id = ?').get(String(req.params.tid), bot.id);
    if (!t) fail(404, 'No such token.');
    if (!t.revoked_at) {
      db.prepare('UPDATE bot_tokens SET revoked_at = ? WHERE id = ?').run(now(), t.id);
      auditLog(req, 'bot_token_revoked', bot.id, `token ${t.id}`);
    }
    res.json(botFull(botRow(bot.id)));
  });
  api.post('/bots/:id/webhook-secret', auth, limitUi, wrap(async (req, res) => {
    const bot = myBot(req.params.id, req.userId);
    await stepUp(req, req.body);
    const secret = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE bots SET webhook_secret = ? WHERE id = ?').run(sealSecret(secret), bot.id);
    auditLog(req, 'bot_webhook_secret_rotated', bot.id, bot.name);
    res.json({ webhookSecret: secret });
  }));
  api.delete('/bots/:id', auth, limitUi, (req, res) => {
    const bot = myBot(req.params.id, req.userId, { admin: true });
    const servers = db.prepare('SELECT server_id FROM bot_installations WHERE bot_id = ?').all(bot.id).map((r) => r.server_id);
    // Its account stays (as deleted) so the messages it posted still have an author; it can't come back.
    db.transaction(() => {
      db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
      db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(now(), bot.id);
    })();
    for (const it of interactions.values()) if (it.botId === bot.id) finish(it, 'failed', { error: 'The bot was removed.' });
    auditLog(req, 'bot_deleted', bot.id, bot.name);
    servers.forEach((s) => emitServer(s));
    res.json({ ok: true });
  });
  api.get('/admin/bots', auth, limitUi, (req, res) => {
    if (!isInstanceAdmin(req.userId)) fail(403, 'Only admins can see this.');
    res.json({ bots: db.prepare('SELECT * FROM bots ORDER BY created_at DESC LIMIT 500').all().map((b) => ({ ...botBrief(b),
      installs: db.prepare('SELECT COUNT(*) n FROM bot_installations WHERE bot_id = ?').get(b.id).n })) });
  });

  // ------------------------------------------------------------------ installing (server owners / Manage Server)
  const requireManager = (serverId, uid) => {
    const s = requireServer(serverId, uid);
    if (s.kind === 'group') fail(400, 'Bots can’t be added to group chats.');
    if ((perms.base(s, uid) & PM.MANAGE_SERVER) !== PM.MANAGE_SERVER) fail(403, 'Only people who can manage this server can add or change bots.');
    return s;
  };
  const installedOut = (inst) => {
    const b = botRow(inst.bot_id);
    const granted = scopesOf(inst);
    return { ...instOut(inst), bot: botBrief(b), health: health(inst), lastOkAt: inst.last_ok_at, lastError: inst.last_error, lastErrorAt: inst.last_error_at,
      installedBy: inst.installed_by, webhook: !!b.webhook_url, pendingScopes: parseList(b.requested_scopes).filter((s) => !granted.includes(s)), channels: inst.channels === '"*"' ? '*' : parseList(inst.channels) };
  };
  api.get('/servers/:id/bots', auth, limitUi, (req, res) => {
    const s = requireManager(req.params.id, req.userId);
    const feeds = db.prepare('SELECT COUNT(*) n, SUM(paused = 0) live, MAX(last_ok) ok FROM feeds WHERE server_id = ?').get(s.id);
    res.json({
      // The news bot is built in: it lives in its own tab and tables, and shows up here so the list is complete.
      builtIn: [{ id: newsBot, name: 'News', description: 'Posts new articles, videos and updates from the feeds this server follows.', feeds: feeds.n || 0, active: (feeds.live || 0) > 0, lastOkAt: feeds.ok || null }],
      installed: db.prepare('SELECT * FROM bot_installations WHERE server_id = ? ORDER BY created_at').all(s.id).map(installedOut),
      scopes: SCOPES,
    });
  });
  // Installing needs the person to have approved exactly these scopes and channels in the app's dialog
  // (confirm: true); nothing is granted that the bot didn't ask for.
  api.post('/servers/:id/bots', auth, limitUi, (req, res) => {
    const s = requireManager(req.params.id, req.userId);
    rateLimit('botinstall:' + req.userId, 30, 3600000);
    const b = req.body || {};
    const bot = botRow(b.botId);
    if (!bot || bot.disabled || !(bot.listed || bot.owner_id === req.userId)) fail(404, 'No such bot.');
    if (installRow(bot.id, s.id)) fail(409, 'That bot is already in this server.');
    const scopes = cleanScopes(b.scopes || [], { from: parseList(bot.requested_scopes) });
    const channels = cleanChannels(b.channels === undefined ? [] : b.channels, s, req.userId);
    if (b.confirm !== true) fail(400, 'Approve the bot’s access first.', 'needs_approval');
    if (db.prepare('SELECT COUNT(*) n FROM bot_installations WHERE server_id = ?').get(s.id).n >= 25) fail(400, 'Up to 25 bots per server.');
    const id = newId();
    db.prepare('INSERT INTO bot_installations (id, bot_id, server_id, installed_by, scopes, channels, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, bot.id, s.id, req.userId, JSON.stringify(scopes), JSON.stringify(channels), now());
    auditLog(req, 'bot_installed', s.id, `${bot.name} (${bot.id}): ${scopes.join(' ') || 'no scopes'}; channels ${channels === '*' ? 'all public' : channels.length}`);
    const inst = db.prepare('SELECT * FROM bot_installations WHERE id = ?').get(id);
    if (bot.webhook_url) enqueue('bot.installed', bot, inst, { serverId: s.id, serverName: s.name, scopes, channelIds: allowedChannels(inst).map((c) => c.id), allChannels: channels === '*', installedBy: req.userId });
    io().to(`server:${s.id}`).emit('user:update', publicUser(getUserRow(bot.id)));
    emitServer(s.id);
    res.json(installedOut(inst));
  });
  // Changing access. Taking things away never needs approval; adding scopes or channels does (confirm: true).
  api.patch('/servers/:id/bots/:botId', auth, limitUi, (req, res) => {
    const s = requireManager(req.params.id, req.userId);
    const inst = installRow(String(req.params.botId), s.id);
    if (!inst) fail(404, 'That bot isn’t in this server.');
    const bot = botRow(inst.bot_id);
    const b = req.body || {};
    const oldScopes = scopesOf(inst);
    const scopes = b.scopes !== undefined ? cleanScopes(b.scopes, { from: [...new Set([...parseList(bot.requested_scopes), ...oldScopes])] }) : oldScopes;
    const channels = b.channels !== undefined ? cleanChannels(b.channels, s, req.userId) : (allChannels(inst) ? '*' : channelIds(inst));
    const added = scopes.filter((x) => !oldScopes.includes(x));
    const oldIds = allChannels(inst) ? null : channelIds(inst);
    const moreChannels = channels === '*' ? oldIds !== null : oldIds !== null && channels.some((x) => !oldIds.includes(x));
    if ((added.length || moreChannels) && b.confirm !== true) return res.status(400).json({ error: 'Approve the extra access first.', code: 'needs_approval', added, moreChannels });
    const changes = [];
    if (b.scopes !== undefined || b.channels !== undefined) {
      db.prepare('UPDATE bot_installations SET scopes = ?, channels = ? WHERE id = ?').run(JSON.stringify(scopes), JSON.stringify(channels), inst.id);
      changes.push(`scopes ${scopes.join(' ') || 'none'}; channels ${channels === '*' ? 'all public' : channels.length}`);
    }
    if (b.enabled !== undefined && !!b.enabled !== !!inst.enabled) {
      db.prepare('UPDATE bot_installations SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, inst.id);
      changes.push(b.enabled ? 'resumed' : 'paused');
    }
    if (changes.length) auditLog(req, 'bot_access_changed', s.id, `${bot.name} (${bot.id}): ${changes.join(', ')}`);
    emitServer(s.id);
    res.json(installedOut(db.prepare('SELECT * FROM bot_installations WHERE id = ?').get(inst.id)));
  });
  api.delete('/servers/:id/bots/:botId', auth, limitUi, (req, res) => {
    const s = requireManager(req.params.id, req.userId);
    const inst = installRow(String(req.params.botId), s.id);
    if (!inst) fail(404, 'That bot isn’t in this server.');
    const bot = botRow(inst.bot_id);
    // Its tokens made for this server and its undelivered events go with it.
    db.transaction(() => {
      db.prepare('DELETE FROM bot_deliveries WHERE installation_id = ?').run(inst.id);
      db.prepare('DELETE FROM bot_installations WHERE id = ?').run(inst.id);
    })();
    for (const it of interactions.values()) if (it.installationId === inst.id) finish(it, 'failed', { error: 'The bot was removed from this server.' });
    if (bot.webhook_url) enqueue('bot.uninstalled', bot, inst, { serverId: s.id });
    auditLog(req, 'bot_uninstalled', s.id, `${bot.name} (${bot.id})`);
    emitServer(s.id);
    res.json({ ok: true });
  });
  const managedInstall = (req) => {
    const s = requireManager(req.params.id, req.userId);
    const inst = installRow(String(req.params.botId), s.id);
    if (!inst) fail(404, 'That bot isn’t in this server.');
    return inst;
  };
  api.get('/servers/:id/bots/:botId/deliveries', auth, limitUi, (req, res) => res.json(deliveriesOf(managedInstall(req))));
  api.post('/servers/:id/bots/:botId/deliveries/retry', auth, limitUi, (req, res) => {
    const inst = managedInstall(req);
    rateLimit('botretry:' + req.userId, 30, 60000);
    res.json({ retried: retryDead(inst, (req.body || {}).ids) });
  });
  api.delete('/servers/:id/bots/:botId/deliveries/dead', auth, limitUi, (req, res) => res.json({ cleared: clearDead(managedInstall(req)) }));

  return { event, serverBots, SCOPES, EVENTS, sign, pump };
};
module.exports.sign = sign;
module.exports.SCOPES = SCOPES;
module.exports.EVENTS = EVENTS;
