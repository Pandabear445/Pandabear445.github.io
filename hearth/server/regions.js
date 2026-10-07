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

module.exports = function setupRegions(ctx) {
  const { api, app, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, newId, DATA_DIR, ROOT } = ctx;
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
    };
  }

  // ------------------------------------------------------------------ admin
  api.get('/admin/regions', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    res.json({ regions: rows().map(regionOut), mainTurn: String(getSetting('turnUrls') || process.env.TURN_URL || '').split(',').filter(Boolean), secretSet: !!(getSetting('turnSecret') || process.env.TURN_SECRET) });
  });
  const installCommand = (origin, id, token) => { const pin = pinFor(origin); return `curl -fsSL${pin ? `k --pinnedpubkey '${pin}'` : ''} '${origin}/regions/install/${id}?k=${token}' | sudo bash`; };
  api.post('/admin/regions', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
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
    res.json({ region: regionOut(db.prepare('SELECT * FROM regions WHERE id = ?').get(id)), command: installCommand(origin, id, token) });
  });
  // A new install command for an existing region (new token; the old one stops working).
  api.post('/admin/regions/:id/reinstall', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    if (!r) fail(404, 'No such region.');
    const origin = cleanOrigin((req.body || {}).origin);
    if (!origin) fail(400, 'Missing this server’s address.');
    ensureSecret();
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE regions SET token_hash = ?, setup_until = ?, stats = ? WHERE id = ?').run(sha(token), now() + 24 * 3600000, JSON.stringify({ ...parse(r.stats, {}), origin }), r.id);
    res.json({ command: installCommand(origin, r.id, token) });
  });
  api.patch('/admin/regions/:id', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) fail(400, 'Name required.');
    db.prepare('UPDATE regions SET name = ? WHERE id = ?').run(name, req.params.id);
    res.json({ ok: true });
  });
  api.delete('/admin/regions/:id', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    db.prepare('DELETE FROM regions WHERE id = ?').run(req.params.id);
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
curl -fsS \${PIN:+-k --pinnedpubkey "$PIN"} --max-time 15 -X POST -H 'Content-Type: application/json' -H "X-Region-Token: $TOKEN" \\
  -d "{\\"ip\\":\\"$IP\\",\\"tx\\":$TX,\\"rx\\":$RX,\\"load\\":$LOAD,\\"cpus\\":$CPUS,\\"mem\\":$MEM,\\"relay\\":$RELAY,\\"uptime\\":$UP,\\"version\\":1}" \\
  "$MAIN/api/regions/$REGION/heartbeat" -o "$STATE" || true
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
  const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const publicIp = (ip) => {
    const m = String(ip || '').match(IPV4);
    if (m) {
      const [a, b] = [+m[1], +m[2]];
      if (m.slice(1).some((x) => +x > 255)) return false;
      return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) || process.env.REGIONS_ALLOW_PRIVATE === '1';
    }
    return /^[0-9a-f:]{3,39}$/i.test(ip) && !/^(::1|fe80:|fc|fd)/i.test(ip);
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
    db.prepare('UPDATE regions SET ip = ?, turn_urls = ?, last_seen = ?, stats = ?, setup_until = NULL WHERE id = ?').run(ip, JSON.stringify(st.relay ? urls : []), t, JSON.stringify(st), r.id);
    res.json({ ok: true, name: r.name });
  }));

  return { liveRelays };
};
