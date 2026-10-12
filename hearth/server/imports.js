// Imports into Hearth (docs/IMPORT.md). Phase 1: start a new server from a Discord server's structure. The person
// pastes the server template's JSON (or just its serialized_source_guild); Hearth shows what it would make and what
// won't come over, then creates it in one go.
//
// Hearth never contacts Discord here: the person opens the template in their own browser and pastes what it shows.
// The mapping (server/discordmap.js) runs on the server for the preview and again on create, so an app can't send
// back a plan that grants more than the template did.
//
// Routes
//   POST /imports/discord/preview  { template, name?, skipRoles?, skipChannels? }  → { source, plan }; creates nothing
//   POST /imports/discord          the same, plus allowEveryoneAdmin?             → the new server, like POST /servers
//   GET  /servers/:id/imports      what was imported into a server (owner and Administrators)
//
// Who and how much:
//   - the same people who may create servers (Admin → Owner → "Who can create servers"), with the same words;
//   - the importer owns the NEW server and is its only member until they invite people. It gets its key like any new
//     server (no key yet; the first app to open it makes one), so the import changes nothing about encryption;
//   - 60 previews per 10 minutes and 5 imported servers an hour per account, 30 create attempts an hour, a
//     per-network ceiling across accounts and one for the whole instance (a plan of a big template takes a moment
//     of the server's time, so many at once would hold everyone else up). The instance ceiling bounds the server's
//     time (every template read counts) and is shared fairly: past half of it, only accounts that have had few plans
//     this window get more, so a handful of accounts can't use it up and lock everyone else out;
//   - Hearth's own limits for one server: 99 roles besides @everyone, 50 categories, 100 overrides per channel, at
//     most 500 channels and 5,000 overrides per import. Requests are capped at 2 MB like every JSON request.
const { ImportError, parseTemplate, planFromTemplate } = require('./discordmap');

// Keys of roles and channels to leave out, as the preview gave them: Discord ids or placeholders (digits), or the
// importer's own stand-ins for missing ids (r12, c12).
const KEY = /^(?:\d{1,25}|[rc]\d{1,4})$/;
const CREATIONS_PER_HOUR = 5;
// The report kept with the server: its lists of names are already cut short, but the skipped list can still be
// long (hundreds of roles and channels with long names).
const REPORT_MAX = 128 * 1024;
const PROBLEM = {
  too_many_channels: (p) => `That's ${p.count} channels; Hearth imports up to ${p.max} at once. Leave some out.`,
  too_many_categories: (p) => `That's ${p.count} categories; a Hearth server has up to ${p.max}. Leave some channels out.`,
  too_many_overrides: (p) => `That's ${p.count} channel permissions; Hearth imports up to ${p.max} at once. Leave some channels or roles out.`,
};

module.exports = function setupImports(ctx) {
  const { api, auth, db, fail, rateLimit, limitNet, countHit, hitsSoFar, newId, now, features, isStaff, ALL, CHANNEL_SCOPED, PM,
    serializeServer, keyState, getIo, auditLog, requirePerm } = ctx;

  // The same rule and words as POST /servers.
  function mayCreate(req) {
    if (features().createServers === 'staff' && !isStaff(req.userId)) fail(403, 'On this Hearth, only staff can create servers. Ask an admin.');
  }
  function keySet(v, max) {
    if (v === undefined || v === null) return new Set();
    if (!Array.isArray(v) || v.length > max) fail(400, 'That list of things to leave out is too long.', 'bad_request');
    return new Set(v.filter((k) => typeof k === 'string' && KEY.test(k)));
  }
  // req: whose plan it is (counted toward the instance ceiling once the template is going to be read).
  function planOf(body, req) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (b.template === undefined || b.template === null) fail(400, 'Paste the server template first.', 'bad_template');
    if (b.name !== undefined && typeof b.name !== 'string') fail(400, 'Give your server a name.', 'bad_request');
    countAll(req);
    let parsed;
    try { parsed = parseTemplate(b.template); } catch (e) {
      if (e instanceof ImportError) fail(400, e.message, e.code);
      throw e;
    }
    const plan = planFromTemplate(parsed.guild, { name: b.name, skipRoles: keySet(b.skipRoles, 300), skipChannels: keySet(b.skipChannels, 600) });
    return { meta: parsed.meta, plan };
  }
  const sourceOf = (meta) => ({ kind: 'paste', template: meta.template, code: meta.code, name: meta.name, usageCount: meta.usageCount, updatedAt: meta.updatedAt, isDirty: meta.isDirty });
  // Previews and creates together, for everyone on this instance: a safety valve for the server's time. Every request
  // that has a template to read counts (a large one that turns out unreadable can cost as much as a plan), and past
  // ALL_MAX in a window nobody gets more: at most ALL_MAX plans per 10 minutes, however many accounts ask.
  // So that a few accounts can't use that up and lock everyone else out, it's shared: once BUSY plans were made in
  // the window, only accounts that have had fewer than SHARE this window (their own count, 'dimp:share:') get more.
  // Using it all up then takes BUSY plans from anyone (60 an account and 120 a network: at least 9 accounts on 5
  // networks) and then (ALL_MAX - BUSY) / SHARE more accounts that haven't had their share, at least 34 accounts on
  // 9 networks every 10 minutes, while someone importing for real gets up to SHARE plans even then.
  const ALL_WINDOW = 600000; const ALL_MAX = 1000; const BUSY = 500; const SHARE = 20;
  function checkAll(req) {
    rateLimit('dimp:all', ALL_MAX - 1, ALL_WINDOW, 0); // a cost of 0 only checks: refused once ALL_MAX were made
    if (hitsSoFar('dimp:all') >= BUSY) rateLimit('dimp:share:' + req.userId, SHARE - 1, ALL_WINDOW, 0);
  }
  const countAll = (req) => { countHit('dimp:all', ALL_WINDOW); countHit('dimp:share:' + req.userId, ALL_WINDOW); };
  // What the app shows: everything but each channel's overrides (counted instead) and the per-permission notes,
  // which the report already gathers. A big template's preview stays small, every time a box is ticked.
  const slim = (plan) => ({
    ...plan,
    channels: plan.channels.map(({ overrides, notes, ...c }) => ({ ...c, overrides: overrides.length, notes: notes.filter((n) => !n.includes(':')) })),
  });

  api.post('/imports/discord/preview', auth, (req, res) => {
    mayCreate(req);
    rateLimit('dimp:' + req.userId, 60, 600000);
    limitNet(req, 'dimp', 120, 600000);
    checkAll(req);
    const { meta, plan } = planOf(req.body, req);
    res.json({ source: sourceOf(meta), plan: slim(plan) });
  });

  api.post('/imports/discord', auth, (req, res) => {
    mayCreate(req);
    rateLimit('dimpa:' + req.userId, 30, 3600000);
    limitNet(req, 'dimp', 120, 600000);
    checkAll(req);
    // Five servers an hour: refused here once five were made (a cost of 0 only checks), counted once one exists, so
    // a refused attempt doesn't use one up.
    rateLimit('dimpc:' + req.userId, CREATIONS_PER_HOUR - 1, 3600000, 0);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) fail(400, 'Give your server a name.', 'bad_request');
    const { meta, plan } = planOf(b, req);
    const tooMany = plan.problems[0];
    if (tooMany) fail(400, PROBLEM[tooMany.code](tooMany), tooMany.code);
    if (plan.everyone.dangerous && b.allowEveryoneAdmin !== true) {
      fail(400, 'In this template @everyone is an Administrator, so everyone who joins could do anything. Confirm that to go ahead.', 'everyone_admin');
    }
    const id = newId();
    const importId = newId();
    const t = now();
    const roleIds = new Map();
    const channelIds = new Map();
    let stored = JSON.stringify(plan.report);
    if (stored.length > REPORT_MAX) {
      const skipped = plan.report.skipped;
      stored = JSON.stringify({ ...plan.report, skipped: skipped.slice(0, 100).map((x) => ({ ...x, name: String(x.name).slice(0, 48) })), skippedMore: Math.max(0, skipped.length - 100) });
    }
    db.transaction(() => {
      db.prepare('INSERT INTO servers (id, name, icon, owner_id, created_at, description, category_order) VALUES (?, ?, NULL, ?, ?, ?, ?)')
        .run(id, plan.name, req.userId, t, plan.description, JSON.stringify(plan.categoryOrder));
      db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, req.userId, t);
      // @everyone is the role with the server's id, as for every server.
      db.prepare(`INSERT INTO roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, '@everyone', 0, ?, ?)`).run(id, id, plan.everyone.permissions & ALL, t);
      const addRole = db.prepare('INSERT INTO roles (id, server_id, name, color, icon, position, permissions, hoist, mentionable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of plan.roles) {
        if (r.skip) continue;
        const rid = newId();
        roleIds.set(r.key, rid);
        addRole.run(rid, id, r.name, r.color, r.icon, r.position, r.permissions & ALL, r.hoist ? 1 : 0, r.mentionable ? 1 : 0, t);
      }
      const addChannel = db.prepare('INSERT INTO channels (id, server_id, name, type, topic, position, created_at, category, slowmode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const addOverride = db.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, ?, ?)");
      for (const c of plan.channels) {
        const cid = newId();
        channelIds.set(c.key, cid);
        addChannel.run(cid, id, c.name, c.type, c.topic, c.position, t, c.category, c.slowmode);
        for (const o of c.overrides) {
          const target = o.target === 'everyone' ? id : roleIds.get(o.target);
          // The same cleaning PUT /channels/:id/overrides does: per-channel permissions only, allow beats deny.
          const allow = o.allow & CHANNEL_SCOPED;
          const deny = o.deny & CHANNEL_SCOPED & ~allow;
          if (target && (allow || deny)) addOverride.run(cid, target, allow, deny);
        }
      }
      db.prepare(`INSERT INTO server_imports (id, server_id, user_id, kind, status, source, report, created_at, updated_at, finished_at)
          VALUES (?, ?, ?, 'discord_template', 'done', ?, ?, ?, ?, ?)`).run(importId, id, req.userId, meta.code, stored, t, t, t);
      const addMap = db.prepare('INSERT OR IGNORE INTO import_map (import_id, kind, source_id, target_id) VALUES (?, ?, ?, ?)');
      addMap.run(importId, 'role', plan.everyone.key, id);
      for (const [k, v] of roleIds) addMap.run(importId, 'role', k, v);
      for (const [k, v] of channelIds) addMap.run(importId, 'channel', k, v);
    })();
    rateLimit('dimpc:' + req.userId, CREATIONS_PER_HOUR, 3600000);
    const n = plan.report.counts;
    auditLog(req, 'server_import', id, `discord template${meta.code ? ` ${meta.code}` : ''}: ${n.roles} roles, ${n.channels} channels, ${n.overrides} overrides, ${n.skipped} skipped`);
    // Exactly what POST /servers does next: the importer's open apps join the room and get the server.
    const io = getIo();
    io.in(`user:${req.userId}`).socketsJoin(`server:${id}`);
    const server = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(id), req.userId);
    io.to(`user:${req.userId}`).emit('server:add', { server, users: {}, voice: {}, keyState: keyState(id, req.userId) });
    res.json({ ...server, keyState: keyState(id, req.userId), importId, report: plan.report });
  });

  // What was imported into a server, newest first: counts and names, as shown before it was created. The report
  // names private channels too, so only people who see every channel (the owner and Administrators) get it.
  api.get('/servers/:id/imports', auth, (req, res) => {
    rateLimit('imports:' + req.userId, 60, 60000);
    const s = requirePerm(req.params.id, req.userId, PM.ADMINISTRATOR, 'Only the owner and Administrators can see what was imported.');
    const rows = db.prepare('SELECT * FROM server_imports WHERE server_id = ? ORDER BY created_at DESC LIMIT 50').all(s.id);
    res.json(rows.map((r) => {
      let report = {};
      try { report = JSON.parse(r.report || '{}'); } catch { /* shown as empty */ }
      return { id: r.id, kind: r.kind, status: r.status, source: r.source, done: r.done, total: r.total, report, createdBy: r.user_id, createdAt: r.created_at, finishedAt: r.finished_at };
    }));
  });
};
