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

module.exports = { DEFAULT_TRUST_PROXY, trustProxySetting, clientIp };
