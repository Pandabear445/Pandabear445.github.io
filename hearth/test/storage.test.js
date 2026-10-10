// Files and storage: resumable uploads (order, offsets, size caps, checksums, resuming, cancelling, expiry,
// ownership, quota across sessions), downloads (Range, caching, deleted files), the admin storage report and
// orphan cleanup (admin + password, never a referenced file), Settings → Storage, and backups (finished files in,
// unfinished uploads out). Each test checks that the misuse is refused AND that normal use still works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, sleep, hex } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const MB = 1024 * 1024;
const CHUNK = MB; // UPLOAD_CHUNK_BYTES below: small chunks keep the test files small
let srv; let owner;

before(async () => {
  srv = await startServer({ UPLOAD_CHUNK_BYTES: String(CHUNK), UPLOAD_SWEEP_MS: '400' });
  owner = srv.owner;
});
after(async () => { if (srv) await srv.stop(); });

const as = (u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const start = (u, size) => as(u, 'POST', '/uploads', { size });
const put = (u, id, offset, bytes, headers = {}) => srv.api('PUT', `/uploads/${id}?offset=${offset}`, { token: u.token, ip: u.ip, raw: bytes, headers: { 'content-type': 'application/octet-stream', ...headers } });
const complete = (u, id, hash) => as(u, 'POST', `/uploads/${id}/complete`, { sha256: hash });
const used = async (u) => (await as(u, 'GET', '/me/storage')).json.used;
const partFile = (id) => path.join(srv.dir, 'upload-parts', id + '.part');
const setLimits = (body) => as(owner, 'PUT', '/admin/limits', body);
const DEFAULT_LIMITS = { quotaMb: 1000, fileMb: 25, dailyMb: 500 };

// Uploads a whole buffer chunk by chunk and finishes it. Returns the blob URL.
async function uploadAll(u, bytes) {
  const s = await start(u, bytes.length);
  assert.equal(s.status, 200, s.text);
  for (let off = 0; off < bytes.length; off += s.json.chunkSize) {
    const r = await put(u, s.json.id, off, bytes.subarray(off, off + s.json.chunkSize));
    assert.equal(r.status, 200, r.text);
  }
  const done = await complete(u, s.json.id, sha(bytes));
  assert.equal(done.status, 200, done.text);
  return done.json.url;
}
// A multipart one-request upload (the older route, kept for small files and older apps).
async function single(u, bytes) {
  const boundary = '----hearth' + hex(8);
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return srv.api('POST', '/upload/encrypted', { token: u.token, ip: u.ip, raw, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, timeout: 30000 });
}
async function sharedServer(a, b, name) {
  const s = (await as(a, 'POST', '/servers', { name })).json;
  const { code } = (await as(a, 'POST', `/servers/${s.id}/invites`, {})).json;
  assert.equal((await as(b, 'POST', `/invites/${code}/join`)).status, 200);
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', s.id);
  return { ...s, text: s.channels.find((c) => c.type === 'text') };
}
const cipher = () => 'v2:' + crypto.randomBytes(40).toString('base64');
const get = (p, headers = {}) => srv.call('GET', p, { headers });
const rawGet = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(srv.base + p, { headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); }).on('error', reject);
});

// ------------------------------------------------------------------ storage-1: the happy path, in order
test('storage-1: a chunked upload goes in order, is checked against its SHA-256 and appears as one finished blob', async () => {
  const u = await srv.register('chunky');
  const bytes = crypto.randomBytes(Math.floor(2.5 * CHUNK));
  const s = await start(u, bytes.length);
  assert.equal(s.status, 200, s.text);
  assert.match(s.json.id, /^[a-f0-9]{32}$/);
  assert.equal(s.json.chunkSize, CHUNK);
  assert.equal(s.json.received, 0);
  assert.ok(s.json.expiresAt > Date.now() + 23 * 3600 * 1000, 'idle sessions last a day');
  // Reserved at once: the whole size counts against the quota while it's being sent.
  assert.equal(await used(u), bytes.length);
  assert.ok(fs.existsSync(partFile(s.json.id)), 'the bytes wait outside uploads/');

  // Out of order: refused, and the answer says where to carry on.
  let r = await put(u, s.json.id, CHUNK, bytes.subarray(CHUNK, 2 * CHUNK));
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'offset_mismatch');
  assert.equal(r.json.received, 0);
  r = await put(u, s.json.id, 0, bytes.subarray(0, CHUNK));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.received, CHUNK);
  // The same chunk twice (a retry after the answer got lost): refused, nothing is written twice.
  r = await put(u, s.json.id, 0, bytes.subarray(0, CHUNK));
  assert.equal(r.status, 409);
  assert.equal(r.json.received, CHUNK);
  // Not a number, negative, or missing: refused the same way.
  for (const off of ['abc', '-1', '', '1e6']) assert.equal((await srv.api('PUT', `/uploads/${s.json.id}?offset=${off}`, { token: u.token, ip: u.ip, raw: Buffer.alloc(10), headers: { 'content-type': 'application/octet-stream' } })).status, 409, off);
  // Finishing early is refused.
  r = await complete(u, s.json.id, sha(bytes));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'incomplete');
  r = await put(u, s.json.id, CHUNK, bytes.subarray(CHUNK, 2 * CHUNK));
  assert.equal(r.status, 200);
  r = await put(u, s.json.id, 2 * CHUNK, bytes.subarray(2 * CHUNK));
  assert.equal(r.status, 200);
  assert.equal(r.json.received, bytes.length);
  // Nothing in uploads/ yet: a partial file is never visible as a blob.
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE uploader_id = ?', u.id)[0].n, 0);

  r = await complete(u, s.json.id, 'zz');
  assert.equal(r.status, 400, 'a malformed checksum');
  const done = await complete(u, s.json.id, sha(bytes));
  assert.equal(done.status, 200, done.text);
  assert.match(done.json.url, /^\/uploads\/[a-z0-9]+\.bin$/);
  const name = path.basename(done.json.url);
  assert.deepEqual(fs.readFileSync(path.join(srv.dir, 'uploads', name)), bytes);
  assert.ok(!fs.existsSync(partFile(s.json.id)), 'the part file was moved, not copied');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE name = ? AND uploader_id = ? AND message_id IS NULL', name, u.id)[0].n, 1, 'a blob ready to attach');
  assert.deepEqual(srv.sql('SELECT kind, size FROM user_files WHERE user_id = ?', u.id), [{ kind: 'attachment', size: bytes.length }], 'the reservation became the file');
  assert.equal(await used(u), bytes.length);
  assert.equal((await as(u, 'GET', `/uploads/${s.json.id}`)).status, 404, 'the session is gone');
  // Served like any other blob, and it can be attached to a message.
  const got = await fetch(srv.base + done.json.url);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
  const b = await srv.register();
  const sv = await sharedServer(u, b, 'Chunk town');
  const m = await as(u, 'POST', `/channels/${sv.text.id}/messages`, { ciphertext: cipher(), epoch: 1, files: [done.json.url] });
  assert.equal(m.status, 200, m.text);
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', name)[0].message_id, m.json.id);
});

// ------------------------------------------------------------------ storage-2: sizes
test('storage-2: oversize chunks, files over the limit and nonsense sizes are refused; nothing extra is written', async () => {
  const u = await srv.register('oversize');
  for (const size of [0, -5, 1.5, 'big', null, 2 ** 60]) assert.equal((await start(u, size)).status, 400, String(size));
  assert.equal((await start(u, 2 ** 40)).status, 413, 'a terabyte');
  const s = (await start(u, 3 * CHUNK)).json;
  // A chunk bigger than the chunk size.
  let r = await put(u, s.id, 0, crypto.randomBytes(CHUNK + 1));
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json.code, 'chunk_too_big');
  assert.equal((await as(u, 'GET', `/uploads/${s.id}`)).json.received, 0);
  assert.equal(fs.statSync(partFile(s.id)).size, 0, 'nothing of it was kept');
  // The wrong kind of body (a JSON body would be parsed instead of stored).
  r = await srv.api('PUT', `/uploads/${s.id}?offset=0`, { token: u.token, ip: u.ip, raw: JSON.stringify({ a: 1 }) });
  assert.equal(r.status, 415);
  // An empty chunk.
  r = await put(u, s.id, 0, Buffer.alloc(0));
  assert.equal(r.status, 400);
  // The last chunk can't run past the declared size.
  const small = (await start(u, 1000)).json;
  r = await put(u, small.id, 0, crypto.randomBytes(1001));
  assert.equal(r.status, 413);
  // Without a Content-Length (chunked transfer encoding) the cap is enforced while reading.
  const status = await new Promise((resolve) => {
    const req = http.request(`${srv.base}/api/uploads/${small.id}?offset=0`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': u.ip, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('reset'));
    req.write(crypto.randomBytes(800)); req.write(crypto.randomBytes(800)); req.end();
  });
  assert.ok(status === 413 || status === 'reset', String(status));
  await sleep(100);
  assert.equal((await as(u, 'GET', `/uploads/${small.id}`)).json.received, 0);
  assert.equal(fs.statSync(partFile(small.id)).size, 0);
  // Bigger than the per-file limit (25 MB + the encryption allowance).
  r = await start(u, 27 * MB);
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 'too_big');
  // Normal use right after: fine.
  const ok = await put(u, small.id, 0, crypto.randomBytes(1000));
  assert.equal(ok.status, 200, ok.text);
  for (const id of [s.id, small.id]) assert.equal((await as(u, 'DELETE', `/uploads/${id}`)).status, 200);

  // Two chunks for the same place at once (a retry racing the original): one gets in, the other is told to wait
  // or where to carry on; the file never gets a mix of both.
  const x = crypto.randomBytes(CHUNK); const y = crypto.randomBytes(CHUNK); const rest = crypto.randomBytes(500);
  const race = (await start(u, CHUNK + 500)).json;
  const both = await Promise.all([put(u, race.id, 0, x), put(u, race.id, 0, y)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], both.map((r) => r.text).join('\n'));
  const winner = both[0].status === 200 ? x : y;
  assert.equal((await as(u, 'GET', `/uploads/${race.id}`)).json.received, CHUNK);
  assert.deepEqual(fs.readFileSync(partFile(race.id)), winner);
  assert.equal((await put(u, race.id, CHUNK, rest)).status, 200);
  assert.equal((await complete(u, race.id, sha(Buffer.concat([winner, rest])))).status, 200);
});

// ------------------------------------------------------------------ storage-3: damaged files
test('storage-3: a checksum mismatch is refused, keeps nothing and gives the room back', async () => {
  const u = await srv.register('damaged');
  const bytes = crypto.randomBytes(CHUNK + 777);
  const s = (await start(u, bytes.length)).json;
  assert.equal((await put(u, s.id, 0, bytes.subarray(0, CHUNK))).status, 200);
  const flipped = Buffer.from(bytes.subarray(CHUNK)); flipped[5] ^= 1; // one bit changed on the way
  assert.equal((await put(u, s.id, CHUNK, flipped)).status, 200);
  const before = fs.readdirSync(path.join(srv.dir, 'uploads')).length;
  const r = await complete(u, s.id, sha(bytes));
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.code, 'hash_mismatch');
  assert.equal(fs.readdirSync(path.join(srv.dir, 'uploads')).length, before, 'nothing appeared in uploads/');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE uploader_id = ?', u.id)[0].n, 0);
  assert.equal(await used(u), 0, 'the reservation is released');
  await sleep(50);
  assert.ok(!fs.existsSync(partFile(s.id)));
  assert.equal((await as(u, 'GET', `/uploads/${s.id}`)).status, 404);
  // Sending it again, undamaged, works.
  const url = await uploadAll(u, bytes);
  assert.deepEqual(Buffer.from(await (await fetch(srv.base + url)).arrayBuffer()), bytes);
});

// ------------------------------------------------------------------ storage-4: resuming
test('storage-4: after a dropped connection (and a server restart) the upload carries on from where the server got to', async () => {
  const u = await srv.register('resumer');
  const bytes = crypto.randomBytes(3 * CHUNK + 12345);
  const s = (await start(u, bytes.length)).json;
  assert.equal((await put(u, s.id, 0, bytes.subarray(0, CHUNK))).status, 200);
  // The connection drops part-way through the second chunk.
  const sent = 300 * 1024;
  await new Promise((resolve) => {
    const req = http.request(`${srv.base}/api/uploads/${s.id}?offset=${CHUNK}`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': u.ip, 'content-type': 'application/octet-stream', 'content-length': String(CHUNK) } });
    req.on('error', () => resolve());
    req.write(bytes.subarray(CHUNK, CHUNK + sent), () => setTimeout(() => { req.destroy(); resolve(); }, 300));
  });
  let st;
  for (let i = 0; i < 40; i++) { st = (await as(u, 'GET', `/uploads/${s.id}`)).json; if (st.received > CHUNK) break; await sleep(50); }
  assert.ok(st.received >= CHUNK && st.received <= CHUNK + sent, `kept what arrived: ${st.received}`);
  // A gap: the server restarts (an update) before the app comes back.
  await srv.restart();
  st = (await as(u, 'GET', `/uploads/${s.id}`)).json;
  assert.ok(st.received >= CHUNK, 'the session survived the restart');
  // Carry on from the server's offset, in chunk-size pieces.
  for (let off = st.received; off < bytes.length;) {
    const piece = bytes.subarray(off, Math.min(bytes.length, off + CHUNK));
    const r = await put(u, s.id, off, piece);
    assert.equal(r.status, 200, r.text);
    off = r.json.received;
  }
  const done = await complete(u, s.id, sha(bytes));
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(Buffer.from(await (await fetch(srv.base + done.json.url)).arrayBuffer()), bytes, 'byte for byte the same');
});

// ------------------------------------------------------------------ storage-5: cancel
test('storage-5: cancelling removes the part file and frees the reserved room at once', async () => {
  const u = await srv.register('canceller');
  assert.equal((await as(owner, 'PATCH', `/admin/users/${u.id}/limits`, { quotaMb: 3 })).status, 200);
  const s = (await start(u, Math.floor(2.5 * MB))).json;
  assert.equal((await put(u, s.id, 0, crypto.randomBytes(CHUNK))).status, 200);
  // The quota is taken by the reservation: another chunked upload and a one-request upload are both refused.
  let r = await start(u, MB);
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json.code, 'quota');
  r = await single(u, crypto.randomBytes(MB));
  assert.equal(r.status, 413, r.text);
  // Cancel.
  assert.equal((await as(u, 'DELETE', `/uploads/${s.id}`)).status, 200);
  assert.equal(await used(u), 0);
  await sleep(50);
  assert.ok(!fs.existsSync(partFile(s.id)));
  assert.equal((await put(u, s.id, CHUNK, crypto.randomBytes(10))).status, 404, 'a cancelled session takes nothing more');
  assert.equal((await as(u, 'DELETE', `/uploads/${s.id}`)).status, 404);
  // The room is back.
  r = await single(u, crypto.randomBytes(MB));
  assert.equal(r.status, 200, r.text);
  await uploadAll(u, crypto.randomBytes(MB + 5));
});

// ------------------------------------------------------------------ storage-6: expiry
test('storage-6: idle sessions expire, and the sweep removes their part files, stray part files and lost sessions', async () => {
  const u = await srv.register('idler');
  const old = (await start(u, 2 * CHUNK)).json;
  assert.equal((await put(u, old.id, 0, crypto.randomBytes(CHUNK))).status, 200);
  const fresh = (await start(u, CHUNK)).json;
  const lost = (await start(u, CHUNK)).json; // its part file goes missing (a backup restored on a new machine)
  assert.equal(await used(u), 4 * CHUNK);
  srv.sql('UPDATE upload_sessions SET updated_at = ? WHERE id = ?', Date.now() - 25 * 3600 * 1000, old.id);
  fs.rmSync(partFile(lost.id));
  const stray = path.join(srv.dir, 'upload-parts', hex(16) + '.part');
  fs.writeFileSync(stray, 'leftover');
  fs.utimesSync(stray, new Date(Date.now() - 3600 * 1000), new Date(Date.now() - 3600 * 1000));
  let ids = [];
  for (let i = 0; i < 40; i++) { ids = srv.sql('SELECT id FROM upload_sessions WHERE user_id = ?', u.id).map((x) => x.id); if (ids.length === 1) break; await sleep(100); }
  assert.deepEqual(ids, [fresh.id], 'only the live session is left');
  assert.equal(await used(u), CHUNK, 'expired reservations are released');
  assert.ok(!fs.existsSync(partFile(old.id)));
  assert.ok(!fs.existsSync(stray), 'stray part file removed');
  assert.ok(fs.existsSync(partFile(fresh.id)), 'the live one is untouched');
  const r = await put(u, old.id, CHUNK, crypto.randomBytes(CHUNK));
  assert.equal(r.status, 404, 'an expired session takes nothing more');
  assert.equal((await put(u, fresh.id, 0, crypto.randomBytes(CHUNK))).status, 200);
  await as(u, 'DELETE', `/uploads/${fresh.id}`);
});

// ------------------------------------------------------------------ storage-7: ownership
test('storage-7: nobody but the person who started an upload can see, add to, finish or cancel it', async () => {
  const a = await srv.register('owner7');
  const eve = await srv.register('eve7');
  const bytes = crypto.randomBytes(CHUNK + 10);
  const s = (await start(a, bytes.length)).json;
  assert.equal((await put(a, s.id, 0, bytes.subarray(0, CHUNK))).status, 200);
  for (const r of [
    await as(eve, 'GET', `/uploads/${s.id}`),
    await put(eve, s.id, CHUNK, bytes.subarray(CHUNK)),
    await complete(eve, s.id, sha(bytes)),
    await as(eve, 'DELETE', `/uploads/${s.id}`),
  ]) {
    assert.equal(r.status, 404, r.text);
    assert.ok(!/received|size/.test(r.text), 'the answer says nothing about the session');
  }
  assert.deepEqual((await as(eve, 'GET', '/uploads')).json, [], 'and it isn’t in their list');
  assert.equal((await srv.call('GET', `/api/uploads/${s.id}`)).status, 401, 'signed out');
  // The owner's session is exactly as it was, and finishes normally.
  const st = (await as(a, 'GET', `/uploads/${s.id}`)).json;
  assert.equal(st.received, CHUNK);
  assert.equal((await put(a, s.id, CHUNK, bytes.subarray(CHUNK))).status, 200);
  assert.equal((await complete(a, s.id, sha(bytes))).status, 200);
  // An admin can't reach into someone's upload either (they have their own tools: Storage, delete files).
  const t = (await start(a, 100)).json;
  assert.equal((await as(owner, 'DELETE', `/uploads/${t.id}`)).status, 404);
  assert.equal((await as(a, 'DELETE', `/uploads/${t.id}`)).status, 200);
});

// ------------------------------------------------------------------ storage-8: quota across sessions
test('storage-8: the quota and the daily allowance hold across uploads started at the same time', async () => {
  const u = await srv.register('parallel');
  assert.equal((await as(owner, 'PATCH', `/admin/users/${u.id}/limits`, { quotaMb: 5 })).status, 200);
  const results = await Promise.all(Array.from({ length: 3 }, () => start(u, 2 * MB)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 413], results.map((r) => r.text).join('\n'));
  assert.equal(await used(u), 4 * MB);
  // One-request uploads see the reserved room too.
  assert.equal((await single(u, crypto.randomBytes(Math.floor(1.5 * MB)))).status, 413);
  assert.equal((await single(u, crypto.randomBytes(MB / 2))).status, 200);
  for (const r of results.filter((x) => x.status === 200)) await as(u, 'DELETE', `/uploads/${r.json.id}`);

  // Daily allowance: counted from the moment the room is reserved.
  try {
    assert.equal((await setLimits({ dailyMb: 3 })).status, 200);
    const d = await srv.register('daily');
    const r1 = await start(d, 2 * MB);
    assert.equal(r1.status, 200);
    const r2 = await start(d, 2 * MB);
    assert.equal(r2.status, 413);
    assert.match(r2.json.error, /today/);
  } finally { await setLimits(DEFAULT_LIMITS); }

  // At most a few unfinished uploads per person, whatever their quota.
  const many = await srv.register('many');
  const ok = [];
  for (let i = 0; i < 4; i++) { const r = await start(many, 10); assert.equal(r.status, 200); ok.push(r.json.id); }
  const fifth = await start(many, 10);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.json.code, 'too_many_uploads');
  await as(many, 'DELETE', `/uploads/${ok[0]}`);
  assert.equal((await start(many, 10)).status, 200, 'room for one more once one is cancelled');
  // Blocked accounts can't start (or carry on) uploads.
  assert.equal((await as(owner, 'PATCH', `/admin/users/${many.id}/limits`, { uploadsBlocked: true })).status, 200);
  assert.equal((await start(many, 10)).status, 403);
  assert.equal((await put(many, ok[1], 0, Buffer.alloc(10))).status, 403);
  await as(owner, 'PATCH', `/admin/users/${many.id}/limits`, { uploadsBlocked: false });
});

// ------------------------------------------------------------------ storage-9: downloads
test('storage-9: blobs and media answer Range requests (206/416) with safe headers, and deleted files are 404 every way', async () => {
  const a = await srv.register('ranger');
  const b = await srv.register('ranger2');
  const sv = await sharedServer(a, b, 'Range rovers');
  const main = crypto.randomBytes(3 * CHUNK + 99);
  const mainUrl = await uploadAll(a, main);
  const thumb = crypto.randomBytes(5000);
  const th = await single(a, thumb);
  assert.equal(th.status, 200);
  const m = await as(a, 'POST', `/channels/${sv.text.id}/messages`, { ciphertext: cipher(), epoch: 1, files: [mainUrl, th.json.url] });
  assert.equal(m.status, 200, m.text);

  let r = await fetch(srv.base + mainUrl);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('cache-control'), 'private, no-cache', 'revalidated, so a deleted file stops loading');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-disposition'), 'attachment');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  const etag = r.headers.get('etag');
  await r.arrayBuffer();
  // (With plain http: fetch() marks conditional requests no-cache, which always gets the whole file.)
  assert.equal((await rawGet(mainUrl, { 'if-none-match': etag })).status, 304, 'cheap to revalidate');

  r = await fetch(srv.base + mainUrl, { headers: { range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${main.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), main.subarray(10, 20));
  r = await fetch(srv.base + mainUrl, { headers: { range: 'bytes=-7' } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), main.subarray(main.length - 7));
  r = await fetch(srv.base + mainUrl, { headers: { range: `bytes=${2 * CHUNK}-` } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), main.subarray(2 * CHUNK), 'seeking to the middle of a long video');
  r = await fetch(srv.base + mainUrl, { headers: { range: `bytes=${main.length + 10}-${main.length + 20}` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), `bytes */${main.length}`);
  r = await fetch(srv.base + mainUrl, { headers: { range: 'bytes=nonsense' } });
  assert.ok([200, 416].includes(r.status), `a malformed range: ${r.status}`);
  await r.arrayBuffer();

  // Public media (a profile song): inline type, cached for good, Range works.
  const song = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(20000)]);
  const boundary = '----hearth' + hex(8);
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`), song, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = await srv.api('POST', '/me/song', { token: a.token, ip: a.ip, raw, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(up.status, 200, up.text);
  const songUrl = srv.sql('SELECT song FROM users WHERE id = ?', a.id)[0].song;
  r = await fetch(srv.base + songUrl, { headers: { range: 'bytes=0-2' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'ID3');

  // Deleting the message: the file and its thumbnail are gone through every way of asking.
  assert.equal((await as(a, 'DELETE', `/messages/${m.json.id}`)).status, 200);
  await sleep(100);
  for (const u of [mainUrl, th.json.url]) {
    for (const headers of [{}, { range: 'bytes=0-9' }, { range: 'bytes=-1' }]) assert.equal((await get(u, headers)).status, 404, `${u} ${JSON.stringify(headers)}`);
    assert.equal((await rawGet(u, { 'if-none-match': etag })).status, 404, 'a cached copy is not confirmed');
    assert.equal((await srv.call('HEAD', u)).status, 404);
    assert.ok(!fs.existsSync(path.join(srv.dir, 'uploads', path.basename(u))));
  }
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE name IN (?, ?)', path.basename(mainUrl), path.basename(th.json.url))[0].n, 0, 'and no longer counted');

  // The same for a direct message's attachment.
  const dm = (await as(a, 'POST', '/dms', { userId: b.id })).json;
  const dmUrl = await uploadAll(a, crypto.randomBytes(CHUNK + 1));
  const dmMsg = await as(a, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher(), files: [dmUrl] });
  assert.equal(dmMsg.status, 200, dmMsg.text);
  assert.equal((await get(dmUrl, { range: 'bytes=0-0' })).status, 206);
  assert.equal((await as(a, 'DELETE', `/dm-messages/${dmMsg.json.id}`)).status, 200);
  await sleep(100);
  assert.equal((await get(dmUrl, { range: 'bytes=0-0' })).status, 404);
  assert.equal((await get(dmUrl)).status, 404);
  // Unfinished uploads can't be downloaded by any path.
  const secret = Buffer.from('UNFINISHED-' + hex(16));
  const s = (await start(a, 1000)).json;
  assert.equal((await put(a, s.id, 0, secret)).status, 200);
  for (const p of [`/uploads/${s.id}.part`, `/uploads/${s.id}`, '/uploads/..%2fupload-parts%2f' + s.id + '.part', `/upload-parts/${s.id}.part`, `/uploads/upload-${s.id}`]) {
    const x = await get(p);
    assert.ok(!x.text.includes(secret.toString()), p);
    if (p.startsWith('/uploads/')) assert.equal(x.status, 404, p);
  }
  await as(a, 'DELETE', `/uploads/${s.id}`);
});

// ------------------------------------------------------------------ storage-10: admin report and orphan cleanup
function sealWith(dir, obj) {
  const key = Buffer.from(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim(), 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((x) => x.toString('base64')).join('.');
}
test('storage-10: the storage report and "clean up orphans" need an admin (and the password), and never remove a referenced file', async () => {
  const a = await srv.register('hoarder');
  const b = await srv.register('hoarder2');
  const mod = await srv.register('mod10');
  const sv = await sharedServer(a, b, 'Hoard');
  const UP = path.join(srv.dir, 'uploads');
  const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  const age = (name) => fs.utimesSync(path.join(UP, name), longAgo, longAgo);

  // Referenced files, all made to look old (the age alone must never be enough to delete).
  const attached = path.basename(await uploadAll(a, crypto.randomBytes(CHUNK + 3)));
  const msg = await as(a, 'POST', `/channels/${sv.text.id}/messages`, { ciphertext: cipher(), epoch: 1, files: ['/uploads/' + attached] });
  assert.equal(msg.status, 200);
  const pendingBlob = path.basename((await single(a, crypto.randomBytes(3000))).json.url); // uploaded, not posted yet
  const avatar = 'av' + hex(6) + '.png'; fs.writeFileSync(path.join(UP, avatar), 'png'); srv.sql('UPDATE users SET avatar = ? WHERE id = ?', '/uploads/' + avatar, a.id);
  const icon = 'ic' + hex(6) + '.png'; fs.writeFileSync(path.join(UP, icon), 'png'); srv.sql('UPDATE servers SET icon = ? WHERE id = ?', '/uploads/' + icon, sv.id);
  const pagePic = 'pg' + hex(6) + '.webp'; fs.writeFileSync(path.join(UP, pagePic), 'webp'); srv.sql('UPDATE users SET page = ? WHERE id = ?', JSON.stringify({ blocks: [{ type: 'image', url: '/uploads/' + pagePic }] }), b.id);
  const oldAttach = 'oa' + hex(6) + '.pdf'; fs.writeFileSync(path.join(UP, oldAttach), 'pdf'); // in an older, server-encrypted message
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)', 'old' + hex(6), sv.text.id, a.id,
    sealWith(srv.dir, { content: 'hi', attachments: [{ url: '/uploads/' + oldAttach, name: 'a.pdf' }] }), Date.now());
  const referenced = [attached, pendingBlob, avatar, icon, pagePic, oldAttach];
  referenced.filter((n) => n !== pendingBlob).forEach(age);
  // Leftovers: an old file nothing points at, a blob whose message is gone, and a quota row for a missing file.
  const stray = 'zz' + hex(6) + '.bin'; fs.writeFileSync(path.join(UP, stray), crypto.randomBytes(4000)); age(stray);
  const deadBlob = 'db' + hex(6) + '.bin'; fs.writeFileSync(path.join(UP, deadBlob), crypto.randomBytes(2000)); age(deadBlob);
  srv.sql('INSERT INTO blobs (name, uploader_id, message_id, created_at) VALUES (?, ?, ?, ?)', deadBlob, a.id, 'gone' + hex(4), Date.now() - 9 * 86400000);
  srv.sql('INSERT INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)', deadBlob, a.id, 'attachment', 2000, Date.now() - 9 * 86400000);
  const missing = 'mi' + hex(6) + '.bin';
  srv.sql('INSERT INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)', missing, b.id, 'attachment', 777, Date.now() - 9 * 86400000);
  // A fresh unreferenced file: inside the grace period, so it stays (an upload may be about to be recorded).
  const young = 'yg' + hex(6) + '.bin'; fs.writeFileSync(path.join(UP, young), 'x');
  // An unfinished upload, shown in the report.
  const sess = (await start(b, 2 * CHUNK)).json;
  await put(b, sess.id, 0, crypto.randomBytes(CHUNK));

  // Not for everyone.
  assert.equal(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'storage_cleanup'")[0].n, 0);
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: mod.id, role: 'moderator', authKey: owner.authKey })).status, 200);
  for (const u of [a, mod]) {
    assert.equal((await as(u, 'GET', '/admin/storage/report')).status, 403);
    assert.equal((await as(u, 'POST', '/admin/storage/cleanup', { authKey: u.authKey })).status, 403);
  }
  // Every admin route in server/storage.js: 401 signed out, 403 for a normal account.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'storage.js'), 'utf8');
  const adminRoutes = [...src.matchAll(/api\.(get|post|put|patch|delete)\('(\/admin\/[^']*)'/g)].map((x) => [x[1].toUpperCase(), x[2]]);
  assert.ok(adminRoutes.length >= 2);
  for (const [m, p] of adminRoutes) {
    assert.equal((await srv.api(m, p, { body: {} })).status, 401, `${m} ${p}`);
    assert.equal((await as(a, m, p, {})).status, 403, `${m} ${p}`);
  }

  const rep = await as(owner, 'GET', '/admin/storage/report');
  assert.equal(rep.status, 200, rep.text);
  const o = rep.json.orphans;
  const names = o.files.map((f) => f.name);
  assert.ok(names.includes(stray) && names.includes(deadBlob), JSON.stringify(names));
  for (const n of [...referenced, young]) assert.ok(!names.includes(n), `${n} is not an orphan`);
  assert.ok(o.staleRows >= 1 && o.deadBlobRows >= 1 && o.unverifiable === 0, JSON.stringify(o));
  assert.ok(rep.json.total.bytes > 0 && rep.json.free > 0 && rep.json.topUsers.length > 0, JSON.stringify({ total: rep.json.total, free: rep.json.free, top: rep.json.topUsers.length }));
  const hoard = rep.json.topServers.find((x) => x.server.id === sv.id);
  assert.ok(hoard && hoard.files === 1 && hoard.bytes === CHUNK + 3, JSON.stringify(rep.json.topServers));
  const mine = rep.json.uploads.list.find((x) => x.user && x.user.id === b.id);
  assert.ok(mine && mine.received === CHUNK && mine.size === 2 * CHUNK, 'unfinished uploads are listed');
  assert.ok(rep.json.uploads.reserved >= 2 * CHUNK);
  assert.ok(fs.existsSync(path.join(UP, stray)), 'the report deletes nothing');

  // Cleanup needs the password again.
  assert.equal((await as(owner, 'POST', '/admin/storage/cleanup', {})).status, 401);
  assert.equal((await as(owner, 'POST', '/admin/storage/cleanup', { authKey: hex(32) })).status, 401);
  assert.ok(fs.existsSync(path.join(UP, stray)));

  // A sealed message this server can't open: nobody can tell which files it uses, so nothing is deleted.
  const unreadable = 'ur' + hex(6);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)', unreadable, sv.text.id, a.id,
    [crypto.randomBytes(12), crypto.randomBytes(16), crypto.randomBytes(30)].map((x) => x.toString('base64')).join('.'), Date.now());
  let c = await as(owner, 'POST', '/admin/storage/cleanup', { authKey: owner.authKey });
  assert.equal(c.status, 409, c.text);
  assert.equal(c.json.code, 'unverifiable');
  assert.ok(fs.existsSync(path.join(UP, stray)));
  srv.sql('DELETE FROM messages WHERE id = ?', unreadable);

  c = await as(owner, 'POST', '/admin/storage/cleanup', { authKey: owner.authKey });
  assert.equal(c.status, 200, c.text);
  assert.ok(c.json.files >= 2 && c.json.staleRows >= 1, c.text);
  await sleep(100);
  assert.ok(!fs.existsSync(path.join(UP, stray)) && !fs.existsSync(path.join(UP, deadBlob)), 'orphans removed');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE name = ?', deadBlob)[0].n, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE name IN (?, ?)', deadBlob, missing)[0].n, 0, 'their quota rows too');
  for (const n of [...referenced, young]) assert.ok(fs.existsSync(path.join(UP, n)), `${n} kept`);
  assert.equal((await get('/uploads/' + attached)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE name IN (?, ?)', attached, pendingBlob)[0].n, 2, 'referenced blob rows kept');
  assert.ok(fs.existsSync(partFile(sess.id)), 'unfinished uploads are not orphans');
  const log = srv.sql("SELECT admin_id, detail FROM admin_log WHERE action = 'storage_cleanup'");
  assert.equal(log.length, 1);
  assert.equal(log[0].admin_id, owner.id);
  assert.match(log[0].detail, /files/);
  // The pending blob is posted after the cleanup: it still attaches and loads.
  const late = await as(a, 'POST', `/channels/${sv.text.id}/messages`, { ciphertext: cipher(), epoch: 1, files: ['/uploads/' + pendingBlob] });
  assert.equal(late.status, 200);
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', pendingBlob)[0].message_id, late.json.id);
  await as(b, 'DELETE', `/uploads/${sess.id}`);
});

// ------------------------------------------------------------------ storage-11: your own storage
test('storage-11: Settings → Storage lists only your own files, biggest first, with where they were posted', async () => {
  const a = await srv.register('mine11');
  const b = await srv.register('theirs11');
  const sv = await sharedServer(a, b, 'Mine');
  const big = await uploadAll(a, crypto.randomBytes(2 * CHUNK));
  const small = (await single(a, crypto.randomBytes(2000))).json.url;
  await uploadAll(b, crypto.randomBytes(CHUNK));
  const m = await as(a, 'POST', `/channels/${sv.text.id}/messages`, { ciphertext: cipher(), epoch: 1, files: [big] });
  const s = (await start(a, 500)).json;
  const r = await as(a, 'GET', '/me/storage/files');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.files.map((f) => f.url), [big, small]);
  assert.deepEqual(r.json.files[0].where, { type: 'channel', serverId: sv.id, channelId: sv.text.id, messageId: m.json.id });
  assert.deepEqual(r.json.files[1].where, { type: 'unsent' });
  assert.ok(r.json.files.every((f) => !('name' in f) || f.name === undefined), 'the server has no file names to give');
  assert.deepEqual(r.json.uploads.map((x) => x.id), [s.id]);
  assert.equal((await srv.call('GET', '/api/me/storage/files')).status, 401);
  // /me/storage shows the unfinished upload as reserved room.
  const q = (await as(a, 'GET', '/me/storage')).json;
  assert.ok(q.byKind.some((k) => k.kind === 'reserved' && k.bytes === 500));
  await as(a, 'DELETE', `/uploads/${s.id}`);
});

// ------------------------------------------------------------------ storage-12: accounts and admin deletes
test('storage-12: deleting an account, or an admin removing someone’s files, cancels their unfinished uploads', async () => {
  const a = await srv.register('leaver12');
  const s = (await start(a, 3000)).json;
  await put(a, s.id, 0, crypto.randomBytes(1000));
  const del = await as(a, 'DELETE', '/me', { authKey: a.authKey, confirm: a.username });
  assert.equal(del.status, 200, del.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM upload_sessions WHERE user_id = ?', a.id)[0].n, 0);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM user_files WHERE user_id = ? AND kind = 'reserved'", a.id)[0].n, 0);
  await sleep(50);
  assert.ok(!fs.existsSync(partFile(s.id)));

  const b = await srv.register('spammer12');
  const t = (await start(b, 3000)).json;
  assert.equal((await as(owner, 'DELETE', `/admin/users/${b.id}/files`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM upload_sessions WHERE user_id = ?', b.id)[0].n, 0);
  assert.equal((await as(b, 'GET', `/uploads/${t.id}`)).status, 404);
  assert.equal(await used(b), 0);
});

// ------------------------------------------------------------------ storage-13: backups
test('storage-13: backups include finished blobs and never unfinished uploads', async () => {
  const u = await srv.register('backedup');
  const finished = crypto.randomBytes(CHUNK + 50);
  const url = await uploadAll(u, finished);
  const s = (await start(u, 2 * CHUNK)).json;
  const partial = crypto.randomBytes(CHUNK);
  assert.equal((await put(u, s.id, 0, partial)).status, 200);
  const r = await as(owner, 'POST', '/admin/backups', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verified.ok, true);
  const file = path.join(srv.dir, 'backups', 'encrypted', r.json.name);
  const key = fs.readFileSync(path.join(srv.dir, 'backup.key'), 'utf8').trim();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-restore-'));
  fs.rmSync(out, { recursive: true });
  try {
    execFileSync(process.execPath, ['server/cli.js', 'restore', file, out, key], { cwd: ROOT, stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(path.join(out, 'uploads', path.basename(url))), finished, 'the finished blob is in the backup');
    assert.ok(!fs.existsSync(path.join(out, 'upload-parts')), 'no part files folder');
    const all = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name))));
    walk(out);
    assert.ok(all.every((f) => !f.endsWith('.part')), all.join('\n'));
    assert.ok(all.every((f) => !fs.readFileSync(f).includes(partial.subarray(0, 64))), 'the unfinished bytes are nowhere in it');
    // The restored database still has the session row, but the server drops it (and its reservation) because
    // its part file isn't there: see storage-6 ("lost").
    const Database = require('better-sqlite3');
    const d = new Database(path.join(out, 'hearth.db'), { readonly: true });
    try { assert.equal(d.prepare('SELECT COUNT(*) n FROM upload_sessions WHERE id = ?').get(s.id).n, 1); } finally { d.close(); }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  await as(u, 'DELETE', `/uploads/${s.id}`);
});

// ------------------------------------------------------------------ storage-14: the real app, in Chromium
// Runs where Playwright and Chromium are installed (PLAYWRIGHT_MODULE and CHROMIUM_PATH point to them);
// skipped elsewhere.
const { pathToFileURL } = require('node:url');
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const havePlaywright = fs.existsSync(PW) && fs.existsSync(CHROME);
// STORAGE_SHOTS=<folder> saves screenshots of each step, for looking at the UI by eye.
const shot = (page, name) => (process.env.STORAGE_SHOTS ? page.screenshot({ path: path.join(process.env.STORAGE_SHOTS, `${name}.png`) }) : null);
async function browserUser(browser, name) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  const page = await context.newPage();
  await page.goto(srv.base + '/');
  await page.click('#to-register');
  await page.fill('#register-form input[name=username]', name);
  await page.fill('#register-form input[name=password]', 'correct horse battery');
  await page.fill('#register-form input[name=confirm]', 'correct horse battery');
  await page.check('#register-form input[name=tos]');
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem('hearth.token'));
  const me = (await srv.api('GET', '/bootstrap', { token, ip: '127.0.0.1' })).json.me;
  return { context, page, token, ip: '127.0.0.1', id: me.id };
}
test('storage-14 in Chromium: a 30 MB file uploads with progress, is cancelled halfway, sent again, and the other person downloads the same bytes', { skip: !havePlaywright && 'Playwright not installed' }, async () => {
  const { chromium } = await import(pathToFileURL(PW).href);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--proxy-server=direct://'] });
  const original = crypto.randomBytes(30 * MB);
  try {
    assert.equal((await setLimits({ fileMb: 40 })).status, 200);
    const alice = await browserUser(browser, 'pwalice');
    const bob = await browserUser(browser, 'pwbob');
    const server = (await as(alice, 'POST', '/servers', { name: 'Big files' })).json;
    const channel = server.channels.find((c) => c.type === 'text');
    const { code } = (await as(alice, 'POST', `/servers/${server.id}/invites`, {})).json;
    assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).status, 200);
    for (const u of [alice, bob]) { await u.page.reload(); await u.page.waitForSelector('#app:not([hidden]):not(.loading)'); }
    // Both apps online: the server key is made and handed to Bob.
    let epoch = 0;
    for (let i = 0; i < 300; i++) {
      epoch = srv.sql('SELECT key_epoch FROM servers WHERE id = ?', server.id)[0].key_epoch;
      if (epoch > 0 && srv.sql('SELECT COUNT(*) n FROM server_keys WHERE server_id = ? AND epoch = ? AND user_id = ?', server.id, epoch, bob.id)[0].n) break;
      await sleep(100);
    }
    assert.ok(epoch > 0, 'the channel has a key');
    for (const u of [alice, bob]) await u.page.evaluate((id) => { location.hash = '#c/' + id; }, channel.id);
    await alice.page.waitForSelector('.composer textarea');

    // Slow the chunks down (like a home connection), so there's time to cancel halfway.
    let chunks = 0;
    await alice.context.route('**/api/uploads/*?offset=*', async (route) => { chunks++; await sleep(350); return route.continue(); });
    await alice.page.setInputFiles('.composer input[type=file]', { name: 'holiday.mov.bin', mimeType: 'application/octet-stream', buffer: original });
    await alice.page.click('.composer .send-btn');
    await alice.page.waitForSelector('.upload-status:not([hidden])', { timeout: 30000 });
    // Real progress: the bar moves and the text counts up.
    await alice.page.waitForFunction(() => parseFloat(document.querySelector('.upload-status .bar').style.width) >= 25, null, { timeout: 60000 });
    const progressText = await alice.page.textContent('.upload-status .upload-text');
    await shot(alice.page, '1-uploading');
    assert.match(progressText, /Uploading holiday\.mov\.bin .* of 30\.0 MB \(\d+%\)/, progressText);
    const sessionsMidway = srv.sql('SELECT size, received FROM upload_sessions WHERE user_id = ?', alice.id);
    assert.equal(sessionsMidway.length, 1, 'a resumable upload is under way');
    assert.ok(sessionsMidway[0].received > 0 && sessionsMidway[0].received < sessionsMidway[0].size);
    await alice.page.click('.upload-status .upload-cancel');
    await alice.page.waitForSelector('.upload-status[hidden]', { state: 'attached', timeout: 20000 });
    await alice.page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Upload cancelled/.test(t.textContent)), null, { timeout: 10000 });
    assert.ok(await alice.page.isVisible('.pending-name:text("holiday.mov.bin")'), 'the file is back in the box, ready to send again');
    await shot(alice.page, '2-cancelled');
    for (let i = 0; i < 50 && srv.sql('SELECT COUNT(*) n FROM upload_sessions WHERE user_id = ?', alice.id)[0].n; i++) await sleep(100);
    assert.equal(srv.sql('SELECT COUNT(*) n FROM upload_sessions WHERE user_id = ?', alice.id)[0].n, 0, 'cancelling told the server');
    assert.equal((await as(alice, 'GET', '/me/storage')).json.used, 0, 'and the reserved room is free again');
    assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE uploader_id = ?', alice.id)[0].n, 0, 'nothing half-sent became a file');
    assert.equal(await alice.page.$eval('.composer', (c) => c.querySelectorAll('.msg').length), 0);

    // Send it again, this time to the end. The connection drops once on the way (the third chunk fails): the app
    // says so, waits, asks the server where it got to, and carries on by itself.
    const before = chunks;
    await alice.context.unroute('**/api/uploads/*?offset=*');
    let puts = 0;
    await alice.context.route('**/api/uploads/*?offset=*', (route) => (++puts === 3 ? route.abort('connectionreset') : route.continue()));
    await alice.page.click('.composer .send-btn');
    await alice.page.waitForSelector('.upload-status.retrying', { timeout: 30000 });
    assert.match(await alice.page.textContent('.upload-status .upload-text'), /Connection lost\. Trying again in \d+ s/);
    await shot(alice.page, '2b-retrying');
    await alice.page.waitForFunction(() => [...document.querySelectorAll('#messages .att-file .att-name')].some((n) => n.textContent === 'holiday.mov.bin'), null, { timeout: 120000 });
    assert.ok(before >= 2, `chunks were sent before cancelling (${before})`);
    assert.ok(puts > 8, `the upload carried on after the dropped chunk (${puts} chunk requests)`);
    const blobs = srv.sql('SELECT b.name, uf.size FROM blobs b JOIN user_files uf ON uf.name = b.name WHERE b.uploader_id = ? AND b.message_id IS NOT NULL', alice.id);
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].size, original.length + 28, 'the ciphertext: 12-byte IV + the file + 16-byte tag');
    assert.ok(!fs.readFileSync(path.join(srv.dir, 'uploads', blobs[0].name)).includes(original.subarray(0, 64)), 'stored encrypted');
    assert.equal(srv.sql('SELECT COUNT(*) n FROM upload_sessions WHERE user_id = ?', alice.id)[0].n, 0);

    // Bob sees the file card (name, size, kind) and downloads it: the same bytes.
    await bob.page.waitForFunction(() => [...document.querySelectorAll('#messages .att-file .att-name')].some((n) => n.textContent === 'holiday.mov.bin'), null, { timeout: 60000 });
    const card = await bob.page.textContent('#messages .att-file');
    await shot(bob.page, '3-file-card');
    assert.match(card, /30\.0 MB/);
    assert.match(card, /BIN file/);
    assert.ok(!/Copy link/.test(card), 'no link to copy for an encrypted file');
    const [dl] = await Promise.all([bob.page.waitForEvent('download', { timeout: 120000 }), bob.page.click('#messages .att-file .btn')]);
    assert.equal(dl.suggestedFilename(), 'holiday.mov.bin');
    const saved = path.join(srv.dir, 'bob-download.bin');
    await dl.saveAs(saved);
    const got = fs.readFileSync(saved);
    assert.equal(got.length, original.length);
    assert.ok(got.equals(original), 'byte for byte the same');
    fs.rmSync(saved);

    // An admin removes Alice's files (the message stays): after a reload, Bob's download says plainly that the
    // file is gone, instead of failing with a retry that can never work.
    assert.equal((await as(owner, 'DELETE', `/admin/users/${alice.id}/files`)).status, 200);
    assert.equal(await bob.page.evaluate(async (u) => (await fetch(u)).status, '/uploads/' + blobs[0].name), 404);
    await bob.page.reload(); await bob.page.waitForSelector('#app:not([hidden]):not(.loading)');
    await bob.page.evaluate((id) => { location.hash = '#c/' + id; }, channel.id);
    await bob.page.waitForSelector('#messages .att-file .btn', { timeout: 30000 });
    await bob.page.click('#messages .att-file .btn');
    await bob.page.waitForSelector('#messages .att-file.gone .att-gone', { timeout: 20000 });
    assert.match(await bob.page.textContent('#messages .att-file.gone'), /no longer available/);
    await shot(bob.page, '4-gone');
  } finally {
    await browser.close();
    await setLimits(DEFAULT_LIMITS);
  }
});

// A small PNG of one colour (w x h), for the gallery.
function png(w, h, rgb) {
  const zlib = require('node:zlib');
  const { crc32 } = require('../server/imagemeta');
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
test('storage-15 in Chromium: pictures open in a gallery with next/previous, videos and songs play from decrypted copies, big videos wait for a click', { skip: !havePlaywright && 'Playwright not installed' }, async () => {
  const { chromium } = await import(pathToFileURL(PW).href);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--proxy-server=direct://'] });
  try {
    const alice = await browserUser(browser, 'pwmedia1');
    const bob = await browserUser(browser, 'pwmedia2');
    const server = (await as(alice, 'POST', '/servers', { name: 'Gallery' })).json;
    const channel = server.channels.find((c) => c.type === 'text');
    const { code } = (await as(alice, 'POST', `/servers/${server.id}/invites`, {})).json;
    assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).status, 200);
    for (const u of [alice, bob]) { await u.page.reload(); await u.page.waitForSelector('#app:not([hidden]):not(.loading)'); }
    for (let i = 0; i < 300; i++) {
      const epoch = srv.sql('SELECT key_epoch FROM servers WHERE id = ?', server.id)[0].key_epoch;
      if (epoch > 0 && srv.sql('SELECT COUNT(*) n FROM server_keys WHERE server_id = ? AND epoch = ? AND user_id = ?', server.id, epoch, bob.id)[0].n) break;
      await sleep(100);
    }
    for (const u of [alice, bob]) await u.page.evaluate((id) => { location.hash = '#c/' + id; }, channel.id);
    await alice.page.waitForSelector('.composer textarea');
    const files = [
      { name: 'red.png', mimeType: 'image/png', buffer: png(40, 30, [220, 30, 30]) },
      { name: 'green.png', mimeType: 'image/png', buffer: png(30, 40, [30, 200, 30]) },
      { name: 'blue.png', mimeType: 'image/png', buffer: png(50, 20, [30, 30, 220]) },
      { name: 'clip.webm', mimeType: 'video/webm', buffer: crypto.randomBytes(200 * 1024) },
      { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: crypto.randomBytes(100 * 1024) },
      { name: 'notes.pdf', mimeType: 'application/pdf', buffer: crypto.randomBytes(5000) },
    ];
    await alice.page.setInputFiles('.composer input[type=file]', files);
    await alice.page.click('.composer .send-btn');
    await alice.page.waitForFunction(() => document.querySelectorAll('#messages .att-img').length === 3, null, { timeout: 60000 });
    // A big video in its own message: it waits for a click instead of downloading 21 MB by itself.
    const big = crypto.randomBytes(21 * MB);
    await alice.page.setInputFiles('.composer input[type=file]', { name: 'long.mp4', mimeType: 'video/mp4', buffer: big });
    await alice.page.click('.composer .send-btn');

    const p = bob.page;
    await p.waitForFunction(() => [...document.querySelectorAll('#messages .att-img')].filter((i) => i.src.startsWith('blob:')).length === 3, null, { timeout: 60000 });
    await p.waitForFunction(() => { const v = document.querySelector('#messages video.att-video:not([hidden])'); return v && v.src.startsWith('blob:'); }, null, { timeout: 30000 });
    await p.waitForFunction(() => { const a = document.querySelector('#messages audio.att-audio'); return a && a.src.startsWith('blob:'); }, null, { timeout: 30000 });
    const fileCard = await p.textContent('#messages .att-file');
    assert.match(fileCard, /notes\.pdf/); assert.match(fileCard, /PDF document/); assert.match(fileCard, /4\.9 KB/);
    // The decrypted pictures are the real ones (decoded at their sizes).
    const sizes = await p.$$eval('#messages .att-img', (els) => els.map((e) => [e.naturalWidth, e.naturalHeight]));
    assert.deepEqual(sizes, [[40, 30], [30, 40], [50, 20]]);
    await shot(p, '5-media');

    // The gallery: opens on the clicked picture, next/previous with the arrow keys and buttons, wraps around.
    await p.click('#messages .att-img >> nth=1');
    await p.waitForSelector('.viewer');
    const where = () => p.textContent('.viewer-count');
    assert.equal(await where(), '2 / 3');
    assert.equal(await p.textContent('.viewer-name'), 'green.png');
    await p.keyboard.press('ArrowRight');
    assert.equal(await where(), '3 / 3');
    assert.equal(await p.textContent('.viewer-name'), 'blue.png');
    await p.keyboard.press('ArrowRight');
    assert.equal(await where(), '1 / 3');
    await p.click('.viewer-nav.prev');
    assert.equal(await where(), '3 / 3');
    await p.waitForFunction(() => document.querySelector('.viewer-img').src.startsWith('blob:'));
    await shot(p, '6-gallery');
    await p.keyboard.press('Escape');
    await p.waitForSelector('.viewer', { state: 'detached' });

    // The big video: a "Play video · 21.0 MB" button, nothing downloaded until it's pressed.
    await p.waitForSelector('#messages .att-play', { timeout: 60000 });
    assert.match(await p.textContent('#messages .att-play'), /Play video · 21\.0 MB/);
    const name = srv.sql("SELECT b.name FROM blobs b JOIN user_files uf ON uf.name = b.name WHERE b.uploader_id = ? AND uf.size > ?", alice.id, 20 * MB)[0].name;
    const fetched = await p.evaluate((n) => performance.getEntriesByType('resource').filter((e) => e.name.includes(n)).length, name);
    assert.equal(fetched, 0, 'not downloaded by itself');
    await p.click('#messages .att-play');
    await p.waitForFunction(() => [...document.querySelectorAll('#messages video.att-video')].filter((v) => v.src.startsWith('blob:')).length === 2, null, { timeout: 60000 });
    await shot(p, '7-big-video');

    // Settings → Storage (Alice): her biggest files by name (taken from the messages her app can open), sizes, where.
    const a = alice.page;
    await a.click('#user-panel button[aria-label="Settings"]');
    await a.click('.set-nav-btn:has-text("Security")');
    await a.click('.set-subtab:text-is("Storage")');
    await a.waitForFunction(() => [...document.querySelectorAll('.file-row-name')].some((n) => n.textContent === 'long.mp4'), null, { timeout: 20000 })
      .catch(async (e) => { await shot(a, '8-settings-storage-failed'); console.log(await a.$$eval('.file-row-text', (els) => els.map((x) => x.textContent))); throw e; });
    const rows = await a.$$eval('.file-row-text', (els) => els.map((e) => e.textContent));
    assert.match(rows[0], /^long\.mp4.*21\.0 MB.*#general · Gallery/, rows[0]);
    assert.ok(rows.some((r) => r.startsWith('clip.webm')), rows.join('\n'));
    await shot(a, '8-settings-storage');
    await a.keyboard.press('Escape');

    // Admin → Security → Storage & limits: the report, with the per-server list.
    assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: alice.id, role: 'admin', authKey: owner.authKey })).status, 200);
    await a.reload(); await a.waitForSelector('#app:not([hidden]):not(.loading)');
    await a.click('.rail-btn[aria-label="Admin"]');
    await a.click('.admin-tab:has-text("Security"), button:has-text("Security") >> nth=0');
    await a.click('.set-subtab:has-text("Storage & limits")');
    await a.waitForSelector('h3:has-text("Where the space goes")', { timeout: 20000 });
    const adminText = await a.textContent('.admin-body, main, body');
    assert.match(adminText, /Servers using the most space/);
    assert.match(adminText, /Gallery/);
    assert.match(adminText, /Clean up orphans now/);
    await a.locator('h3:has-text("Where the space goes")').scrollIntoViewIfNeeded();
    await shot(a, '9-admin-storage');
  } finally {
    await browser.close();
  }
});

// ------------------------------------------------------------------ storage-16: the app's file helpers
test('storage-16: the decrypted-file cache revokes old copies once over budget; file kinds and labels', async () => {
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
  const F = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'files.js')).href);
  const { resolveObjectURL } = require('node:buffer');
  const c = F.makeUrlCache(1000);
  const a = c.put('a', new Blob([Buffer.alloc(400)]));
  const b = c.put('b', new Blob([Buffer.alloc(400)]));
  assert.ok(resolveObjectURL(a) && resolveObjectURL(b));
  assert.equal(c.get('a'), a, 'a is now the most recently used');
  const d = c.put('d', new Blob([Buffer.alloc(400)]));
  assert.equal(c.get('b'), null, 'the least recently used went');
  assert.equal(resolveObjectURL(b), undefined, '…and its memory was released');
  assert.ok(resolveObjectURL(a) && resolveObjectURL(d));
  assert.equal(c.size, 800);
  c.drop('a');
  assert.equal(resolveObjectURL(a), undefined);
  c.release();
  assert.equal(resolveObjectURL(d), undefined);
  assert.equal(c.count, 0);

  assert.equal(F.mediaKind('image/png'), 'img');
  assert.equal(F.mediaKind('video/mp4'), 'video');
  assert.equal(F.mediaKind('audio/mpeg'), 'audio');
  assert.equal(F.mediaKind('', 'clip.mp4'), 'video', 'older entries without a type');
  for (const t of ['text/html', 'application/pdf', '', 'application/octet-stream']) assert.equal(F.mediaKind(t, 'x.bin'), null, t);
  assert.equal(F.typeLabel('application/pdf', 'a.PDF'), 'PDF document');
  assert.equal(F.typeLabel('', 'archive.zip'), 'ZIP archive');
  assert.equal(F.typeLabel('application/octet-stream', 'blob.xyz'), 'XYZ file');
  assert.equal(F.typeLabel('', 'noext'), 'File');
  assert.equal(F.CHUNKED_ABOVE, 8 * MB);
  assert.equal(await F.sha256Hex(Buffer.from('abc')), sha(Buffer.from('abc')));
});
