// Infrastructure hardening: who may tell Hearth a visitor's address (TRUST_PROXY), the TURN relay sample, the
// update tools (checksums, no fixed /tmp names, never auto-installing a random download, plain installs not
// coming back as root) and the CI workflows (least privilege, pinned actions, locked installs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { startServer, sleep } = require('./helpers');
const { trustProxySetting, clientIp } = require('../server/proxytrust');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-infra-'));

// ------------------------------------------------------------------ TRUST_PROXY (infra-8, platform-1)
// The exact path Express takes for req.ip, with a given TRUST_PROXY value.
function reqIp(setting, remoteAddress, xff) {
  const app = express();
  app.set('trust proxy', trustProxySetting(setting));
  const req = Object.create(app.request);
  req.app = app; req.headers = xff ? { 'x-forwarded-for': xff } : {};
  req.connection = req.socket = { remoteAddress };
  return { ip: req.ip, trust: app.get('trust proxy fn') };
}

test('TRUST_PROXY values: unset = this machine only, numbers are proxy counts, false/true make sense', () => {
  assert.equal(trustProxySetting(undefined), 'loopback');
  assert.equal(trustProxySetting(''), 'loopback');
  assert.equal(trustProxySetting('1'), 1, '"1" is one proxy, not the address 0.0.0.1');
  assert.equal(trustProxySetting('2'), 2);
  assert.equal(trustProxySetting('true'), 1, 'true never means "believe every hop"');
  assert.equal(trustProxySetting('false'), false);
  assert.equal(trustProxySetting('0'), 0);
  assert.equal(trustProxySetting(' 10.0.0.5 ,  fd00::/8 '), '10.0.0.5, fd00::/8');
  // A value Express can't read still fails loudly (the server refuses to start with a clear message).
  assert.throws(() => express().set('trust proxy', trustProxySetting('caddy-container')));
});

test('by default, a visitor arriving from a private address cannot pick its own IP with X-Forwarded-For', () => {
  // Docker's port forwarding (bridge gateway 172.x.0.1), a LAN, link-local and ULA addresses: none are proxies.
  for (const peer of ['172.17.0.1', '172.18.0.1', '192.168.1.20', '10.0.0.1', '169.254.1.1', 'fd00::1', '::ffff:192.168.1.20']) {
    assert.equal(reqIp(undefined, peer, '9.9.9.9').ip, peer, peer);
  }
  // A proxy on the same machine (Caddy/nginx in front of a systemd install) still passes on the real address.
  assert.equal(reqIp(undefined, '127.0.0.1', '9.9.9.9').ip, '9.9.9.9');
  assert.equal(reqIp(undefined, '::1', '9.9.9.9').ip, '9.9.9.9');
  assert.equal(reqIp(undefined, '203.0.113.9', '9.9.9.9').ip, '203.0.113.9');
  // And that's what the server uses (no private-range preset left anywhere).
  const src = read('server/index.js');
  assert.match(src, /app\.set\('trust proxy', trustProxySetting\(process\.env\.TRUST_PROXY\)\)/);
  assert.doesNotMatch(src, /uniquelocal/);
});

test('docker-compose.yml trusts exactly its own Caddy network, which only Caddy and Hearth can join', () => {
  const compose = read('docker-compose.yml');
  const trust = /^\s+TRUST_PROXY:\s*"?([^"\n]+)"?\s*$/m.exec(compose);
  assert.ok(trust, 'the hearth service sets TRUST_PROXY');
  const subnet = /^\s+proxy:\s*\n\s+internal: true\s*\n\s+ipam:\s*\n\s+config:\s*\n\s+- subnet: ([0-9./]+)\s*$/m.exec(compose);
  assert.ok(subnet, 'the internal proxy network has a fixed subnet');
  assert.equal(trust[1].trim(), subnet[1]);
  assert.ok(!/uniquelocal|linklocal/.test(trust[1]));
  // Caddy (somewhere in that subnet) is believed; Docker's port forwarding and the LAN are not.
  const caddy = subnet[1].replace(/\.0\/\d+$/, '.3');
  assert.equal(reqIp(trust[1], caddy, '198.51.100.7').ip, '198.51.100.7');
  assert.equal(reqIp(trust[1], '172.18.0.1', '198.51.100.7').ip, '172.18.0.1');
  assert.equal(reqIp(trust[1], '127.0.0.1', '198.51.100.7').ip, '127.0.0.1');
  // It's a private address, so the plain-HTTP guard lets Caddy through (HTTPS=false behind Caddy).
  assert.match(subnet[1], /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
  // Older instructions said TRUST_PROXY=1 in .env; the compose value wins, so it can't widen this.
  assert.ok(!/^#\s+TRUST_PROXY=1/m.test(compose));
});

test('Socket.IO works out the client address exactly like req.ip', () => {
  const cases = [
    [undefined, '127.0.0.1', '9.9.9.9'], [undefined, '172.18.0.1', '9.9.9.9'], [undefined, '127.0.0.1', '1.1.1.1, 10.0.0.2'],
    [undefined, '127.0.0.1', ''], ['1', '172.18.0.1', '1.1.1.1, 9.9.9.9'], ['2', '172.18.0.1', '1.1.1.1, 9.9.9.9'],
    ['false', '127.0.0.1', '9.9.9.9'], ['10.231.47.0/28', '10.231.47.3', '5.5.5.5'], ['10.231.47.0/28', '10.231.47.3', 'not-an-ip, 5.5.5.5'],
    ['loopback, 10.231.47.0/28', '127.0.0.1', '6.6.6.6, 10.231.47.3'],
  ];
  for (const [setting, peer, xff] of cases) {
    const { ip, trust } = reqIp(setting, peer, xff);
    assert.equal(clientIp(peer, xff, trust), ip, JSON.stringify({ setting, peer, xff }));
  }
});

// Logs in over HTTP and connects over Socket.IO, both claiming `claim` in X-Forwarded-For.
async function claimBoth(srv, u, claim) {
  const http = await srv.login(u, {}, { ip: claim });
  const { io } = require('socket.io-client');
  const s = io(srv.base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { 'x-forwarded-for': claim } });
  const err = await new Promise((resolve) => { s.once('connect', () => resolve(null)); s.once('connect_error', (e) => resolve(e)); });
  s.close();
  return { httpBanned: !!(http.json && http.json.code === 'ip_banned'), socketRefused: !!err };
}

test('a proxy Hearth does not trust cannot spoof addresses over HTTP or Socket.IO', async () => {
  // Here 127.0.0.1 (where the test connects from) is not a trusted proxy: like a visitor coming through
  // Docker's port forwarding when only Caddy's network is trusted.
  const srv = await startServer({ TRUST_PROXY: '10.231.47.0/28' });
  try {
    const victim = '203.0.113.9';
    const b = await srv.api('POST', '/admin/ip-bans', { token: srv.owner.token, body: { ip: victim, reason: 'test' }, ip: victim });
    assert.equal(b.status, 200, b.text);
    const u = await srv.register(undefined, { ip: victim });
    // Claiming the banned address changes nothing: both see the real 127.0.0.1. (The socket used to take the
    // header from any private address and refuse the connection; now it agrees with HTTP.)
    assert.deepEqual(await claimBoth(srv, u, victim), { httpBanned: false, socketRefused: false });
    assert.match(srv.log, /X-Forwarded-For from 127\.0\.0\.1 was ignored/, 'the operator is told once');
  } finally { await srv.stop(); }
});

test('a trusted proxy still passes on real addresses, to HTTP and Socket.IO alike (IP bans work)', async () => {
  const srv = await startServer(); // default: this machine is the proxy
  try {
    const banned = '203.0.113.10';
    const b = await srv.api('POST', '/admin/ip-bans', { token: srv.owner.token, body: { ip: banned, reason: 'test' }, ip: srv.owner.ip });
    assert.equal(b.status, 200, b.text);
    const u = await srv.register();
    assert.deepEqual(await claimBoth(srv, u, banned), { httpBanned: true, socketRefused: true });
    assert.deepEqual(await claimBoth(srv, u, u.ip), { httpBanned: false, socketRefused: false });
  } finally { await srv.stop(); }
});

test('TRUST_PROXY=1 (the documented setting) gives each visitor behind the proxy their own limits', async () => {
  // It used to mean the address 0.0.0.1, so everyone behind Caddy shared one address and one set of limits.
  const srv = await startServer({ TRUST_PROXY: '1' });
  try {
    for (let i = 0; i < 6; i++) await srv.register(undefined, { ip: `198.51.100.${20 + i}` });
  } finally { await srv.stop(); }
  // "false" turns the header off without crashing the server (it used to: "invalid IP address: false").
  const off = await startServer({ TRUST_PROXY: 'false' });
  try { assert.equal((await off.api('GET', '/config')).status, 200); } finally { await off.stop(); }
});

// ------------------------------------------------------------------ TURN relay sample (infra-5)
test('deploy/turnserver.conf is the locked-down shared-secret setup, never a static password', () => {
  const conf = read('deploy/turnserver.conf');
  const lines = conf.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.includes('use-auth-secret'));
  assert.ok(lines.some((l) => l.startsWith('static-auth-secret=')));
  assert.ok(!lines.some((l) => /^user=|^lt-cred-mech$/.test(l)), 'no fixed user=name:password');
  for (const o of ['no-multicast-peers', 'no-loopback-peers', 'no-tcp-relay', 'no-cli']) assert.ok(lines.includes(o), o);
  for (const r of ['10.0.0.0', '172.16.0.0', '192.168.0.0', '169.254.0.0', '127.0.0.0', '100.64.0.0', 'fc00::', 'fe80::']) {
    assert.ok(lines.some((l) => l.startsWith(`denied-peer-ip=${r}`)), r);
  }
  // Same block list as the script that sets relays up for real.
  const script = read('scripts/setup-turn.sh');
  for (const l of script.split('\n').filter((x) => x.startsWith('denied-peer-ip='))) assert.ok(lines.includes(l.trim()), l);
  const env = read('.env.example');
  assert.match(env, /^# TURN_SECRET=/m);
  assert.doesNotMatch(env, /TURN_CREDENTIAL=change-me/);
});

test('static TURN credentials still work but the server warns about them', async () => {
  const srv = await startServer({ TURN_URL: 'turn:203.0.113.7:3478', TURN_USERNAME: 'hearth', TURN_CREDENTIAL: 'pw', TURN_SECRET: '' });
  try {
    assert.match(srv.log, /TURN_USERNAME\/TURN_CREDENTIAL hand everyone the same relay password/);
    const u = await srv.register();
    const ice = (await srv.api('GET', '/ice', { token: u.token, ip: u.ip })).json;
    assert.ok(ice.some((x) => x.username === 'hearth'), 'existing setups keep working');
  } finally { await srv.stop(); }
  const srv2 = await startServer({ TURN_URL: 'turn:203.0.113.7:3478', TURN_SECRET: 's'.repeat(32) });
  try {
    assert.doesNotMatch(srv2.log, /TURN_USERNAME/);
    const u = await srv2.register();
    const turn = (await srv2.api('GET', '/ice', { token: u.token, ip: u.ip })).json.find((x) => [].concat(x.urls).some((s) => s.startsWith('turn:')));
    assert.match(turn.username, /^\d+:/, 'time-limited');
  } finally { await srv2.stop(); }
});

// ------------------------------------------------------------------ fixed /tmp names in root scripts (infra-11)
test('nothing run as root writes to a fixed name in /tmp', async () => {
  const code = (p) => read(p).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const p of ['scripts/hearth-update.sh', 'scripts/harden-vps.sh', 'scripts/setup-turn.sh', 'tools/update-hearth.sh', 'tools/Update-Hearth.ps1', 'server/regions.js']) {
    assert.doesNotMatch(code(p), /\/tmp\/hearth-/, p);
  }
  // The region installer (run as root on a fresh VPS) writes its helper into a mktemp folder.
  const srv = await startServer();
  try {
    const add = await srv.api('POST', '/admin/regions', { token: srv.owner.token, ip: srv.owner.ip, body: { name: 'Test', origin: 'https://chat.example.test' } });
    assert.equal(add.status, 200, add.text);
    const token = add.json.command.match(/k=([0-9a-f]+)/)[1];
    const script = await (await fetch(`${srv.base}/regions/install/${add.json.region.id}?k=${token}`)).text();
    assert.match(script, /SETUP_DIR="\$\(mktemp -d\)"/);
    assert.match(script, /bash "\$SETUP_DIR\/setup-turn\.sh" --relay-only/);
    assert.doesNotMatch(script, /\/tmp\/hearth-/);
    if (has('bash')) assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0, 'the script parses');
  } finally { await srv.stop(); }
});

// ------------------------------------------------------------------ hearth-update.sh (infra-4, infra-11, admin-11)
const stub = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); };
const shellReady = () => ['bash', 'zip', 'unzip', 'rsync', 'sha256sum', 'tar', 'flock'].every(has);

// A fake plain-node install and an update zip for it, with stubs for everything that would touch the real
// system (id says root; stat says who owns data/; node, npm, curl only write to a log).
function updateLab({ owner = 'alice', newLock = false } = {}) {
  // The stubs make the script believe it's root, so first make sure it keeps everything in the scratch folder
  // (a version without these settings would write to /root, /etc and /usr/local/bin).
  const text = read('scripts/hearth-update.sh');
  for (const v of ['HEARTH_BACKUP_ROOT', 'HEARTH_UPDATE_CONF', 'HEARTH_UPDATE_BIN', 'HEARTH_UPDATE_LOCK']) assert.ok(text.includes(`\${${v}:-`), `hearth-update.sh honours ${v}`);
  const t = tmp();
  const app = path.join(t, 'app');
  for (const d of ['server', 'data', 'node_modules']) fs.mkdirSync(path.join(app, d), { recursive: true });
  fs.writeFileSync(path.join(app, 'server/index.js'), '// old\n');
  fs.writeFileSync(path.join(app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{"lock":1}\n');
  fs.writeFileSync(path.join(app, 'data/hearth.db'), '');
  // Older than the update's files (rsync skips files whose size and time match).
  for (const f of ['server/index.js', 'package.json']) fs.utimesSync(path.join(app, f), new Date('2020-01-01'), new Date('2020-01-01'));
  const src = path.join(t, 'src', 'hearth');
  for (const d of ['server', 'scripts']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'server/index.js'), '// new\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{\n  "version": "1.0.1"\n}\n');
  fs.writeFileSync(path.join(src, 'package-lock.json'), newLock ? '{"lock":2}\n' : '{"lock":1}\n');
  fs.copyFileSync(path.join(ROOT, 'scripts/hearth-update.sh'), path.join(src, 'scripts/hearth-update.sh'));
  const zip = path.join(t, 'update.zip');
  execFileSync('zip', ['-qr', zip, 'hearth'], { cwd: path.join(t, 'src') });
  const bin = path.join(t, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(t, 'calls.log');
  const log = `>> "${calls}"`;
  stub(bin, 'id', `if [ "$*" = "-u" ]; then echo 0; else PATH=/usr/bin:/bin exec id "$@"; fi`);
  stub(bin, 'stat', `if [ "$1" = -c ] && [ "$2" = %U ]; then echo "${owner}"; else PATH=/usr/bin:/bin exec stat "$@"; fi`);
  stub(bin, 'getent', `[ "$1 $2" = "passwd ${owner}" ] && echo "${owner}:x:1000:1000::/home/${owner}:/bin/sh"`);
  stub(bin, 'setpriv', `echo "setpriv $*" ${log}; while [ "$1" != -- ]; do case "$1" in --reuid=*) export STUB_AS="\${1#--reuid=}";; esac; shift; done; shift; exec "$@"`);
  stub(bin, 'runuser', `echo "runuser $*" ${log}; exit 1`);
  stub(bin, 'chown', `echo "chown $*" ${log}`);
  stub(bin, 'node', `echo "node $* as=\${STUB_AS:-root} cwd=$PWD" ${log}`);
  stub(bin, 'npm', `echo "npm $* as=\${STUB_AS:-root}" ${log}; mkdir -p node_modules`);
  stub(bin, 'curl', 'echo \'{"name":"Hearth"}\'');
  stub(bin, 'pgrep', 'exit 1');
  for (const n of ['docker', 'docker-compose', 'pm2', 'apt-get', 'systemctl']) stub(bin, n, 'exit 1');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HEARTH_DIR: app, HEARTH_BACKUP_ROOT: path.join(t, 'backups'),
    HEARTH_UPDATE_CONF: path.join(t, 'conf'), HEARTH_UPDATE_BIN: path.join(t, 'hearth-update'), HEARTH_UPDATE_LOCK: path.join(t, 'lock'),
  };
  const run = (...args) => spawnSync('bash', [path.join(ROOT, 'scripts/hearth-update.sh'), ...args], { env, encoding: 'utf8', timeout: 60000, input: '' });
  const calls_ = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  // Hearth is started in the background: wait for the stub to say it ran.
  const started = async () => { for (let i = 0; i < 50 && !/^node /m.test(calls_()); i++) await sleep(100); return calls_(); };
  return { t, app, zip, run, calls: calls_, started, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('updating a plain-node install restarts it as its own user, never as root', { skip: !shellReady() && 'needs bash, zip, unzip, rsync' }, async () => {
  const lab = updateLab({ owner: 'alice', newLock: true });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = await lab.started();
    // Libraries are installed by alice, and Hearth starts as alice (through setpriv, no root parent left).
    assert.match(calls, /^setpriv --reuid=alice --regid=1000 --init-groups -- npm ci/m);
    assert.match(calls, /^npm ci --omit=dev --no-audit --no-fund as=alice$/m);
    assert.match(calls, /^setpriv --reuid=alice --regid=1000 --init-groups -- sh -c exec nohup node server\/index\.js/m);
    assert.match(calls, /^node server\/index\.js as=alice /m);
    assert.doesNotMatch(calls, /as=root/);
    // The new program files stay alice's, and the update really happened.
    assert.match(calls, /^chown -R alice: /m);
    assert.equal(fs.readFileSync(path.join(lab.app, 'server/index.js'), 'utf8'), '// new\n');
  } finally { lab.done(); }
});

test('a plain install that already ran as root is restarted the same way, with a warning', { skip: !shellReady() && 'needs bash, zip, unzip, rsync' }, async () => {
  const lab = updateLab({ owner: 'root' });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Hearth runs as root/);
    const calls = await lab.started();
    assert.match(calls, /^node server\/index\.js as=root /m);
    assert.doesNotMatch(calls, /setpriv|chown/);
  } finally { lab.done(); }
});

test('hearth-update refuses an update that does not match its .sha256, before changing anything', { skip: !shellReady() && 'needs bash, zip, unzip, rsync' }, async () => {
  const lab = updateLab();
  try {
    fs.writeFileSync(lab.zip + '.sha256', `${'0'.repeat(64)}  update.zip\n`);
    const bad = lab.run('--yes', lab.zip);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /doesn't match its checksum/);
    assert.equal(fs.readFileSync(path.join(lab.app, 'server/index.js'), 'utf8'), '// old\n');
    assert.ok(!fs.readdirSync(path.join(lab.t, 'backups')).some((f) => /^\d{4}-/.test(f)), 'not even a backup was started');
    assert.equal(lab.calls(), '');
    // No path at all: it never falls back to a fixed /tmp file.
    const none = lab.run('--yes');
    assert.notEqual(none.status, 0);
    assert.match(none.stdout + none.stderr, /Which update\?/);
    // The right checksum goes through.
    const sum = crypto.createHash('sha256').update(fs.readFileSync(lab.zip)).digest('hex');
    fs.writeFileSync(lab.zip + '.sha256', `${sum}  update.zip\r\n`);
    const good = lab.run('--yes', lab.zip);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /Checksum matches/);
    await lab.started();
  } finally { lab.done(); }
});

// ------------------------------------------------------------------ tools/update-hearth.sh (admin-11, infra-11)
function toolLab() {
  const t = tmp();
  const home = path.join(t, 'home');
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(home, '.hearth-update'), 'HOST=203.0.113.5\nUSR=admin\nPORT=22\n');
  const src = path.join(t, 'src', 'hearth', 'server');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'index.js'), '//\n');
  const zip = path.join(home, 'Downloads', 'hearth-update.zip');
  execFileSync('zip', ['-qr', zip, 'hearth'], { cwd: path.join(t, 'src') });
  const bin = path.join(t, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(t, 'calls.log');
  stub(bin, 'ssh', `last="\${!#}"; case "$last" in true) exit 0 ;; 'mktemp -d') echo /tmp/tmp.Lab123; exit 0 ;; esac; printf 'ssh %s\\n' "$last" >> "${calls}"`);
  stub(bin, 'scp', `echo "scp $*" >> "${calls}"`);
  const run = (args, input = '') => spawnSync('bash', [path.join(ROOT, 'tools/update-hearth.sh'), ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', input, timeout: 30000 });
  return { t, zip, run, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''), done: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('the Mac/Linux update tool never installs a zip from Downloads that nobody picked', { skip: !['bash', 'zip', 'unzip', 'sha256sum'].every(has) && 'needs bash, zip, unzip' }, () => {
  const lab = toolLab();
  try {
    const r = lab.run([], 'y\n'); // not a terminal: there's nobody to confirm with
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /won't install a file nobody picked/);
    assert.equal(lab.calls(), '', 'nothing was uploaded or run');
  } finally { lab.done(); }
});

test('the Mac/Linux update tool checks the checksum and uploads into a private mktemp folder', { skip: !['bash', 'zip', 'unzip', 'sha256sum'].every(has) && 'needs bash, zip, unzip' }, () => {
  const lab = toolLab();
  try {
    fs.writeFileSync(lab.zip + '.sha256', `${'f'.repeat(64)}  hearth-update.zip\n`);
    const bad = lab.run([lab.zip]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /doesn't match/);
    assert.equal(lab.calls(), '', 'a zip that fails its checksum is never uploaded');

    const sum = crypto.createHash('sha256').update(fs.readFileSync(lab.zip)).digest('hex');
    fs.writeFileSync(lab.zip + '.sha256', `${sum}  hearth-update.zip\n`);
    const ok = lab.run([lab.zip]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const calls = lab.calls();
    assert.match(calls, /^scp .* admin@203\.0\.113\.5:\/tmp\/tmp\.Lab123\/update\.zip$/m);
    // On the server: the upload is checked against the confirmed file before anything is unpacked or run.
    const remote = calls.split('\n').find((l) => l.startsWith('ssh '));
    assert.ok(remote.indexOf(`echo '${sum}  update.zip' > update.zip.sha256; sha256sum -c`) < remote.indexOf('unzip -p update.zip'), remote);
    assert.match(remote, /sudo bash hearth-update\.sh \/tmp\/tmp\.Lab123\/update\.zip$/);
    assert.match(remote, /trap 'rm -rf \/tmp\/tmp\.Lab123' EXIT/);
    assert.doesNotMatch(calls, /\/tmp\/hearth-update/);
  } finally { lab.done(); }
});

test('scripts/make-update-zip.sh makes the zip the updaters expect, with a matching .sha256', { skip: !(['bash', 'zip', 'unzip', 'git'].every(has) && spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT }).status === 0) && 'needs a git checkout' }, () => {
  const out = tmp();
  try {
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/make-update-zip.sh'), out], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const version = JSON.parse(read('package.json')).version;
    const zip = path.join(out, `hearth-update-${version}.zip`);
    const [sum, name] = fs.readFileSync(zip + '.sha256', 'utf8').trim().split(/\s+/);
    assert.equal(name, path.basename(zip));
    assert.equal(sum, crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'));
    const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n');
    for (const f of ['hearth/server/index.js', 'hearth/scripts/hearth-update.sh', 'hearth/tools/update-hearth.sh']) assert.ok(list.includes(f), f);
    assert.ok(!list.some((f) => /^hearth\/(data|node_modules)\/|\/\.env$/.test(f)), 'no data, libraries or secrets');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ CI workflows (infra-3)
// Read as text (no YAML library here): each workflow file, split into jobs and steps by indentation.
const workflowFiles = () => [path.join(ROOT, '..', '.github', 'workflows'), path.join(ROOT, '.github', 'workflows')]
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => fs.readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(d, f)));

function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const head = lines.slice(0, start).join('\n');
  const jobs = {}; let cur = null;
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = []; } else if (cur) jobs[cur].push(l);
  }
  return { head, jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')])) };
}
// `run:` scripts: the inline value, or the indented block under `run: |`.
function runScripts(text) {
  const out = []; const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!/^[|>]/.test(m[2])) { out.push(m[2]); continue; }
    const block = []; const ind = m[1].length;
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > ind); j++) block.push(lines[j]);
    out.push(block.join('\n'));
  }
  return out;
}

test('workflows: read-only token except where a job must write, and only the release job writes', { skip: !workflowFiles().length && 'no workflows in this checkout' }, () => {
  for (const f of workflowFiles()) {
    const { head, jobs } = jobsOf(fs.readFileSync(f, 'utf8'));
    assert.match(head, /^permissions:\s*\n\s+contents: read\s*$/m, `${f}: top-level permissions are read-only`);
    assert.doesNotMatch(head, /: write/, f);
    for (const [name, body] of Object.entries(jobs)) {
      if (!/contents: write/.test(body)) continue;
      assert.equal(name, 'release', `${f}: only the release job may write repository contents (${name} does)`);
    }
  }
});

test('workflows: every action pinned to a commit, checkouts drop the token, installs are locked', { skip: !workflowFiles().length && 'no workflows in this checkout' }, () => {
  for (const f of workflowFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)) {
      if (m[1].startsWith('./') || m[1].startsWith('docker://')) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]} is pinned to a full commit SHA`);
    }
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (!/uses:\s*actions\/checkout@/.test(l)) return;
      const ind = l.search(/\S/);
      const step = [];
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > ind); j++) step.push(lines[j]);
      assert.match(step.join('\n'), /persist-credentials: false/, `${f}:${i + 1} checkout keeps no token in .git/config`);
    });
    for (const s of runScripts(text)) {
      assert.doesNotMatch(s, /\bnpm (install|i)\b/, `${f}: npm ci, not npm install: ${s}`);
      assert.doesNotMatch(s, /\bnpx (--yes|-y)\b/, `${f}: npx must not download packages: ${s}`);
      assert.doesNotMatch(s, /\$\{\{/, `${f}: values go into scripts through env:, not \${{ }}: ${s}`);
    }
  }
  // The Android build has the lockfile its npm ci needs, with the icon tool at an exact version.
  const mobile = JSON.parse(read('mobile/package.json'));
  assert.ok(fs.existsSync(path.join(ROOT, 'mobile/package-lock.json')));
  assert.match(mobile.devDependencies['@capacitor/assets'], /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(read('mobile/package-lock.json'));
  assert.deepEqual(lock.packages[''].devDependencies, mobile.devDependencies, 'lockfile matches package.json');
});

test('workflows: installers only reach everyone\'s apps from tags and the default branch', { skip: !workflowFiles().length && 'no workflows in this checkout' }, () => {
  for (const f of workflowFiles()) {
    const { jobs } = jobsOf(fs.readFileSync(f, 'utf8'));
    const pub = jobs['publish-to-vps'];
    if (!pub) continue;
    const cond = /^\s{4}if:\s*>?-?\s*\n?([\s\S]*?)\n\s{4}runs-on:/m.exec(pub);
    assert.ok(cond, `${f}: publish-to-vps has a condition`);
    assert.doesNotMatch(cond[1], /workflow_dispatch/, `${f}: a manual run from any branch must not publish`);
    assert.match(cond[1], /default_branch/);
    assert.match(pub, /fingerprint: \$\{\{ secrets\.VPS_HOST_FINGERPRINT \}\}/, `${f}: the host key can be pinned`);
  }
});
