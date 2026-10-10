// Outbound requests to addresses that people pick: news feeds and personal trackers, pictures in news posts,
// music and game pictures, and web push endpoints.
//
// These requests leave from the server, from inside its network, so they may only go to the public internet:
//  - the host name is looked up once and every address it gives is checked. Private, loopback, link-local
//    (cloud metadata), carrier-grade NAT, multicast and reserved ranges are refused however they're written:
//    IPv4-mapped IPv6 (::ffff:7f00:1), NAT64 and 6to4 carry an IPv4 address inside and are judged by it, and
//    decimal/octal/hex IPv4 (http://2130706433/) is normalized by the URL parser before the check;
//  - the connection goes to exactly the addresses that were checked (the lookup is pinned), so a DNS server
//    that answers "public" for the check and "private" a moment later (DNS rebinding) gets nowhere;
//  - redirects are followed by hand, a few at most, and every hop is checked the same way;
//  - one deadline covers everything (lookup, connect, redirects, the whole answer), and the answer is read as
//    a stream with a size cap, so a hostile site can't hold a connection open or fill the memory;
//  - this server's own addresses count as inside, even public ones (see ownAddress below).
const dns = require('dns');
const net = require('net');
const os = require('os');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { Transform } = require('stream');

const MB = 1024 * 1024;

class GuardError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'GuardError'; this.code = code; if (cause) this.cause = cause; }
}

// ------------------------------------------------------------------ which addresses count as public
const V4 = new net.BlockList();
[
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], // private networks
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], // special use, benchmarking, documentation
  ['224.0.0.0', 3], // multicast, reserved, broadcast
].forEach(([a, bits]) => V4.addSubnet(a, bits, 'ipv4'));
// Special-purpose blocks inside IPv6 global unicast (2000::/3): protocol assignments (Teredo, benchmarking…)
// and documentation.
const V6 = new net.BlockList();
[['2001::', 23], ['2001:db8::', 32], ['3fff::', 20]].forEach(([a, bits]) => V6.addSubnet(a, bits, 'ipv6'));

// 16 bytes of a valid IPv6 address (call only after net.isIPv6).
function v6Bytes(ip) {
  let s = ip.toLowerCase();
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) { const o = dotted.slice(2).map(Number); s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`; }
  const [head, tail] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

// True for anything that isn't a public internet address (including things that aren't addresses at all).
function blockedIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const kind = net.isIP(s);
  if (kind === 4) return V4.check(s, 'ipv4');
  if (kind !== 6 || s.includes('%')) return true; // a zone id (fe80::1%eth0) only makes sense on a local link
  const b = v6Bytes(s);
  const v4At = (i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  // NAT64 (64:ff9b::/96) is how IPv6-only servers reach IPv4 sites, so judge the IPv4 address inside it.
  if (b.readUInt32BE(0) === 0x0064ff9b && b.readUInt32BE(4) === 0 && b.readUInt32BE(8) === 0) return V4.check(v4At(12), 'ipv4');
  // 6to4 (2002::/16) carries an IPv4 address too.
  if (b.readUInt16BE(0) === 0x2002) return V4.check(v4At(2), 'ipv4');
  // Everything else must be global unicast (2000::/3). That rules out ::1, ::, IPv4-mapped and -compatible
  // forms (::ffff:a.b.c.d), unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8 and so on.
  if ((b[0] & 0xe0) !== 0x20) return true;
  return V6.check(s, 'ipv6');
}

// This server's own addresses. A public one is still this machine: a request to it comes back in through the
// loopback interface, which firewalls (ufw, iptables) usually let through untouched, so it could reach
// services that are firewalled off from the internet. So they're refused too, except on the ordinary web
// ports (80, 443): those serve the public anyway, and a blog with a feed may well run next to Hearth.
// OUTBOUND_BLOCK adds addresses or ranges that are refused on every port, such as this server's public
// address when it sits behind NAT, or a router's.
const WEB_PORTS = new Set([80, 443]);
const own = { list: null, extra: null, at: 0 };
function toBlockList(entries) {
  const list = new net.BlockList();
  for (const raw of entries) {
    const [ip, bits] = String(raw).trim().replace(/%.*$/, '').split('/');
    const kind = net.isIP(ip);
    if (!kind) continue;
    try {
      if (bits === undefined) list.addAddress(ip, kind === 6 ? 'ipv6' : 'ipv4');
      else list.addSubnet(ip, Number(bits), kind === 6 ? 'ipv6' : 'ipv4');
    } catch { /* a bad prefix length: skip it */ }
  }
  return list;
}
// Looked at again every few minutes (addresses can change while the server runs).
function refreshOwnAddresses() {
  let found = [];
  try { found = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address); } catch { /* none to add */ }
  own.list = toBlockList(found);
  own.extra = toBlockList(String(process.env.OUTBOUND_BLOCK || '').split(','));
  own.at = Date.now();
}
// Why `ip` may not be reached on `port` because it's this server, or listed in OUTBOUND_BLOCK ('' if it may).
function ownAddress(ip, port) {
  if (!own.list || Date.now() - own.at > 5 * 60000) refreshOwnAddresses();
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const kind = net.isIP(s);
  if (!kind) return '';
  const type = kind === 6 ? 'ipv6' : 'ipv4';
  if (own.extra.check(s, type)) return 'That address is blocked on this server.';
  return own.list.check(s, type) && !WEB_PORTS.has(Number(port)) ? 'That address is this server itself.' : '';
}

// ------------------------------------------------------------------ looking addresses up
const TIMEOUT_MSG = 'The site took too long to answer.';

// Waits for `promise`, but no later than the deadline (DNS lookups can't be cancelled, only stopped waiting for).
function beforeDeadline(promise, deadline, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new GuardError('TIMEOUT', TIMEOUT_MSG)), Math.max(1, deadline - Date.now()));
    const onAbort = () => done(new GuardError('ABORTED', 'Stopped.'));
    let over = false;
    function done(err, value) {
      if (over) return;
      over = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    }
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    promise.then((v) => done(null, v), (e) => done(e));
  });
}

// How host names are looked up. Names go to Node's own DNS client (c-ares): it runs on the event loop, not on
// the small thread pool that file access shares, and nothing caps how many lookups it runs at once. So a slow
// DNS server that someone controls only slows down the lookups of its own names.
// The system's lookup (getaddrinfo: /etc/hosts, mDNS, search domains) runs on that thread pool, so it's only
// used for names public DNS can't answer: `localhost`, a bare `nas`, `jellyfin.lan`, or a name DNS says
// doesn't exist (it may be in /etc/hosts). At most two of those run at once.
const dnsClient = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
const LOCAL_NAME = /^[^.]+\.?$|\.(localhost|local|lan|internal|home\.arpa)\.?$/i;
// "There's no such name in DNS" (or no DNS server at all), as opposed to a DNS server that's slow or broken.
const NOT_IN_DNS = new Set(['ENOTFOUND', 'ENODATA', 'ECONNREFUSED']);
const lanes = {
  dns: async (host) => {
    const got = await Promise.allSettled([dnsClient.resolve4(host), dnsClient.resolve6(host)]);
    const found = got.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
    if (found.length) return found.map((address) => ({ address, family: net.isIP(address) }));
    const codes = got.map((x) => x.reason && x.reason.code);
    throw Object.assign(new Error(`No address for ${host}`), { code: codes.find((c) => !NOT_IN_DNS.has(c)) || 'ENOTFOUND' });
  },
  system: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
};
// Tests swap in a fake so they never touch real DNS: a function answers every lookup itself; { dns, system }
// replaces the two kinds of lookup underneath (each is optional).
let resolver = null;
const setResolver = (fn) => {
  resolver = typeof fn === 'function' ? fn : null;
  lanes.dns = (fn && fn.dns) || defaultLanes.dns;
  lanes.system = (fn && fn.system) || defaultLanes.system;
};
const defaultLanes = { ...lanes };

const MAX_SYSTEM_LOOKUPS = 2;
let systemBusy = 0;
const systemQueue = [];
async function systemLookup(host, deadline) {
  await new Promise((resolve, reject) => {
    if (systemBusy < MAX_SYSTEM_LOOKUPS) { systemBusy++; return resolve(); }
    const timer = setTimeout(() => { systemQueue.splice(systemQueue.indexOf(turn), 1); reject(new GuardError('TIMEOUT', TIMEOUT_MSG)); }, Math.max(1, deadline - Date.now()));
    function turn() { clearTimeout(timer); resolve(); } // handed a slot by a lookup that finished
    systemQueue.push(turn);
  });
  try { return await lanes.system(host); } finally { const next = systemQueue.shift(); if (next) next(); else systemBusy--; }
}
async function lookupHost(host, deadline) {
  if (resolver) return resolver(host);
  if (!LOCAL_NAME.test(host)) {
    try { return await lanes.dns(host); } catch (e) { if (!NOT_IN_DNS.has(e && e.code)) throw e; }
  }
  return systemLookup(host, deadline);
}

const allowedPrivate = (allowPrivate, u) => (typeof allowPrivate === 'function' ? !!allowPrivate(u) : !!allowPrivate);
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '');

function parseUrl(input, { protocols = ['http:', 'https:'] } = {}) {
  let u;
  try { u = new URL(input instanceof URL ? input.href : String(input)); } catch { throw new GuardError('BAD_URL', 'That isn’t a web address.'); }
  if (!protocols.includes(u.protocol)) throw new GuardError('BAD_PROTOCOL', protocols.includes('http:') ? 'Only http(s) addresses.' : 'Only https addresses.');
  if (u.username || u.password) throw new GuardError('BAD_URL', 'Addresses with a user name or password in them aren’t supported.');
  return u;
}

const portOf = (u) => Number(u.port) || (u.protocol === 'https:' ? 443 : 80);

// Every address the host has, all checked. Refuses the whole host if any one of them is private: there's no
// telling which one a connection would get. `port` is where the connection will go (this server's own
// addresses are allowed on the web ports only).
async function resolvePublic(hostname, { allowPrivate = false, deadline = Date.now() + 8000, signal = null, port = 0 } = {}) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  const kind = net.isIP(host);
  let list = [];
  if (kind) list = [{ address: host, family: kind }];
  else {
    let found = [];
    try { found = await beforeDeadline(lookupHost(host, deadline), deadline, signal); } catch (e) { if (e instanceof GuardError) throw e; /* else: not found */ }
    list = (Array.isArray(found) ? found : []).map((x) => String((x && x.address) || '')).filter((a) => net.isIP(a)).map((a) => ({ address: a, family: net.isIP(a) }));
  }
  if (!list.length) throw new GuardError('NOT_FOUND', `Couldn’t find ${host}.`);
  if (allowPrivate) return list;
  if (list.some((x) => blockedIp(x.address))) throw new GuardError('PRIVATE', 'That address is inside a private network.');
  const self = list.map((x) => ownAddress(x.address, port)).find(Boolean);
  if (self) throw new GuardError('PRIVATE', self);
  return list;
}

// A URL checked up front (protocol, and every address of its host is public), for a clear "no" when someone
// saves it. Requests check again when they're made, since DNS answers can change in between.
async function checkPublicUrl(input, { protocols, allowPrivate = false, timeout = 8000 } = {}) {
  const u = parseUrl(input, { protocols });
  await resolvePublic(u.hostname, { allowPrivate: allowedPrivate(allowPrivate, u), deadline: Date.now() + timeout, port: portOf(u) });
  return u;
}

// ------------------------------------------------------------------ making the request
const REDIRECT = new Set([301, 302, 303, 307, 308]);

// Unpacking a compressed answer. Lenient like browsers and fetch(): an answer cut short still gives what
// arrived, and "deflate" may be zlib-wrapped (as the standard says) or raw (as some servers send it).
const ZLIB_LENIENT = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
function inflateEither() {
  let inner = null;
  return new Transform({
    transform(chunk, enc, cb) {
      if (!inner) {
        if (!chunk.length) return cb();
        // A zlib header's low four bits say "deflate" (8); raw deflate data has no header.
        inner = (chunk[0] & 0x0f) === 0x08 ? zlib.createInflate(ZLIB_LENIENT) : zlib.createInflateRaw(ZLIB_LENIENT);
        inner.on('data', (d) => this.push(d));
        inner.on('error', (e) => this.destroy(e));
      }
      inner.write(chunk, () => cb());
    },
    flush(cb) { if (!inner) return cb(); inner.once('end', () => cb()); inner.end(); },
    destroy(err, cb) { if (inner) inner.destroy(); cb(err); },
  });
}
// The unpackers for a Content-Encoding header, outermost first ([] if there's nothing to unpack). Like fetch(),
// a label it doesn't know means the answer is used as it is.
function decodersFor(header) {
  const codings = String(header || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => x && x !== 'identity');
  const out = [];
  for (const c of codings.reverse()) {
    if (c === 'gzip' || c === 'x-gzip') out.push(() => zlib.createGunzip(ZLIB_LENIENT));
    else if (c === 'deflate') out.push(inflateEither);
    else if (c === 'br') out.push(() => zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }));
    else return [];
  }
  return out;
}

// One request to one checked set of addresses.
function once(u, addrs, { method, headers, body, deadline, maxBytes, truncate, decompress, signal, follow }) {
  return new Promise((resolve, reject) => {
    const host = hostOf(u);
    // The pinned lookup: whatever the connection asks for, the answer is the addresses that were just checked.
    const lookup = (name, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      const fam = options && (options.family === 4 || options.family === 6) ? options.family : 0;
      const list = fam ? addrs.filter((a) => a.family === fam) : addrs;
      if (!list.length) return cb(Object.assign(new Error(`No IPv${fam} address for ${name}`), { code: 'ENOTFOUND' }));
      if (options && options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    };
    const h = { ...headers };
    if (decompress && !Object.keys(h).some((k) => k.toLowerCase() === 'accept-encoding')) h['Accept-Encoding'] = 'gzip, deflate, br';
    let over = false;
    let req = null; let res = null; let unpackers = [];
    const timer = setTimeout(() => finish(new GuardError('TIMEOUT', TIMEOUT_MSG)), Math.max(1, deadline - Date.now()));
    const onAbort = () => finish(new GuardError('ABORTED', 'Stopped.'));
    function finish(err, value) {
      if (over) return;
      over = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Everything stops here. An unpacker still holding compressed bytes would otherwise go on unpacking
      // them after the answer was refused: a few KB of brotli can be gigabytes of work.
      if (res && unpackers.length) res.unpipe(unpackers[0]);
      unpackers.forEach((z) => z.destroy());
      if (res) res.destroy();
      if (req) req.destroy(); // no keep-alive: every request gets its own pinned connection
      if (err) reject(err); else resolve(value);
    }
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    const lib = u.protocol === 'https:' ? https : http;
    try {
      req = lib.request({ host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method, headers: h, agent: false, lookup });
    } catch (e) { return finish(new GuardError('BAD_URL', 'That isn’t a web address.', e)); }
    req.on('error', (e) => finish(e instanceof GuardError ? e : new GuardError('NETWORK', `Couldn’t connect to ${host}.`, e)));
    req.on('response', (answer) => {
      res = answer;
      const status = res.statusCode;
      res.on('error', (e) => finish(new GuardError('NETWORK', 'The connection was cut off.', e)));
      if (follow && REDIRECT.has(status) && res.headers.location) return finish(null, { status, headers: res.headers, location: String(res.headers.location) });
      if (!truncate && +res.headers['content-length'] > maxBytes) return finish(new GuardError('TOO_BIG', 'That’s too big.'));
      let stream = res;
      if (decompress) {
        // The cap is on what comes out, so a small compressed answer can't unpack into gigabytes.
        unpackers = decodersFor(res.headers['content-encoding']).map((make) => make());
        for (const z of unpackers) {
          z.on('error', (e) => finish(new GuardError('BAD_ENCODING', 'The site answered in a format this server can’t read.', e)));
          stream = stream.pipe(z);
        }
      }
      const chunks = []; let size = 0;
      const result = (truncated) => ({ status, ok: status >= 200 && status < 300, headers: res.headers, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks, size), url: u.href, truncated });
      stream.on('data', (c) => {
        if (over) return;
        if (size + c.length > maxBytes) {
          if (!truncate) return finish(new GuardError('TOO_BIG', 'That’s too big.'));
          chunks.push(c.subarray(0, maxBytes - size)); size = maxBytes;
          return finish(null, result(true));
        }
        chunks.push(c); size += c.length;
      });
      stream.on('end', () => finish(null, result(false)));
      res.on('close', () => { if (!res.complete) finish(new GuardError('NETWORK', 'The connection was cut off.')); });
    });
    if (body) req.end(body); else req.end();
  });
}

// GET (or POST…) a URL that someone picked. Returns { status, ok, headers, type, body (Buffer), url, truncated }.
// Throws a GuardError (with a `code` and a message fit to show people) when it can't or mustn't.
//   protocols     allowed URL schemes
//   allowUrl(u)   an extra check on every hop (like a list of allowed hosts)
//   allowPrivate  true (or a function of the URL) to skip the public-address check; the lookup is still pinned
//   maxRedirects  0 returns redirects as they are; more follows them (re-checking each hop)
//   timeout       ms for the whole thing, every hop included
//   maxBytes      the most of the answer to read; past that it throws TOO_BIG, or with truncate stops quietly
async function request(input, opts = {}) {
  const { method = 'GET', headers = {}, body = null, protocols = ['http:', 'https:'], allowUrl = null, allowPrivate = false,
    maxRedirects = 5, timeout = 12000, maxBytes = 3 * MB, truncate = false, decompress = true, signal = null } = opts;
  const deadline = Date.now() + timeout;
  let url = input; let m = method; let payload = body; let h = headers;
  for (let hop = 0; ; hop++) {
    const u = parseUrl(url, { protocols });
    if (allowUrl && !allowUrl(u)) throw new GuardError('NOT_ALLOWED', 'That address isn’t allowed.');
    const addrs = await resolvePublic(u.hostname, { allowPrivate: allowedPrivate(allowPrivate, u), deadline, signal, port: portOf(u) });
    const r = await once(u, addrs, { method: m, headers: h, body: payload, deadline, maxBytes, truncate, decompress, signal, follow: maxRedirects > 0 });
    if (r.location === undefined) return r;
    if (hop >= maxRedirects) throw new GuardError('REDIRECTS', 'Too many redirects.');
    let next;
    try { next = new URL(r.location, u); } catch { throw new GuardError('BAD_URL', 'The site redirected to something that isn’t a web address.'); }
    if (r.status === 303 || ((r.status === 301 || r.status === 302) && m === 'POST')) {
      m = 'GET'; payload = null;
      h = Object.fromEntries(Object.entries(h).filter(([k]) => !/^content-/i.test(k))); // no body any more
    }
    // Credentials never follow a redirect to another site.
    if (next.origin !== u.origin) h = Object.fromEntries(Object.entries(h).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
    url = next;
  }
}

module.exports = { GuardError, blockedIp, parseUrl, resolvePublic, checkPublicUrl, request, setResolver, refreshOwnAddresses };
