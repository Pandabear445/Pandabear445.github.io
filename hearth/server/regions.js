// Regions: small, cheap servers in other parts of the world that relay calls for people near them.
//
// Chat itself stays on this one server (one database = no syncing, no split-brain; a message crossing the
// world takes ~0.2 s, which nobody notices). What distance hurts is calls that can't connect directly and
// need a relay, so those relays go near people.
//
// How the linking works:
//   1. Admin → Regions → "Add a region" gives a one-line install command for a fresh VPS.
//   2. That command installs the relay (coturn) with this server's shared secret, plus a tiny agent that
//      checks in here every minute with its address, load and traffic.
//   3. Calls automatically include every region that checked in recently; each person's app measures which
//      relays answer fastest from where they are and uses those.
//   4. A region that stops checking in is dropped from calls after 3 minutes and comes back by itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile, execFileSync } = require('child_process');

module.exports = function setupRegions(ctx) {
  const { api, app, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, newId, DATA_DIR, ROOT, stepUp, auditLog } = ctx;
  const now = () => Date.now();
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const ALIVE_MS = 3 * 60000;

  const rows = () => db.prepare('SELECT * FROM regions ORDER BY created_at').all();
  const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const isAlive = (r) => r.last_seen && now() - r.last_seen < ALIVE_MS;
  // TURN addresses of the regions that are up right now: [{ id, name, urls }]
  const liveRelays = () => rows().filter((r) => isAlive(r)).map((r) => ({ id: r.id, name: r.name, urls: parse(r.turn_urls, []) })).filter((r) => r.urls.length);

  const ensureSecret = () => {
    let s = getSetting('turnSecret') || process.env.TURN_SECRET || '';
    if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('turnSecret', s); }
    return s;
  };

  // The public key of this server's own self-signed certificate, so the install command can pin it
  // (curl then talks only to this exact server, even without a trusted certificate).
  function pinnedKey() {
    try {
      const pem = fs.readFileSync(path.join(DATA_DIR, 'cert.pem'), 'utf8');
      const der = new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
      return 'sha256//' + crypto.createHash('sha256').update(der).digest('base64');
    } catch { return ''; }
  }
  // Pin only when this server answers with its own self-signed certificate (no domain / Caddy in front).
  const pinFor = (origin) => (origin.startsWith('https:') && process.env.HTTPS !== 'false' ? pinnedKey() : '');
  const cleanOrigin = (o) => { try { const u = new URL(String(o)); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };

  function regionOut(r) {
    const st = parse(r.stats, {});
    return {
      id: r.id, name: r.name, ip: r.ip || null, urls: parse(r.turn_urls, []), alive: !!isAlive(r), lastSeen: r.last_seen || null, createdAt: r.created_at,
      waitingForInstall: !r.last_seen, installOpen: (r.setup_until || 0) > now(),
      load: st.load ?? null, cpus: st.cpus ?? null, mem: st.mem ?? null, mbps: st.mbps ?? null, monthGb: st.monthGb ?? null, month: st.month || null, relayUp: st.relay !== false, version: st.version || null,
      backup: st.backup ? { ready: !!st.backup.ready, files: st.backup.files, usedMb: st.backup.usedMb, freeMb: st.backup.freeMb, last: st.backup.last || null } : null,
    };
  }

  // ------------------------------------------------------------------ admin
  api.get('/admin/regions', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    res.json({ regions: rows().map(regionOut), mainTurn: String(getSetting('turnUrls') || process.env.TURN_URL || '').split(',').filter(Boolean), secretSet: !!(getSetting('turnSecret') || process.env.TURN_SECRET) });
  });
  const installCommand = (origin, id, token) => { const pin = pinFor(origin); return `curl -fsSL${pin ? `k --pinnedpubkey '${pin}'` : ''} '${origin}/regions/install/${id}?k=${token}' | sudo bash`; };
  // An install command hands the machine it runs on this server's relay secret, and a linked region becomes a
  // relay for everyone's calls and a place every backup is copied to. So making one needs the password again
  // (like seeing the backup key), and adding, reinstalling, renaming or removing a region is always logged.
  api.post('/admin/regions', auth, wrap(async (req, res) => {
    requireInstanceAdmin(req.userId);
    await stepUp(req, req.body);
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) fail(400, 'Give the region a name, like "Frankfurt" or "US West".');
    if (rows().length >= 12) fail(400, 'Up to 12 regions.');
    const origin = cleanOrigin(b.origin);
    if (!origin) fail(400, 'Missing this server’s address.');
    ensureSecret();
    const id = newId(); const token = crypto.randomBytes(24).toString('hex');
    // Remember the address the admin uses: that's the one the region must check in at (behind a proxy, this
    // server can't always tell its own public https:// address).
    db.prepare('INSERT INTO regions (id, name, token_hash, setup_until, stats, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, sha(token), now() + 24 * 3600000, JSON.stringify({ origin }), now());
    auditLog(req, 'region_added', id, `${name} (${origin})`);
    res.json({ region: regionOut(db.prepare('SELECT * FROM regions WHERE id = ?').get(id)), command: installCommand(origin, id, token) });
  }));
  // A new install command for an existing region (new token; the old one stops working).
  api.post('/admin/regions/:id/reinstall', auth, wrap(async (req, res) => {
    requireInstanceAdmin(req.userId);
    await stepUp(req, req.body);
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    if (!r) fail(404, 'No such region.');
    const origin = cleanOrigin((req.body || {}).origin);
    if (!origin) fail(400, 'Missing this server’s address.');
    ensureSecret();
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE regions SET token_hash = ?, setup_until = ?, stats = ? WHERE id = ?').run(sha(token), now() + 24 * 3600000, JSON.stringify({ ...parse(r.stats, {}), origin }), r.id);
    auditLog(req, 'region_reinstalled', r.id, `${r.name} (${origin})`);
    res.json({ command: installCommand(origin, r.id, token) });
  }));
  api.patch('/admin/regions/:id', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) fail(400, 'Name required.');
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    if (!r) fail(404, 'No such region.');
    db.prepare('UPDATE regions SET name = ? WHERE id = ?').run(name, r.id);
    auditLog(req, 'region_renamed', r.id, `${r.name} \u2192 ${name}`);
    res.json({ ok: true });
  });
  api.delete('/admin/regions/:id', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    if (!r) fail(404, 'No such region.');
    db.prepare('DELETE FROM regions WHERE id = ?').run(r.id);
    auditLog(req, 'region_deleted', r.id, `${r.name}${r.ip ? ` (${r.ip})` : ''}`);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ the install script a new region downloads
  const checkToken = (r, token) => r && token && r.token_hash.length === 64 && crypto.timingSafeEqual(Buffer.from(sha(token)), Buffer.from(r.token_hash));
  app.get('/regions/install/:id', (req, res) => {
    rateLimit('regioninstall:' + req.ip, 20, 3600000);
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    const token = String(req.query.k || '');
    res.type('text/plain');
    if (!checkToken(r, token) || (r.setup_until || 0) < now()) return res.status(403).send('echo "This install link has expired or was replaced. Make a new one in Hearth: Admin → Regions." >&2; exit 1\n');
    const origin = cleanOrigin(parse(r.stats, {}).origin) || `${req.protocol}://${req.get('host')}`;
    const turnScript = fs.readFileSync(path.join(ROOT, 'scripts', 'setup-turn.sh'), 'utf8');
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    res.send(`#!/usr/bin/env bash
# Hearth region "${r.name.replace(/[^\w .,-]/g, '')}" — installs a call relay and links it to ${origin}
set -Eeuo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this as root (or with sudo)." >&2; exit 1; }
MAIN=${q(origin)}
REGION=${q(r.id)}
TOKEN=${q(token)}
PIN=${q(pinFor(origin))}

cat > /tmp/hearth-setup-turn.sh <<'HEARTH_TURN_EOF'
${turnScript}
HEARTH_TURN_EOF
bash /tmp/hearth-setup-turn.sh --relay-only --managed --secret ${q(ensureSecret())}
rm -f /tmp/hearth-setup-turn.sh

# Off-site backups: an upload-only SFTP account that can write into one folder and nothing else. The main
# server copies its encrypted backups here (useless without the backup key, which never leaves it).
echo "▸ Making a safe place for your main server's encrypted backups…"
if command -v sshd >/dev/null 2>&1 && [ -f /etc/ssh/sshd_config ] && [ -f /etc/ssh/ssh_host_ed25519_key.pub ]; then
  id hearth-backup >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hearth-backup --no-create-home --shell /usr/sbin/nologin hearth-backup
  install -d -m 755 -o root -g root /var/lib/hearth-backup
  install -d -m 700 -o hearth-backup -g hearth-backup /var/lib/hearth-backup/backups
  install -d -m 700 /etc/hearth-region
  touch /etc/ssh/hearth-backup.keys && chmod 644 /etc/ssh/hearth-backup.keys
  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.hearth-bak
  sed -i '/^# BEGIN hearth-backup/,/^# END hearth-backup/d' /etc/ssh/sshd_config
  cat >> /etc/ssh/sshd_config <<'SSHD_EOF'
# BEGIN hearth-backup (added by Hearth: an upload-only account for your main server's encrypted backups)
Match User hearth-backup
  AuthorizedKeysFile /etc/ssh/hearth-backup.keys
  ForceCommand internal-sftp -d /backups
  ChrootDirectory /var/lib/hearth-backup
  PasswordAuthentication no
  AllowTcpForwarding no
  AllowAgentForwarding no
  X11Forwarding no
  PermitTTY no
# END hearth-backup
SSHD_EOF
  install -d -m 755 /run/sshd 2>/dev/null || true # sshd's own folder; its config check fails without it
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    touch /etc/hearth-region/backup-ready
  else
    cp /etc/ssh/sshd_config.hearth-bak /etc/ssh/sshd_config
    rm -f /etc/hearth-region/backup-ready
    echo "  Skipped: the SSH settings didn't pass their check, so they were left exactly as they were."
  fi
else
  echo "  Skipped: no SSH server here."
fi

echo "▸ Linking this region to Hearth…"
install -d -m 700 /etc/hearth-region
printf 'MAIN=%s\\nREGION=%s\\nTOKEN=%s\\nPIN=%s\\n' "$MAIN" "$REGION" "$TOKEN" "$PIN" > /etc/hearth-region/env
chmod 600 /etc/hearth-region/env
cat > /usr/local/bin/hearth-region-agent <<'AGENT_EOF'
#!/usr/bin/env bash
# Checks in with the main Hearth server: this relay's address, load and traffic. Runs every minute.
set -u
. /etc/hearth-region/env
STATE=/etc/hearth-region/state
IP="$(cat /etc/hearth-region/ip 2>/dev/null || true)"
if [ -z "$IP" ] || [ "$(( $(date +%s) - $(stat -c %Y /etc/hearth-region/ip 2>/dev/null || echo 0) ))" -gt 21600 ]; then
  NEW="$(curl -fsS --max-time 8 https://api.ipify.org || curl -fsS --max-time 8 https://ifconfig.me || true)"
  [ -n "$NEW" ] && { IP="$NEW"; echo "$IP" > /etc/hearth-region/ip; }
fi
IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1)}' | head -1)"
TX=0; RX=0
if [ -n "$IFACE" ] && [ -r "/sys/class/net/$IFACE/statistics/tx_bytes" ]; then
  TX="$(cat /sys/class/net/$IFACE/statistics/tx_bytes)"; RX="$(cat /sys/class/net/$IFACE/statistics/rx_bytes)"
fi
LOAD="$(cut -d' ' -f1 /proc/loadavg)"
CPUS="$(nproc 2>/dev/null || echo 1)"
MEM="$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {if (t) printf "%d", (t-a)*100/t; else print 0}' /proc/meminfo)"
RELAY=true; systemctl is-active --quiet coturn || RELAY=false
UP="$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)"
# Backup space: where the main server can reach SSH, this server's own SSH key (so the main server only ever
# talks to this exact machine), and how full it is.
[ -d /run/sshd ] || install -d -m 755 /run/sshd 2>/dev/null || true
SSH_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')"; [ -n "$SSH_PORT" ] || SSH_PORT=22
HOSTKEY="$(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || true)"
BREADY=false; [ -f /etc/hearth-region/backup-ready ] && BREADY=true
BDIR=/var/lib/hearth-backup/backups
BUSED="$(du -sm $BDIR 2>/dev/null | cut -f1)"; BFREE="$(df -Pm /var/lib 2>/dev/null | awk 'NR == 2 {print $4}')"; BFILES="$(ls $BDIR/*.hbk 2>/dev/null | wc -l)"
curl -fsS \${PIN:+-k --pinnedpubkey "$PIN"} --max-time 15 -X POST -H 'Content-Type: application/json' -H "X-Region-Token: $TOKEN" \\
  -d "{\\"ip\\":\\"$IP\\",\\"tx\\":$TX,\\"rx\\":$RX,\\"load\\":$LOAD,\\"cpus\\":$CPUS,\\"mem\\":$MEM,\\"relay\\":$RELAY,\\"uptime\\":$UP,\\"ssh\\":{\\"port\\":$SSH_PORT,\\"hostKey\\":\\"$HOSTKEY\\",\\"ready\\":$BREADY,\\"usedMb\\":\${BUSED:-0},\\"freeMb\\":\${BFREE:-0},\\"files\\":\${BFILES:-0}},\\"version\\":2}" \\
  "$MAIN/api/regions/$REGION/heartbeat" -o "$STATE" || true
# The main server's key may upload backups (and nothing else: the account is upload-only, see sshd_config).
KEY="$(sed -n 's/.*"backupKey":"\\(ssh-ed25519 [A-Za-z0-9+/=]*\\).*/\\1/p' "$STATE" 2>/dev/null | head -1)"
if [ "$BREADY" = true ] && [ -n "$KEY" ]; then
  LINE="restrict $KEY hearth-main"
  [ "$(cat /etc/ssh/hearth-backup.keys 2>/dev/null)" = "$LINE" ] || printf '%s\\n' "$LINE" > /etc/ssh/hearth-backup.keys
fi
# Keep the newest copies (the main server says how many); unfinished uploads go after a day.
KEEP="$(sed -n 's/.*"keep":\\([0-9][0-9]*\\).*/\\1/p' "$STATE" 2>/dev/null | head -1)"; [ -n "$KEEP" ] || KEEP=14
ls -1t $BDIR/*.hbk 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
find $BDIR -name '*.part' -mmin +1440 -delete 2>/dev/null || true
AGENT_EOF
chmod 755 /usr/local/bin/hearth-region-agent
cat > /etc/systemd/system/hearth-region.service <<'UNIT_EOF'
[Unit]
Description=Hearth region check-in
[Service]
Type=oneshot
ExecStart=/usr/local/bin/hearth-region-agent
UNIT_EOF
cat > /etc/systemd/system/hearth-region.timer <<'UNIT_EOF'
[Unit]
Description=Hearth region check-in every minute
[Timer]
OnBootSec=20
OnUnitActiveSec=60
AccuracySec=5
[Install]
WantedBy=timers.target
UNIT_EOF
systemctl daemon-reload
systemctl enable --now hearth-region.timer >/dev/null
/usr/local/bin/hearth-region-agent
if grep -q '"ok":true' /etc/hearth-region/state 2>/dev/null; then
  printf '\\033[1;32m✓ This region is linked.\\033[0m It shows as online in Hearth → Admin → Regions, and calls start using it within a minute.\\n'
else
  printf '\\033[1;31m✗ The relay is installed but couldn'"'"'t reach Hearth at %s yet.\\033[0m It keeps trying every minute.\\n' "$MAIN"
  cat /etc/hearth-region/state 2>/dev/null || true; echo
fi
echo "If this VPS provider has its own firewall (in their control panel), open UDP+TCP 3478 and UDP 49160-49400 there."
`);
  });

  // ------------------------------------------------------------------ check-ins from the regions
  // A region's address becomes a relay address everyone's app is given, and the place this server copies backups
  // to over SSH, so it has to be a real public address. Addresses are parsed (not matched as text), so every way
  // of writing an internal one is refused: "0:0:0:0:0:0:0:1" is loopback, and "::ffff:a00:1" is 10.0.0.1.
  // (Two lists: one BlockList would also match every IPv4 address against the IPv6 rules for mapped addresses.)
  const NOT_PUBLIC_V4 = new net.BlockList();
  const NOT_PUBLIC_V6 = new net.BlockList();
  for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) NOT_PUBLIC_V4.addSubnet(a, bits, 'ipv4');
  // IPv6: unspecified, loopback and the old IPv4-compatible form (::/96), IPv4-mapped (::ffff:0:0/96), the NAT64,
  // 6to4 and Teredo forms that carry an IPv4 address inside, unique-local, link-local, old site-local, multicast.
  for (const [a, bits] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) NOT_PUBLIC_V6.addSubnet(a, bits, 'ipv6');
  const publicIp = (ip) => {
    const s = String(ip || '');
    let ok;
    if (net.isIPv4(s)) ok = !NOT_PUBLIC_V4.check(s, 'ipv4');
    else if (net.isIPv6(s) && /^[0-9a-f:]{2,39}$/i.test(s)) ok = !NOT_PUBLIC_V6.check(s, 'ipv6'); // no zone ids or dotted tails
    else return false;
    return ok || process.env.REGIONS_ALLOW_PRIVATE === '1';
  };
  api.post('/regions/:id/heartbeat', wrap(async (req, res) => {
    rateLimit('regionbeat:' + req.ip, 30, 60000);
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    if (!checkToken(r, String(req.get('x-region-token') || ''))) fail(403, 'Unknown region or token.');
    const b = req.body || {};
    const ip = String(b.ip || '').trim();
    if (!publicIp(ip)) fail(400, 'No public IP address.');
    const host = ip.includes(':') ? `[${ip}]` : ip;
    const urls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
    const st = parse(r.stats, {});
    const t = now();
    const tx = Math.max(0, +b.tx || 0); const rx = Math.max(0, +b.rx || 0);
    const month = new Date().toISOString().slice(0, 7);
    if (st.month !== month) { st.month = month; st.monthBytes = 0; }
    if (st.lastTx !== undefined && st.lastAt && tx >= st.lastTx && rx >= st.lastRx) {
      const sent = (tx - st.lastTx) + (rx - st.lastRx);
      st.monthBytes = (st.monthBytes || 0) + sent;
      st.mbps = Math.round((sent * 8) / Math.max(1, (t - st.lastAt) / 1000) / 1e4) / 100;
    }
    Object.assign(st, { lastTx: tx, lastRx: rx, lastAt: t, load: Math.round((+b.load || 0) * 100) / 100, cpus: Math.max(1, +b.cpus || 1), mem: Math.min(100, Math.max(0, +b.mem || 0)), relay: b.relay !== false, uptime: +b.uptime || 0, version: +b.version || 1 });
    st.monthGb = Math.round(((st.monthBytes || 0) / 1e9) * 100) / 100;
    // Backup space (agent version 2+): the SSH port and this region's own host key, so copies only ever go to
    // this exact machine.
    const sh = b.ssh && typeof b.ssh === 'object' ? b.ssh : null;
    if (sh) {
      const port = Math.floor(+sh.port);
      const hostKey = String(sh.hostKey || '').trim();
      st.backup = {
        ...(st.backup || {}), ready: sh.ready === true && /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/.test(hostKey) && port > 0 && port < 65536,
        port, hostKey, files: Math.max(0, Math.floor(+sh.files || 0)), usedMb: Math.max(0, Math.floor(+sh.usedMb || 0)), freeMb: Math.max(0, Math.floor(+sh.freeMb || 0)),
      };
    }
    db.prepare('UPDATE regions SET ip = ?, turn_urls = ?, last_seen = ?, stats = ?, setup_until = NULL WHERE id = ?').run(ip, JSON.stringify(st.relay ? urls : []), t, JSON.stringify(st), r.id);
    const key = backupPublicKey();
    res.json({ ok: true, name: r.name, ...(key ? { backupKey: key, keep: KEEP_COPIES } : {}) });
  }));

  // ------------------------------------------------------------------ off-site backups on the regions
  // Each region that has backup space (installed or reinstalled with Hearth 1.25+) keeps copies of this server's
  // encrypted backups, so losing this machine doesn't lose everything. Copies go over SFTP with this server's
  // own key, to an account that can only upload into one folder, and only to the host key the region reported
  // (checked strictly, so nobody can pretend to be the region). The region keeps the newest KEEP_COPIES.
  const KEEP_COPIES = Math.max(2, Math.min(60, +process.env.REGION_BACKUP_KEEP || 14));
  const KEY_DIR = path.join(DATA_DIR, 'region-backup');
  const KEY_FILE = path.join(KEY_DIR, 'id_ed25519');
  let pubCache = null;
  function backupPublicKey() {
    if (process.env.REGION_BACKUPS === 'off') return null;
    if (pubCache) return pubCache;
    try {
      if (!fs.existsSync(KEY_FILE)) {
        fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hearth-main', '-f', KEY_FILE], { stdio: 'ignore', timeout: 20000 });
      }
      const pub = fs.readFileSync(KEY_FILE + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
      if (/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/.test(pub)) pubCache = pub;
    } catch { /* no ssh-keygen here (install openssh-client): region backups stay off */ }
    return pubCache;
  }
  const backupTargets = () => rows().filter((r) => isAlive(r) && r.ip).map((r) => ({ r, b: parse(r.stats, {}).backup })).filter(({ b }) => b && b.ready);
  function sftpPut(r, b, file) {
    return new Promise((resolve) => {
      const name = path.basename(file);
      const host = r.ip.includes(':') ? `[${r.ip}]` : r.ip;
      const known = path.join(KEY_DIR, `known_hosts_${r.id}`);
      const batch = path.join(KEY_DIR, `batch_${r.id}`);
      fs.writeFileSync(known, `${b.port === 22 && !r.ip.includes(':') ? r.ip : `[${r.ip}]:${b.port}`} ${b.hostKey}\n`, { mode: 0o600 });
      fs.writeFileSync(batch, `put "${file.replace(/"/g, '')}" "${name}.part"\nrename "${name}.part" "${name}"\n`, { mode: 0o600 });
      execFile('sftp', ['-b', batch, '-o', 'LogLevel=ERROR', '-i', KEY_FILE, '-P', String(b.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', `hearth-backup@${host}`],
      { timeout: 4 * 3600000, env: { ...process.env, HOME: KEY_DIR } }, (err, stdout, stderr) => {
        const ok = !err;
        const lines = String(stderr || (err && err.message) || '').trim().split('\n').filter((l) => !/^(Warning|Connection closed)/.test(l));
        const why = lines.find((l) => /verification failed|REMOTE HOST IDENTIFICATION/.test(l)) ? 'The region\u2019s identity changed (host key mismatch), so nothing was sent. Reinstall the region if you rebuilt it.'
          : lines.find((l) => /Permission denied/.test(l)) ? 'The region refused this server\u2019s key (it updates within a minute of the region checking in).'
            : lines.pop() || (err && err.killed ? 'Took too long.' : 'The copy failed.');
        resolve({ id: r.id, name: r.name, ok, error: ok ? undefined : why.slice(0, 200) });
      });
    });
  }
  // Copies one encrypted backup (.hbk) to every region with backup space. Returns { <region id>: { name, ok, error, at } }.
  async function copyBackup(file) {
    if (!/\.hbk$/.test(file) || !backupPublicKey()) return {};
    const out = {};
    for (const { r, b } of backupTargets()) {
      const res = await sftpPut(r, b, file);
      out[r.id] = { name: res.name, ok: res.ok, error: res.error, at: now() };
      const st = parse(db.prepare('SELECT stats FROM regions WHERE id = ?').get(r.id)?.stats, {});
      if (st.backup) { st.backup.last = { ok: res.ok, error: res.error, at: now(), file: path.basename(file) }; db.prepare('UPDATE regions SET stats = ? WHERE id = ?').run(JSON.stringify(st), r.id); }
    }
    return out;
  }

  return { liveRelays, copyBackup, backupPublicKey };
};
