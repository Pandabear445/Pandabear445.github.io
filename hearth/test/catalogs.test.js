// Getting Hearth to people: the published Docker image (its workflow and deploy/compose.image.yml), the app store
// templates in deploy/catalogs/, the license, and the landing site's sitemap, robots.txt, canonical links and
// structured data. Files are read as text (there's no YAML library here), like infra-hardening.test.js does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, '..'); // the landing site (pandabear445.github.io/Hearth-chat) and .github/, when this is the whole repository
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;
const IMAGE = 'ghcr.io/pandabear445/hearth';
const CAT = 'deploy/catalogs';
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

// The services of a compose file, each as its indented text (2-space service names under `services:`).
function services(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  assert.ok(start >= 0, 'has services:');
  const out = {}; let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // the next top-level key
    const m = /^ {2}([\w.-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; out[cur] = []; } else if (cur) out[cur].push(l);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
}
// What a service does, without comments, blank lines and where its image comes from.
const essential = (block) => block.split('\n').map((l) => l.trimEnd())
  .filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\s+(build|image):/.test(l));

const COMPOSES = {
  'deploy/compose.image.yml': 'hearth',
  [`${CAT}/casaos/docker-compose.yml`]: 'hearth',
  [`${CAT}/umbrel/hearth/docker-compose.yml`]: 'web',
  [`${CAT}/dokploy/hearth/docker-compose.yml`]: 'hearth',
  [`${CAT}/coolify/hearth.yaml`]: 'hearth',
};
const catalogFiles = () => {
  const out = [];
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach((e) => {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p); else if (/\.(ya?ml|xml|json|toml)$/.test(e.name)) out.push(p);
  });
  walk(CAT);
  return out;
};

test('license: MIT at the root and in hearth/, and inside the image', () => {
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License\n\nCopyright \(c\) \d{4} \S/);
  assert.match(lic, /Permission is hereby granted, free of charge/);
  assert.match(lic, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
  if (fs.existsSync(path.join(SITE, 'index.html'))) assert.equal(fs.readFileSync(path.join(SITE, 'LICENSE'), 'utf8'), lic, 'the repository root has the same license');
  assert.match(read('Dockerfile'), /^COPY package\.json LICENSE \.\/$/m, 'the license travels with the image');
});

test('deploy/compose.image.yml: the same hardened services as docker-compose.yml, with the published image', () => {
  const built = read('docker-compose.yml');
  const pulled = read('deploy/compose.image.yml');
  assert.doesNotMatch(pulled, /^\s+build:/m, 'never both build and image');
  const b = services(built); const p = services(pulled);
  for (const name of ['hearth-perms', 'hearth']) {
    assert.match(p[name], new RegExp(`^ {4}image: ${IMAGE.replace(/\./g, '\\.')}:${VERSION.replace(/\./g, '\\.')}$`, 'm'), name);
    assert.deepEqual(essential(p[name]), essential(b[name]), `${name} is configured exactly like docker-compose.yml's`);
  }
  // Caddy: the Caddyfile comes inline (one file to download), the rest of the lock-down is the same.
  for (const l of essential(b.caddy).filter((x) => !/Caddyfile/.test(x))) assert.ok(essential(p.caddy).includes(l), `caddy: ${l.trim()}`);
  assert.match(p.caddy, /configs:\n\s+- source: caddyfile\n\s+target: \/etc\/caddy\/Caddyfile/);
  const caddyfile = /^configs:\n {2}caddyfile:\n {4}content: \|\n([\s\S]*?)\n\S/m.exec(pulled);
  assert.ok(caddyfile, 'inline Caddyfile');
  assert.match(caddyfile[1], /^ {6}\{\$\$HEARTH_DOMAIN\} \{$/m, 'the domain comes from HEARTH_DOMAIN ("$$" is a literal $ in compose)');
  for (const d of ['reverse_proxy hearth:3000', 'lb_try_duration 30s', '-Server', '-Via', 'header ?Strict-Transport-Security']) {
    assert.ok(read('deploy/Caddyfile').includes(d) && caddyfile[1].includes(d), d);
  }
  // The private proxy network and the TRUST_PROXY default that names it.
  const net = (y) => /^ {2}proxy:\n {4}internal: true\n {4}ipam:\n {6}config:\n {8}- subnet: ([0-9./]+)$/m.exec(y)[1];
  assert.equal(net(pulled), net(built));
  assert.match(pulled, new RegExp(`TRUST_PROXY: "\\$\\{TRUST_PROXY:-${net(pulled).replace(/\./g, '\\.')}\\}"`));
});

test('catalogs: every template pulls this version\'s published image, never builds or floats', () => {
  const files = [...catalogFiles(), 'deploy/compose.image.yml'];
  assert.ok(files.length >= 9, files.join(', '));
  let refs = 0;
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /^\s*build:/m, `${f}: no build`);
    assert.doesNotMatch(text, /docker\.sock|privileged:\s*true|network_mode:\s*host|--privileged/, `${f}: no host access`);
    // Image references: compose `image:` lines and Unraid's <Repository>.
    for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)|<Repository>([^<]*)<\/Repository>/gm)) {
      const ref = m[1] || m[2];
      if (!/pandabear445\/hearth/.test(ref)) { assert.match(ref, /^caddy:\d/, `${f}: ${ref}`); continue; }
      refs++;
      assert.match(ref, new RegExp(`^${IMAGE.replace(/\./g, '\\.')}:${VERSION.replace(/\./g, '\\.')}(@sha256:[0-9a-f]{64})?$`),
        `${f}: ${ref} is this release (${VERSION}), never latest or untagged`);
    }
    assert.doesNotMatch(text, /pandabear445\/hearth:latest/, f);
  }
  assert.ok(refs >= 7, 'every template names the image');
  assert.match(read(`${CAT}/casaos/docker-compose.yml`), new RegExp(`^ {2}version: "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
  assert.match(read(`${CAT}/umbrel/hearth/umbrel-app.yml`), new RegExp(`^version: "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
  assert.equal(JSON.parse(read(`${CAT}/dokploy/hearth/meta.json`)).version, VERSION);
});

test('catalogs: every template runs Hearth unprivileged (uid 1000, read-only, no capabilities, no-new-privileges)', () => {
  const perms = services(read('docker-compose.yml'))['hearth-perms'];
  for (const [f, name] of Object.entries(COMPOSES)) {
    const svc = services(read(f));
    const s = svc[name];
    assert.ok(s, `${f}: service ${name}`);
    assert.match(s, /^ {4}user: "1000:1000"$/m, `${f}: runs as uid 1000`);
    assert.match(s, /^ {4}read_only: true$/m, `${f}: read-only`);
    assert.match(s, /^ {4}cap_drop: \[ALL\]$|^ {4}cap_drop:\n {6}- ALL$/m, `${f}: no capabilities`);
    assert.doesNotMatch(s, /cap_add/, `${f}: none added back`);
    assert.match(s, /no-new-privileges:true/, `${f}: can't gain any`);
    assert.match(s, /^ {4}pids_limit: \d+$/m, `${f}: process limit`);
    assert.match(s, /\/tmp:size=64m,mode=1777/, `${f}: a small private /tmp`);
    // The one-shot owner fix, where a template has one, is docker-compose.yml's.
    if (svc['hearth-perms']) {
      const same = (l) => !/^\s+- (\.\/data|\/DATA\/)|^\s+logging:/.test(l); // where the data lives, and log rotation
      assert.deepEqual(essential(svc['hearth-perms']).filter(same), essential(perms).filter(same), `${f}: hearth-perms`);
      assert.match(s, /hearth-perms:\n\s+condition: service_completed_successfully/, `${f}: waits for it`);
    }
  }
  // Unraid can't run a second container: Hearth starts as root with exactly the four capabilities the entrypoint
  // needs to hand /data over and drop to uid 1000 (see the next test), and nothing else.
  const xml = read(`${CAT}/unraid/hearth.xml`);
  const extra = /<ExtraParams>([^<]*)<\/ExtraParams>/.exec(xml)[1];
  assert.match(xml, /<Privileged>false<\/Privileged>/);
  assert.match(extra, /--read-only\b/);
  assert.match(extra, /--cap-drop=ALL\b/);
  assert.deepEqual([...extra.matchAll(/--cap-add=(\w+)/g)].map((m) => m[1]).sort(), ['CHOWN', 'DAC_READ_SEARCH', 'SETGID', 'SETUID']);
  assert.match(extra, /--security-opt=no-new-privileges:true/);
  assert.match(extra, /--pids-limit=\d+/);
  assert.match(extra, /--tmpfs \/tmp:size=64m,mode=1777/);
  assert.doesNotMatch(extra, /--user\b/, 'the entrypoint switches user itself');
});

test('the entrypoint needs only four capabilities and keeps none (the Unraid template and plain docker run)', {
  skip: !(process.getuid && process.getuid() === 0 && has('setpriv') && spawnSync('getent', ['passwd', '1000']).status === 0)
    && 'needs root, setpriv and a user 1000',
}, () => {
  // A data folder as Docker leaves it (root's), holding a folder that already belongs to uid 1000 (0700) with a
  // root-owned file inside: listing that folder as root needs DAC_READ_SEARCH.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-catalogs-'));
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(path.join(data, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(data, 'sub', 'f'), 'x');
    fs.writeFileSync(path.join(data, 'top'), 'x');
    fs.chownSync(path.join(data, 'sub'), 1000, 1000);
    fs.chmodSync(path.join(data, 'sub'), 0o700);
    // Docker's --cap-drop=ALL plus the four --cap-add (the bounding set) and no-new-privileges, started as root.
    const r = spawnSync('setpriv', ['--bounding-set=-all,+chown,+dac_read_search,+setuid,+setgid', '--no-new-privs', '--',
      '/bin/sh', path.join(ROOT, 'deploy/docker-entrypoint.sh'),
      '/bin/sh', '-c', 'id -u; id -g; grep -E "^(CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs):" /proc/self/status'],
    { env: { PATH: process.env.PATH, DATA_DIR: data }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [uid, gid, ...status] = r.stdout.trim().split('\n');
    assert.equal(uid, '1000');
    assert.equal(gid, '1000');
    const caps = Object.fromEntries(status.map((l) => l.split(':').map((x) => x.trim())));
    for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) assert.equal(caps[k], '0000000000000000', `${k}: nothing left`);
    assert.equal(caps.NoNewPrivs, '1');
    for (const p of ['', 'top', 'sub', 'sub/f']) {
      const st = fs.statSync(path.join(data, p));
      assert.deepEqual([st.uid, st.gid], [1000, 1000], `${p || 'data'} belongs to uid 1000`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalogs: https everywhere, and only a proxy that is the sole way in is trusted with visitors\' addresses', () => {
  // Unraid and CasaOS: Hearth's own HTTPS (the default), opened as https.
  const xml = read(`${CAT}/unraid/hearth.xml`);
  assert.match(xml, /<WebUI>https:\/\/\[IP\]:\[PORT:3000\]\/<\/WebUI>/);
  assert.match(xml, /<Config Name="HTTPS" Target="HTTPS" Default="true"[^>]*>true<\/Config>/);
  assert.match(xml, /<Config Name="Data" Target="\/data" Default="\/mnt\/user\/appdata\/hearth"/);
  assert.match(xml, /Target="PUBLIC_HOSTS"/);
  const casa = read(`${CAT}/casaos/docker-compose.yml`);
  assert.match(casa, /^ {2}scheme: https$/m);
  assert.match(casa, /^ {2}port_map: "3000"$/m);
  assert.doesNotMatch(casa, /^\s+-?\s*HTTPS[:=]/m, "CasaOS keeps Hearth's own HTTPS");
  // Umbrel: umbrelOS serves https (requiresHttps needs manifestVersion 2.0); Hearth speaks http on the app network.
  const app = read(`${CAT}/umbrel/hearth/umbrel-app.yml`);
  assert.match(app, /^manifestVersion: 2(\.\d+)?$/m);
  assert.match(app, /^requiresHttps: true$/m);
  assert.match(app, /^id: hearth$/m, 'the id is the folder name');
  assert.match(app, /^storage:\n {2}dataRoot: data$/m);
  assert.match(app, /^gallery: \[\]$/m);
  assert.doesNotMatch(app, /^icon:/m, 'official packages carry no icon');
  assert.match(app, /^defaultUsername: ""\ndefaultPassword: ""$/m, 'the first sign-up makes the owner');
  const port = Number(/^port: (\d+)$/m.exec(app)[1]);
  assert.ok(![80, 443, 2000].includes(port) && !(port >= 40000 && port <= 49999), `port ${port} is free for apps`);
  assert.ok(fs.existsSync(path.join(ROOT, CAT, 'umbrel/hearth/data/.gitkeep')), 'the data folder ships with the package');
  const umbrel = services(read(`${CAT}/umbrel/hearth/docker-compose.yml`));
  assert.match(umbrel.app_proxy, /APP_HOST: hearth_web_1\n\s+#[^\n]*\n\s+APP_PORT: 3000|APP_HOST: hearth_web_1\n\s+APP_PORT: 3000/);
  assert.match(umbrel.web, /HTTPS: "false"/);
  assert.match(umbrel.web, /TRUST_PROXY: "\$\{NETWORK_IP\}\/16"/);
  assert.match(umbrel.web, /- \$\{APP_DATA_DIR\}\/data:\/data/);
  // Behind a proxy: plain http inside, no published port, so the proxy is the only way in and a hop count is safe.
  for (const f of [`${CAT}/umbrel/hearth/docker-compose.yml`, `${CAT}/dokploy/hearth/docker-compose.yml`, `${CAT}/coolify/hearth.yaml`]) {
    assert.doesNotMatch(read(f), /^\s+ports:/m, `${f}: publishes no port`);
  }
  const dok = services(read(`${CAT}/dokploy/hearth/docker-compose.yml`)).hearth;
  assert.match(dok, /HTTPS: "false"/);
  assert.match(dok, /TRUST_PROXY: \$\{TRUST_PROXY:-1\}/);
  assert.match(dok, /expose:\n\s+- 3000/);
  assert.doesNotMatch(read(`${CAT}/dokploy/hearth/docker-compose.yml`), /container_name|networks:/, 'Dokploy adds its own');
  const toml = read(`${CAT}/dokploy/hearth/template.toml`);
  assert.match(toml, /\[\[config\.domains\]\]\nserviceName = "hearth"\nport = 3000\nhost = "\$\{main_domain\}"/);
  const meta = JSON.parse(read(`${CAT}/dokploy/hearth/meta.json`));
  assert.equal(meta.id, 'hearth');
  assert.ok(fs.existsSync(path.join(ROOT, CAT, 'dokploy/hearth', meta.logo)), 'the logo is in the folder');
  const cool = read(`${CAT}/coolify/hearth.yaml`);
  assert.match(cool, /^# port: 3000$/m);
  assert.match(cool, /- SERVICE_URL_HEARTH_3000/);
  assert.match(cool, /- HTTPS=false/);
  assert.match(cool, /- TRUST_PROXY=\$\{TRUST_PROXY:-1\}/);
  // compose.image.yml keeps Hearth's HTTPS by default and trusts only its own Caddy (the previous tests).
  assert.doesNotMatch(read('deploy/compose.image.yml'), /^\s+HTTPS:/m);
});

// A template that puts Hearth straight onto a public domain gets a certificate, which shows up in public certificate
// logs within minutes; the first account to sign up becomes the owner. So those templates make a random registration
// code at install, and the server refuses even the very first sign-up without it.
test('catalogs: templates on a public domain make a registration code, so a stranger can\'t sign up first and own the server', async () => {
  const toml = read(`${CAT}/dokploy/hearth/template.toml`);
  const made = /^registration_code = "\$\{password:(\d+)\}"$/m.exec(toml);
  assert.ok(made && +made[1] >= 12, 'Dokploy makes a random code of 12 characters or more for each install');
  assert.match(toml, /^\[config\.env\]\nREGISTRATION_CODE = "\$\{registration_code\}"$/m);
  assert.match(services(read(`${CAT}/dokploy/hearth/docker-compose.yml`)).hearth, /^ {6}REGISTRATION_CODE: \$\{REGISTRATION_CODE:\?[^}]+\}$/m, 'and won\'t start without one');
  assert.match(services(read(`${CAT}/coolify/hearth.yaml`)).hearth, /^ {6}- REGISTRATION_CODE=\$\{SERVICE_PASSWORD_REGISTRATION\}$/m, 'Coolify makes one too');
  for (const f of [`${CAT}/dokploy/hearth/docker-compose.yml`, `${CAT}/coolify/hearth.yaml`, `${CAT}/dokploy/hearth/template.toml`]) {
    assert.doesNotMatch(read(f), /REGISTRATION_CODE\s*[=:]\s*("\s*"|\$\{REGISTRATION_CODE:-\}|\s*$)/m, `${f}: never an empty code`);
  }
  assert.match(read(`${CAT}/README.md`), /random\s+registration code at install/);
  assert.match(read('deploy/compose.image.yml'), /^# machine others can reach \(a VPS\), first put REGISTRATION_CODE=/m);
  // What the code does on a brand-new server: no account exists yet, and still nobody signs up without it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-regcode-'));
  const port = await new Promise((resolve) => { const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test', REGISTRATION_CODE: 'Gv7qT2mXc9LpR4sW', REGISTRATION_OPEN: '', ADMIN_USERS: '' } });
  try {
    let config = null;
    for (let i = 0; i < 150 && !config; i++) {
      try { const r = await fetch(base + '/api/config'); if (r.ok) config = await r.json(); } catch { /* not up yet */ }
      if (!config) { assert.equal(child.exitCode, null, 'Hearth started'); await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(config, 'Hearth started');
    assert.equal(config.registrationRequiresCode, true, 'the sign-up form asks for the code');
    const crypto = require('node:crypto');
    const body = { username: 'first', authKey: crypto.randomBytes(32).toString('hex'), kdfSalt: crypto.randomBytes(16).toString('base64'),
      publicKey: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      encPrivateKey: crypto.randomBytes(120).toString('base64'), acceptTos: config.termsVersion || undefined };
    const post = (b) => fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    for (const code of [undefined, '', 'gv7qt2mxc9lpr4sw', 'Gv7qT2mXc9LpR4s']) {
      const r = await post({ ...body, code });
      assert.equal(r.status, 403, `code ${JSON.stringify(code)}`);
      assert.match(r.json.error, /registration code/);
    }
    // With the code, sign-up goes on to the robot check (it isn't refused for the code).
    const ok = await post({ ...body, code: 'Gv7qT2mXc9LpR4sW' });
    assert.equal(ok.status, 400);
    assert.equal(ok.json.code, 'captcha');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the image workflow
const imageWorkflow = path.join(SITE, '.github', 'workflows', 'hearth-image.yml');
function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = {}; let cur = null;
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = []; } else if (cur) jobs[cur].push(l);
  }
  return { head: lines.slice(0, start).join('\n'), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')])) };
}
const stepsOf = (job) => job.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));

test('the image workflow: tags must match package.json, the scan passes in a read-only job before anything is pushed, and only tagged releases publish', { skip: !fs.existsSync(imageWorkflow) && 'no image workflow in this checkout' }, () => {
  const text = fs.readFileSync(imageWorkflow, 'utf8');
  const { head, jobs } = jobsOf(text);
  assert.match(head, /^on:\n {2}push:\n {4}tags: \['hearth-v\*'\]\n {2}workflow_dispatch:$/m, 'release tags and manual runs, nothing else');
  assert.deepEqual(Object.keys(jobs).sort(), ['check', 'publish', 'scan']);
  // Only "publish" pushes, logs in or may write packages, and only for hearth-v* tags in the production environment.
  const pub = jobs.publish;
  assert.match(pub, /^ {4}if: startsWith\(github\.ref, 'refs\/tags\/hearth-v'\)\n {4}needs: scan\n {4}runs-on:/m, 'a release tag, after the scan passed');
  assert.match(pub, /^ {4}environment: production$/m);
  assert.match(pub, /^ {4}permissions:\n {6}contents: read\n {6}packages: write\b/m);
  assert.match(jobs.check, /^ {4}if: \$\{\{ !startsWith\(github\.ref, 'refs\/tags\/hearth-v'\) \}\}\n {4}needs: scan$/m, 'a branch run only checks');
  for (const name of ['scan', 'check']) {
    for (const forbidden of [/push: true/, /docker\/login-action/, /: write\b/, /secrets\./, /environment:/]) assert.doesNotMatch(jobs[name], forbidden, `${name}: ${forbidden}`);
  }
  // The scanner is outside code that downloads its own program and database, and takes the job's token by default:
  // it runs only in "scan", whose token can only read. Nothing that job builds or caches reaches the push.
  assert.match(jobs.scan, /^ {4}permissions:\n {6}contents: read\b/m, 'scan: read-only, said where it runs');
  for (const [name, body] of Object.entries(jobs)) {
    if (name !== 'scan') assert.doesNotMatch(body, /aquasecurity\/|trivy/i, `${name}: no scanner next to the build that gets pushed`);
  }
  assert.doesNotMatch(text, /cache-(from|to):|actions\/cache@|upload-artifact|download-artifact/, 'no cache or artifact passes from the scan job to the publish job');
  const scanSteps = stepsOf(jobs.scan);
  const inScan = (re) => scanSteps.findIndex((s) => re.test(s));
  const scan = inScan(/aquasecurity\/trivy-action@/);
  assert.ok(inScan(/load: true/) >= 0 && inScan(/load: true/) < scan, 'build to scan, then scan');
  assert.match(scanSteps[scan], /image-ref: hearth:scan[\s\S]*severity: CRITICAL,HIGH[\s\S]*ignore-unfixed: true[\s\S]*exit-code: '1'/);
  // The tag is checked against package.json before anything else, in the scan (so a mismatch stops the release
  // early) and again in publish.
  const tagChecks = [scanSteps[inScan(/The tag matches hearth\/package\.json/)]];
  const steps = stepsOf(pub);
  const at = (re) => steps.findIndex((s) => re.test(s));
  const tagCheck = at(/The tag matches hearth\/package\.json/);
  assert.ok(tagCheck >= 0 && tagCheck < at(/docker\/build-push-action/));
  tagChecks.push(steps[tagCheck]);
  assert.match(tagChecks[0], /^ {8}if: startsWith\(github\.ref, 'refs\/tags\/hearth-v'\)$/m);
  for (const t of tagChecks) {
    assert.ok(t, 'tag check');
    assert.match(t, /TAG: \$\{\{ github\.ref_name \}\}/);
    assert.match(t, /require\('\.\/hearth\/package\.json'\)\.version/);
    assert.match(t, /"\$TAG" != "hearth-v\$version"/);
  }
  // Log in, then push.
  const login = at(/docker\/login-action@/); const push = at(/push: true/);
  assert.ok(login >= 0 && login < push, 'log in, then push');
  assert.match(steps[push], /platforms: linux\/amd64,linux\/arm64/);
  assert.match(steps[push], /provenance: mode=max/);
  assert.match(steps[push], /sbom: true/);
  assert.match(steps[push], /context: hearth\n/);
  assert.match(steps[login], /registry: ghcr\.io[\s\S]*password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  // Version, major.minor and latest, from the tag; the image name in lower case.
  const meta = steps[at(/docker\/metadata-action@/)];
  assert.match(meta, /type=semver,pattern=\{\{version\}\},match=\^hearth-v\(\\d\+\\\.\\d\+\\\.\\d\+\)\$/);
  assert.match(meta, /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\},match=/);
  assert.match(meta, /flavor: latest=auto/);
  assert.match(meta, /org\.opencontainers\.image\.licenses=MIT/);
  assert.match(text, /echo "image=ghcr\.io\/\$\{OWNER,,\}\/hearth"/);
  // The only secret anywhere is the workflow's own token, and the build takes no arguments or secrets.
  assert.deepEqual([...new Set([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))], ['GITHUB_TOKEN']);
  assert.doesNotMatch(text, /build-args:|secret-files:|secret-envs:|^\s+secrets:/m);
});

test('nothing secret can reach the image: the Dockerfile copies only program files, .dockerignore keeps data out', () => {
  const allowed = new Set(['package.json', 'package-lock.json', 'LICENSE', 'server', 'public', 'scripts/setup-turn.sh', 'deploy/docker-entrypoint.sh']);
  for (const m of read('Dockerfile').matchAll(/^COPY (.+)$/gm)) {
    const args = m[1].split(/\s+/);
    if (args[0].startsWith('--from=')) continue;
    for (const src of args.slice(0, -1)) assert.ok(allowed.has(src), `COPY ${src}`);
  }
  const ignored = read('.dockerignore').split('\n').map((l) => l.trim());
  for (const p of ['data', 'data-backup*', '.env', '.env.*', '*.key', '*.pem', '*.db', '*.hbk', '.git']) assert.ok(ignored.includes(p), p);
});

// ------------------------------------------------------------------ the landing site (pandabear445.github.io/Hearth-chat)
const siteFile = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');
test('landing site: sitemap, robots.txt, canonical links, structured data, the comparison page, no scripts', { skip: !fs.existsSync(path.join(SITE, 'index.html')) && 'no landing site in this checkout' }, () => {
  const pages = fs.readdirSync(SITE).filter((f) => /\.html$/.test(f)).sort();
  assert.deepEqual(pages, ['child-safety.html', 'code-signing.html', 'delete-account.html', 'discord-alternative.html', 'index.html', 'privacy.html']);
  const url = (f) => (f === 'index.html' ? 'https://pandabear445.github.io/Hearth-chat/' : `https://pandabear445.github.io/Hearth-chat/${f}`);
  const locs = [...siteFile('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  assert.deepEqual(locs, pages.map(url).sort(), 'the sitemap lists every page');
  assert.match(siteFile('robots.txt'), /^Sitemap: https:\/\/pandabear445\.github\.io\/Hearth-chat\/sitemap\.xml$/m);
  assert.doesNotMatch(siteFile('robots.txt'), /^Disallow: \/\s*$/m);
  const config = siteFile('_config.yml');
  for (const f of [...pages, 'robots.txt', 'sitemap.xml']) assert.doesNotMatch(config, new RegExp(`^\\s+- ${f.replace(/\./g, '\\.')}$`, 'm'), `${f} is published`);
  for (const f of pages) {
    const html = siteFile(f);
    const canon = [...html.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);
    assert.deepEqual(canon, [url(f)], `${f}: one canonical link, its own address`);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, `${f}: phone width`);
    // No analytics or any other script: the only script allowed is structured data.
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.equal(m[1].trim(), 'type="application/ld+json"', `${f}: <script${m[1]}>`);
    assert.doesNotMatch(html, /Pandabear445\.github\.io/, `${f}: links use the repository's name`);
  }
  // Structured data on the home page.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(siteFile('index.html'))[1]);
  assert.ok(ld['@type'].includes('SoftwareApplication'));
  assert.equal(ld.name, 'Hearth');
  assert.equal(ld.applicationCategory, 'CommunicationApplication');
  assert.equal(ld.offers.price, '0');
  assert.equal(ld.license, 'https://opensource.org/licenses/MIT');
  assert.equal(ld.codeRepository, 'https://github.com/Pandabear445/Hearth-chat');
  for (const os_ of ['Windows', 'macOS', 'Linux', 'Android', 'Web']) assert.match(ld.operatingSystem, new RegExp(os_));
  // The comparison page: linked from the menu and the FAQ, shareable, and honest about limits.
  const index = siteFile('index.html');
  assert.match(index, /<a href="discord-alternative\.html">vs Discord<\/a>/);
  assert.match(index, /How is this different from Discord\?<\/summary>\s*<p>[^\n]*<a href="discord-alternative\.html">/);
  const cmp = siteFile('discord-alternative.html');
  for (const tag of ['og:title', 'og:description', 'og:image', 'og:url']) assert.match(cmp, new RegExp(`<meta property="${tag}" content="[^"]+">`), tag);
  for (const tag of ['twitter:card', 'twitter:title', 'twitter:image']) assert.match(cmp, new RegExp(`<meta name="${tag}" content="[^"]+">`), tag);
  assert.match(cmp, /hearth\/docs\/IMPORT\.md/);
  assert.match(cmp, /hearth\/SECURITY\.md/);
  assert.match(cmp, /No independent security audit yet/);
  assert.match(cmp, /When to pick something else/);
  // Honest about what supporters can get (more storage and bigger files, where the server's owner offers them; see
  // server/money.js perks) and about calls showing people each other's IP address (SECURITY.md §4).
  for (const [f, html] of [['discord-alternative.html', cmp], ['index.html', index]]) {
    assert.doesNotMatch(html, /no paid features|no ads or paid tiers/i, `${f}: supporters can get perks`);
    assert.match(html, /more storage and bigger files|extra storage/, `${f}: says what supporters can get`);
  }
  assert.match(cmp, /<th scope="row">IP addresses in calls<\/th>/);
  assert.match(cmp, /<li><strong>People in a call can see each other's IP address<\/strong>/);
  const sec4 = 'https://github.com/Pandabear445/Hearth-chat/blob/main/hearth/SECURITY.md#4-what-each-adversary-can-still-do-honest-limits';
  assert.ok(cmp.includes(sec4), 'links the honest limits in SECURITY.md');
  assert.match(read('SECURITY.md'), /^## 4\. What each adversary can still do \(honest limits\)$/m, 'and that heading exists');
  assert.match(read('SECURITY.md'), /in a call without a region, participants get each other's local and public addresses/);
  // On a phone the table turns into one card per row (no sideways scrolling), and every cell says which side it is.
  assert.match(cmp, /@media \(max-width: 720px\) \{\s*\.compare-table, \.compare-table tbody, \.compare-table tr, \.compare-table th, \.compare-table td \{ display: block;/);
  const cells = [...cmp.matchAll(/<td\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(cells.length >= 20 && cells.every((a) => /data-label="(Hearth|Discord)"/.test(a)), 'every cell is labelled');
});

// The pages Google Play's reviewers read. They name menus, buttons and numbers from the app, so those are checked
// against the code too: renaming one there means fixing the page.
test('landing site: the privacy policy, account deletion and child safety pages', { skip: !fs.existsSync(path.join(SITE, 'privacy.html')) && 'no landing site in this checkout' }, () => {
  const pages = fs.readdirSync(SITE).filter((f) => /\.html$/.test(f));
  for (const f of pages) assert.match(siteFile(f), /<a href="privacy\.html">Privacy<\/a>/, `${f}: links the privacy policy`);
  for (const f of ['index.html', 'discord-alternative.html', 'code-signing.html']) {
    assert.match(siteFile(f), /<a href="delete-account\.html">Delete account<\/a>/, `${f}: links account deletion`);
    assert.match(siteFile(f), /<a href="child-safety\.html">Child safety<\/a>/, `${f}: links the child safety standards`);
  }
  const titleOf = (html) => (/<title>([^<]+)<\/title>/.exec(html) || [])[1];
  const privacy = siteFile('privacy.html');
  const del = siteFile('delete-account.html');
  const kids = siteFile('child-safety.html');
  assert.equal(titleOf(privacy), 'Hearth Privacy Policy');
  assert.equal(titleOf(del), 'Delete your Hearth account');
  assert.equal(titleOf(kids), 'Hearth child safety standards');
  for (const [f, html] of [['privacy.html', privacy], ['delete-account.html', del], ['child-safety.html', kids]]) {
    assert.match(html, /<a href="mailto:[^"]+">/, `${f}: an address to write to`);
    assert.match(html, /kappachat\.duckdns\.org/, `${f}: says which server it covers`);
    assert.match(html, /Pandabear445/, `${f}: names the developer`);
  }
  assert.match(privacy, /<a href="delete-account\.html">/);
  assert.match(privacy, /<a href="child-safety\.html">/);
  assert.match(privacy, /hearth\/SECURITY\.md/);
  assert.match(kids, /<a href="privacy\.html">/);
  assert.match(kids, /NCMEC/);
  // The minimum age matches the default terms.
  assert.match(read('server/index.js'), /You must be old enough to use online services where you live \(at least 13\)/);
  for (const [f, html] of [['privacy.html', privacy], ['child-safety.html', kids]]) assert.match(html, /You must be 13 or older to use Hearth/, f);
  // The way to delete an account in the app (Settings → Security → Security & storage → Delete account).
  const settings = read('public/js/settings.js');
  assert.ok(settings.includes("['account', 'Security', 'lock']") && settings.includes("['account', 'Security & storage']"), 'Settings → Security');
  for (const s of ["section('Delete account'", "'Delete my account'", "label: 'Delete forever'", "'Export my data'"]) assert.ok(settings.includes(s), s);
  for (const s of ['<strong>Security</strong>', 'Security &amp; storage', '<strong>Delete account</strong>', '<strong>Delete my account</strong>', '<strong>Delete forever</strong>', 'Export my data']) {
    assert.ok(del.includes(s), `delete-account.html: ${s}`);
  }
  // Deleting an account for someone who can't sign in (the page's "Can't sign in?"), or one that belongs to a child under
  // 13 (privacy.html, child-safety.html): staff do it in Admin → Users, with the same erasure as Settings → Delete
  // account. What the page says goes and stays matches that erasure.
  const index = read('server/index.js');
  assert.match(index, /^api\.delete\('\/admin\/users\/:id', auth, adminOnly, wrap\(async/m);
  assert.match(index, /eraseAccount\(row\);\n {2}adminLog\(req, 'account_deleted_by_staff'/);
  assert.match(read('public/js/admin.js'), /label: 'Delete account\\u2026'/);
  assert.match(del, /we delete the account from the server's admin tools\. That erases and keeps exactly what deleting it in the app does/);
  for (const [f, html] of [['privacy.html', privacy], ['child-safety.html', kids]]) assert.match(html, /If we learn that an account belongs to someone under 13, we (suspend it and )?delete it\./, f);
  const erase = index.slice(index.indexOf('function eraseAccount('), index.indexOf('\n}\n', index.indexOf('function eraseAccount(')));
  for (const t of ['saved_messages', 'read_states', 'mention_marks', 'notify_prefs', 'user_prefs', 'former_members']) assert.ok(erase.includes(`'${t}'`), `eraseAccount deletes ${t}`);
  assert.match(erase, /DELETE FROM profile_comments WHERE profile_id = \?/);
  assert.match(erase, /UPDATE bots SET disabled = 1 WHERE owner_id = \?/);
  for (const s of ['Your saved messages and their notes', 'and the comments people left on it', '<strong>Bots you made</strong> stay, but they\'re turned off',
    '<strong>GIFs you added to the server\'s GIF library</strong>', 'and for Ko-fi the name and message you typed there']) assert.ok(del.includes(s), `delete-account.html: ${s}`);
  // Bots are on the list of who else gets data.
  assert.match(privacy, /<tr><td><strong>Bots in a server<\/strong><\/td>/);
  // Reporting: the message menu item, the category, and child-safety reports staying with the instance's staff.
  assert.match(read('public/js/app.js'), /label: 'Report message'/);
  assert.match(read('public/js/app.js'), /label: 'Send report'/);
  assert.match(read('public/js/admin.js'), /child_safety: 'Child safety'/);
  assert.match(read('server/index.js'), /const REPORT_CATEGORIES = \[[^\]]*'child_safety'/);
  assert.match(read('server/serveraudit.js'), /const STAFF_ONLY = \['child_safety'\];/);
  for (const s of ['<strong>Report message</strong>', '<strong>Child safety</strong>', '<strong>Send report</strong>']) assert.ok(kids.includes(s), `child-safety.html: ${s}`);
  // Retention numbers the pages give, from the code's defaults: 30 days for signed-out devices, a week of daily
  // backups, 14 on each region.
  assert.match(read('server/index.js'), /DELETE FROM sessions WHERE \(revoked_at IS NOT NULL AND revoked_at < \?\)/);
  assert.match(read('server/index.js'), /\.run\(t - 30 \* 86400000, t - 30 \* 86400000, /);
  assert.match(read('server/index.js'), /return \{ enabled: true, keep: 7, /);
  assert.match(read('server/regions.js'), /REGION_BACKUP_KEEP \|\| 14\)/);
  for (const [f, html] of [['privacy.html', privacy], ['delete-account.html', del]]) {
    assert.match(html, /30 days/, `${f}: signed-out devices`);
    assert.match(html, /newest 14/, `${f}: region backups`);
    assert.match(html, /off-site storage/, `${f}: off-site copies`);
  }
});
