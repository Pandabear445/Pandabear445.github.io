// Who a request is really from. A reverse proxy (Caddy, nginx) passes the visitor's address on in the
// X-Forwarded-For header, but anyone can send that header, so it only counts when the request arrives from a
// proxy we trust. IP bans, every "per network" rate limit and the audit log's addresses depend on this.
//
// TRUST_PROXY (environment):
//   unset            only this machine (loopback): Caddy or nginx running on the same host as Hearth.
//   addresses        comma-separated IPs or subnets of your proxy, e.g. 10.231.47.0/28 (docker-compose.yml
//                    sets this for its own Caddy). The words loopback, linklocal and uniquelocal work too.
//   1, 2, …          that many proxies in front, whatever their address. Only safe when nothing can reach
//                    Hearth's port except through them.
//   false (or 0)     never believe the header.
//   true             the same as 1 (trusting every hop would let any visitor choose their own address).
//
// The old default trusted every private address (10.x, 172.16-31.x, 192.168.x, fd00::/8). With Docker's port
// publishing or a LAN, ordinary visitors can arrive from such an address and could then pick any IP they liked.
const DEFAULT_TRUST_PROXY = 'loopback';

function trustProxySetting(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return DEFAULT_TRUST_PROXY;
  if (/^(false|no|off|none)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) return 1;
  // A plain number is a hop count. (Express would read the string '1' as the address 0.0.0.1, which never
  // matches, so every visitor behind the proxy shared one address and one set of rate limits.)
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v.split(',').map((x) => x.trim()).filter(Boolean).join(', ');
}

// The client address for connections that don't go through Express (Socket.IO): the same walk Express does
// for req.ip. Start at the connection's own address and step left through X-Forwarded-For only while the
// current hop is trusted; the first untrusted address is the client.
function clientIp(remote, forwardedFor, trust) {
  const hops = [String(remote || '')];
  const xff = String(forwardedFor || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = xff.length - 1; i >= 0; i--) hops.push(xff[i]);
  let i = 0;
  while (i < hops.length - 1 && trust(hops[i], i)) i++;
  return hops[i];
}

// ---------------------------------------------------------------- the one-time hint for an untrusted proxy
// When X-Forwarded-For keeps arriving from an address we don't trust, every visitor behind that proxy shares its
// address (one set of login and sign-up limits for everyone). The server says so once, with a setting that fixes
// it without trusting more than the proxy. In Docker, container addresses change when a container is recreated,
// and Docker's gateway is where everything through the published port comes from, so the advice differs there.
const v4 = (s) => {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(s || ''));
  if (!m || m.slice(1).some((x) => +x > 255)) return null;
  return ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
};
const v4str = (n) => [24, 16, 8, 0].map((b) => (n >>> b) & 255).join('.');
const maskBits = (m) => { let bits = 0; for (let n = m; n; n = (n << 1) >>> 0) bits++; return bits; };

// Where Hearth itself runs: in a container or not, its own IPv4 networks, which of them holds the default route
// (the only one Docker forwards published ports through), and HEARTH_BIND (docker-compose.yml passes .env in).
function netContext() {
  const fs = require('fs');
  const os = require('os');
  const nets = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) if ((n.family === 'IPv4' || n.family === 4) && !n.internal) nets.push({ iface, address: n.address, netmask: n.netmask });
  }
  let defaultIface = '';
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === '00000000' && f[7] === '00000000') { defaultIface = f[0]; break; }
    }
  } catch { /* not Linux: no default-route information */ }
  const inContainer = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  return { inContainer, nets, defaultIface, bind: process.env.HEARTH_BIND || '' };
}

function ignoredXffHint(remote, ctx) {
  const ip = String(remote || '').replace(/^::ffff:/i, '');
  const head = `X-Forwarded-For from ${ip} was ignored (TRUST_PROXY doesn't include it), so everyone coming through it shares that address.`;
  if (!ctx.inContainer) return `${head} If that's your reverse proxy, set TRUST_PROXY=${ip} in .env and restart Hearth.`;
  const restart = 'in .env (or under environment: in docker-compose.yml), then run docker compose up -d';
  const n = v4(ip);
  const net = n == null ? null : (ctx.nets || []).find((x) => {
    const m = v4(x.netmask);
    return m != null && v4(x.address) != null && ((v4(x.address) & m) >>> 0) === ((n & m) >>> 0);
  });
  const mask = net ? v4(net.netmask) : 0;
  // Docker's gateway (the network's first address): this machine, and anyone using the published port 3000.
  if (net ? ((n & ~mask) >>> 0) === 1 : /\.1$/.test(ip)) {
    const local = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(String(ctx.bind || '').trim());
    return `${head} ${ip} is Docker's gateway: requests from this machine, and from anyone using the published port 3000, come from it. ` +
      (local
        ? `If your reverse proxy runs on this machine outside Docker, set TRUST_PROXY=${ip} ${restart}.`
        : `If your reverse proxy runs on this machine outside Docker, set both HEARTH_BIND=127.0.0.1 (so only this machine can reach port 3000) and TRUST_PROXY=${ip} ${restart}. Never trust it without HEARTH_BIND: anyone could then choose their own address.`);
  }
  // A network Hearth shares with the proxy that isn't its way out (like the "proxy" network in docker-compose.yml):
  // nothing from outside arrives through it, so its whole subnet can be trusted and survives new container addresses.
  if (net && ctx.defaultIface && net.iface !== ctx.defaultIface) {
    return `${head} If that's your reverse proxy, set TRUST_PROXY=${v4str((n & mask) >>> 0)}/${maskBits(mask)} (the Docker network Hearth shares with it) ${restart}.`;
  }
  return `${head} If that's your reverse proxy, set TRUST_PROXY=${ip} ${restart}. A container gets a new address when it's recreated: ` +
    'give the proxy a fixed one, or put it on an internal network with Hearth (like the "proxy" network in docker-compose.yml) and trust that network\'s subnet.';
}

module.exports = { DEFAULT_TRUST_PROXY, trustProxySetting, clientIp, netContext, ignoredXffHint };
