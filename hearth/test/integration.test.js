// Seams between the hardening batches: what one batch changed that another relied on. Leaving a server (roles and
// overrides deleted by one batch, the update sent to the other members trimmed by another) and an upgrade that
// stops part-way (one transaction around it, with the audit log's anchor file written outside the database).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MANAGE_CHANNELS: 1 << 11 };
let srv; let boss;
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });

before(async () => { srv = await startServer(); boss = srv.owner; });
after(async () => { await srv.stop(); });

// Resolves with the first event of this name that passes the check (rejects after a while).
const next = (s, ev, ok = () => true, ms = 10000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { s.off(ev, on); reject(new Error(`no ${ev} within ${ms} ms`)); }, ms);
  function on(x) { if (!ok(x)) return; clearTimeout(timer); s.off(ev, on); resolve(x); }
  s.on(ev, on);
});

// ------------------------------------------------------------------ leaving, then coming back
test('leaving with roles or channel permissions updates the members still there, so their apps can’t hand them back', async () => {
  const server = (await as(boss, 'POST', '/servers', { name: 'Seams' })).json;
  const { code } = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json;
  const bob = await srv.register(`bob${hex(3)}`); const carl = await srv.register(`carl${hex(3)}`);
  for (const u of [bob, carl]) assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  const helpers = (await as(boss, 'POST', `/servers/${server.id}/roles`, { name: 'Helpers', permissions: P.MANAGE_CHANNELS })).json;
  const verified = (await as(boss, 'POST', `/servers/${server.id}/roles`, { name: 'Verified', permissions: 0 })).json;
  assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${bob.id}/roles`, { roleIds: [helpers.id] })).status, 200);
  const vault = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: 'vault', type: 'text' })).json;
  assert.equal((await as(boss, 'PUT', `/channels/${vault.id}/overrides`, {
    overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'member', id: bob.id, allow: P.VIEW | P.SEND, deny: 0 }],
  })).status, 200);

  // The owner's open app hears that bob left, then gets the server again without his roles and his override.
  const sock = await srv.socket(boss.token);
  try {
    const removed = next(sock, 'member:remove', (x) => x.serverId === server.id && x.userId === bob.id);
    const updated = next(sock, 'server:update', (x) => x.id === server.id);
    assert.equal((await as(bob, 'POST', `/servers/${server.id}/leave`)).status, 200);
    await removed;
    const after = await updated;
    assert.ok(!after.memberIds.includes(bob.id));
    assert.equal(after.memberRoles[bob.id], undefined, 'his roles are gone from the owner’s copy');
    const ch = after.channels.find((c) => c.id === vault.id);
    assert.deepEqual(ch.overrides.filter((o) => o.type === 'member'), [], 'his override is gone from the owner’s copy');

    // Back with an invite: what the owner's app now sends (his roles plus the one ticked, the channel's overrides as
    // they are) gives him nothing he had before.
    const added = next(sock, 'member:add', (x) => x.serverId === server.id && x.user.id === bob.id);
    assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).status, 200);
    await added;
    const current = after.memberRoles[bob.id] || [];
    assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${bob.id}/roles`, { roleIds: [...current, verified.id] })).status, 200);
    assert.deepEqual(srv.sql('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', server.id, bob.id).map((r) => r.role_id), [verified.id]);
    assert.equal((await as(boss, 'PUT', `/channels/${vault.id}/overrides`, { overrides: ch.overrides })).status, 200);
    assert.equal((await as(bob, 'GET', `/channels/${vault.id}/messages`)).status, 404, 'the private channel stays closed');

    // Someone who had neither leaves: only member:remove, like before (a big server isn't sent to everyone online).
    // The rename's update is the next one the owner hears after it (events on one connection arrive in order).
    let heardLeave = false; let early = null;
    const spy = (x) => { if (heardLeave && x.id === server.id && !early) early = x; };
    sock.on('server:update', spy);
    const gone = next(sock, 'member:remove', (x) => (heardLeave = x.serverId === server.id && x.userId === carl.id));
    assert.equal((await as(carl, 'POST', `/servers/${server.id}/leave`)).status, 200);
    await gone;
    const renamed = next(sock, 'server:update', (x) => x.id === server.id);
    assert.equal((await as(boss, 'PATCH', `/servers/${server.id}`, { name: 'Seams 2' })).status, 200);
    await renamed;
    sock.off('server:update', spy);
    assert.equal(early && early.name, 'Seams 2', 'no server update for a leave that changed nothing else');
  } finally { sock.close(); }
});

// ------------------------------------------------------------------ an upgrade that stops after the audit step
// The audit log's anchor file lives outside the database, so it must only name entries that were committed. An
// upgrade that failed after starting the keyed chain used to leave an anchor pointing at an entry that was rolled
// back, which every start after that reported as entries cut off the end.
const plainHash = (prev, r) => crypto.createHash('sha256')
  .update(JSON.stringify([prev || '', r.id, r.admin_id || '', r.action, r.target || '', r.detail || '', r.ip || '', r.created_at])).digest('hex');

test('an upgrade cut short after the audit log starts signing leaves no anchor behind; the next start signs it cleanly', async () => {
  const s = await startServer();
  const anchorFile = path.join(s.dir, 'audit-anchor.json');
  const owner = s.owner;
  const version = () => { const d = s.db(); try { return d.pragma('user_version', { simple: true }); } finally { d.close(); } };
  const verify = async () => {
    const r = await s.api('GET', '/admin/log/verify', { token: owner.token, ip: owner.ip });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  try {
    for (const mode of ['on', 'off']) assert.equal((await s.api('PUT', '/admin/registration', { token: owner.token, ip: owner.ip, body: { captchaLogin: mode } })).status, 200);
    s.child.kill('SIGTERM');
    for (let i = 0; i < 100 && s.child.exitCode === null; i++) await sleep(50);

    // As a v16 database: plain SHA-256 entries, no record of where signing starts, no anchor file. (Start-up puts
    // back the trigger that keeps entries from being changed.)
    const d = s.db();
    try {
      d.exec('DROP TRIGGER admin_log_no_update');
      d.transaction(() => {
        let prev = '';
        for (const r of d.prepare('SELECT * FROM admin_log ORDER BY id').all()) {
          const h = plainHash(prev, r);
          d.prepare('UPDATE admin_log SET prev_hash = ?, hash = ? WHERE id = ?').run(prev, h, r.id);
          prev = h;
        }
        d.prepare("DELETE FROM instance_settings WHERE key = 'auditKeyedFrom'").run();
      })();
      d.pragma('user_version = 16');
      // Something in the way of a later step of the upgrade (here: a table where a v17 index has to go).
      d.exec('DROP INDEX idx_members_user; CREATE TABLE idx_members_user (x)');
    } finally { d.close(); }
    fs.rmSync(anchorFile);
    const old = s.sql('SELECT id FROM admin_log ORDER BY id').map((r) => r.id);
    assert.ok(old.length >= 2, 'some entries from before the upgrade');

    for (let i = 0; i < 2; i++) {
      await assert.rejects(s.restart(), /didn't start/);
      assert.match(s.log, /already a table named idx_members_user/);
      assert.equal(version(), 16, 'rolled back');
      assert.deepEqual(s.sql('SELECT id FROM admin_log ORDER BY id').map((r) => r.id), old, 'no entry was added');
      assert.ok(!fs.existsSync(anchorFile), `attempt ${i + 1}: no anchor for an entry that was rolled back`);
    }

    s.sql('DROP TABLE idx_members_user');
    await s.restart();
    const v = await verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.deepEqual(v.gaps, []);
    assert.equal(v.keyedFrom, old.length + 1);
    assert.ok(v.keyedSince, 'the log says when signing started');
    assert.deepEqual(s.sql("SELECT id FROM admin_log WHERE action = 'audit_chain_keyed'").map((r) => r.id), [old.length + 1]);

    // And it stays that way: the next entry and another restart find nothing missing.
    assert.equal((await s.api('PUT', '/admin/registration', { token: owner.token, ip: owner.ip, body: { captchaLogin: 'off' } })).status, 200);
    await s.restart();
    const again = await verify();
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.gaps, []);
    assert.equal(s.sql("SELECT COUNT(*) n FROM admin_log WHERE action IN ('audit_log_gap', 'audit_anchor_reset')")[0].n, 0);
  } finally { await s.stop(); }
});
