// Call regions (like Discord's region override) and the news bot actually showing up and posting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, hex } = require('./helpers');

let srv; let feedSrv; let feedUrl; let items = [];
const as = (u, method, path, body) => srv.api(method, path, { token: u.token, ip: u.ip, body });
const rss = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title>${items.map((i) => `<item><title>${i.title}</title><link>https://example.test/${i.id}</link><guid>${i.id}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

before(async () => {
  // A local feed (the test server is allowed to fetch private addresses for this file only).
  feedSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/rss+xml'); res.end(rss()); });
  await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r));
  feedUrl = `http://127.0.0.1:${feedSrv.address().port}/feed.xml`;
  srv = await startServer({ FEED_ALLOW_PRIVATE: '1' });
});
after(async () => { await srv.stop(); feedSrv.close(); });

async function setup() {
  const owner = await srv.register(); const member = await srv.register(); const outsider = await srv.register();
  const server = (await as(owner, 'POST', '/servers', { name: 'Calls ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  await as(member, 'POST', `/invites/${invite.code}/join`);
  const voiceCh = server.channels.find((c) => c.type === 'voice');
  const textCh = server.channels.find((c) => c.type === 'text');
  return { owner, member, outsider, server, voiceCh, textCh };
}

// ------------------------------------------------------------------ call regions
test('call region: managers switch a voice channel, everyone sees it, others cannot', async () => {
  const { owner, member, outsider, server, voiceCh } = await setup();
  const regionId = 'reg' + hex(4);
  srv.sql('INSERT INTO regions (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', regionId, 'US Central', 'x'.repeat(64), Date.now());
  assert.equal((await as(member, 'POST', '/calls/region', { room: voiceCh.id, region: regionId })).status, 403, 'needs Manage Channels');
  assert.equal((await as(outsider, 'POST', '/calls/region', { room: voiceCh.id, region: regionId })).status, 404);
  assert.equal((await as(owner, 'POST', '/calls/region', { room: voiceCh.id, region: 'nope' })).status, 400, 'unknown region');
  assert.equal((await as(owner, 'POST', '/calls/region', { room: voiceCh.id, region: 'main' })).status, 400, 'no main relay configured');
  const r = await as(owner, 'POST', '/calls/region', { room: voiceCh.id, region: regionId });
  assert.equal(r.status, 200, r.text);
  const seen = (await as(member, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id).channels.find((c) => c.id === voiceCh.id);
  assert.equal(seen.region, regionId, 'members see the region');
  assert.equal((await as(owner, 'POST', '/calls/region', { room: voiceCh.id, region: 'auto' })).status, 200);
  assert.equal((await as(member, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id).channels.find((c) => c.id === voiceCh.id).region, null);
  const text = server.channels.find((c) => c.type === 'text');
  assert.equal((await as(owner, 'POST', '/calls/region', { room: text.id, region: regionId })).status, 404, 'only voice channels');
});

test('call region: either person in a DM call can switch it; nobody else can', async () => {
  const { owner, member, outsider } = await setup();
  const regionId = 'reg' + hex(4);
  srv.sql('INSERT INTO regions (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', regionId, 'Frankfurt', 'x'.repeat(64), Date.now());
  const dm = (await as(owner, 'POST', '/dms', { userId: member.id })).json;
  assert.ok(dm.id, JSON.stringify(dm));
  assert.equal((await as(member, 'POST', '/calls/region', { room: 'dm:' + dm.id, region: regionId })).status, 200);
  assert.equal((await as(owner, 'GET', '/bootstrap')).json.dms.find((d) => d.id === dm.id).region, regionId);
  assert.equal((await as(outsider, 'POST', '/calls/region', { room: 'dm:' + dm.id, region: null })).status, 404);
});

test('relays carry their region id, so the app can pin a call to one', async () => {
  const { owner } = await setup();
  const regionId = 'reg' + hex(4);
  srv.sql('INSERT INTO regions (id, name, token_hash, turn_urls, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)', regionId, 'US Central', 'x'.repeat(64), JSON.stringify(['turn:203.0.113.9:3478?transport=udp']), Date.now(), Date.now());
  srv.sql("INSERT OR REPLACE INTO instance_settings (key, value) VALUES ('turnSecret', 'test-secret')");
  const ice = (await as(owner, 'GET', '/ice')).json;
  const relay = ice.find((e) => e.regionId === regionId);
  assert.ok(relay, JSON.stringify(ice));
  assert.equal(relay.region, 'US Central');
  assert.ok(relay.username && relay.credential, 'short-lived relay login');
});

// ------------------------------------------------------------------ news bot
test('news bot: shows online, appears in the member list, posts the newest item right away', async () => {
  const { owner, member, server, textCh } = await setup();
  items = [{ id: 'a1', title: 'Old news', date: Date.now() - 10 * 86400000 }, { id: 'a2', title: 'Latest news', date: Date.now() - 3600000 }];
  const f = await as(owner, 'POST', `/servers/${server.id}/feeds`, { kind: 'rss', query: feedUrl, channelId: textCh.id, postLatest: true });
  assert.equal(f.status, 200, f.text);
  const boot = (await as(member, 'GET', '/bootstrap')).json;
  const s = boot.servers.find((x) => x.id === server.id);
  assert.equal(s.bots.length, 1, 'the bot is listed for this server');
  assert.equal(boot.users[s.bots[0]].presence, 'online');
  assert.equal(boot.users[s.bots[0]].bot, true);
  const msgs = (await as(member, 'GET', `/channels/${textCh.id}/messages`)).json;
  const list = Array.isArray(msgs) ? msgs : msgs.messages || [];
  assert.equal(list.filter((m) => m.authorId === s.bots[0]).length, 1, 'newest item posted on follow');
});

test('news bot: articles listed late are still posted; really old ones are not', async () => {
  const { owner, server, textCh } = await setup();
  items = [{ id: 'b1', title: 'Before following', date: Date.now() - 7200000 }];
  const f = (await as(owner, 'POST', `/servers/${server.id}/feeds`, { kind: 'rss', query: feedUrl, channelId: textCh.id })).json;
  // Google News style: published 5 hours ago, but it only shows up in the feed now.
  items.push({ id: 'b2', title: 'Published earlier, listed now', date: Date.now() - 5 * 3600000 });
  items.push({ id: 'b3', title: 'Shuffled back up from last week', date: Date.now() - 7 * 86400000 });
  const r = (await as(owner, 'POST', `/feeds/${f.id}/check`)).json;
  assert.equal(r.posted, 1, JSON.stringify(r));
  assert.equal(r.feed.lastError, null);
  // Pausing or removing the feed takes the bot out of the member list.
  await as(owner, 'DELETE', `/feeds/${f.id}`);
  assert.deepEqual((await as(owner, 'GET', '/bootstrap')).json.servers.find((x) => x.id === server.id).bots, []);
});
