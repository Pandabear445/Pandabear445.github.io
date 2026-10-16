// Invite links that unfurl (v19): what https://this-server/invite/<code> shows before anyone signs in, to the person
// who got the link and to the preview bots of the apps it's pasted into (Discord's, Reddit's, X's, a phone's
// messages app). Every invite link someone shares then says what it is, instead of a bare "Hearth".
//   - By default nothing about the server: "You're invited to a server on <instance>". The card is byte for byte
//     the same for every code, working or not (unknown, expired, used up and revoked ones too), so the page can't be
//     used to check codes.
//   - A server can opt in (servers.invite_preview: Server settings -> Overview -> Privacy, Manage Server, in its
//     audit log). Then a link that still works shows "Join <server> on <instance>" and the member count. Never the
//     icon, the description, channels, members' names or anything anyone wrote.
//   - The sign-in screen asks the same question for its banner: GET /api/invites/:code/preview, no sign-in needed,
//     -> { instance, server: { name, memberCount } | null }, null unless the server opted in and the link works.
//   - Both share one allowance per network (60 a minute). The page never refuses (someone following a link still
//     gets the app): past the allowance it shows the generic card without looking the code up. The JSON answers 429.
//   - The card's picture is the instance's own app icon, at the configured public address (Admin -> Email's public
//     address, PUBLIC_URL, or the first PUBLIC_HOSTS name when Hearth serves https itself), never the request's Host
//     header, so a forged Host can't put another site into a card that a cache or a bot keeps. Without one: no picture.
//   - Every value is HTML-escaped (quotes too) and cut to length; invite pages say noindex (meta tag and
//     X-Robots-Tag) and are never cached.
// The app's own page (/, /index.html and every other app address) gets the instance's name and tagline the same way,
// so the bare address unfurls too.
//
// Routes
//   GET /invite/:code                  the app's page with the card's tags
//   GET /api/invites/:code/preview     { instance, server }
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PEEK_MAX = 60; // look-ups a minute per network, page and JSON together
const PEEK_WINDOW = 60 * 1000;
const CODE = /^[A-Za-z0-9]{1,32}$/;
const PITCH = 'Hearth is free, private chat. Messages are end-to-end encrypted.';
const BASE_PITCH = 'Free, private chat with servers, voice and end-to-end encrypted messages.';

// Text for an attribute or a <title>: half characters (a name cut mid-emoji), control and direction-changing characters
// out, whitespace collapsed, cut to `max` characters (whole ones, never half an emoji), then escaped.
function esc(v, max = 300) {
  let s = String(v == null ? '' : v).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length > max) s = chars.slice(0, max - 1).join('').trimEnd() + '\u2026';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// "https://chat.example.com/anything" -> "https://chat.example.com"; anything that isn't an http(s) address -> null.
function originOf(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim());
    return /^https?:$/.test(u.protocol) && u.hostname && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The tags that go where the page's <title> was: the title, a description, Open Graph and Twitter cards.
function headTags({ title, description, siteName, origin, invite }) {
  const t = esc(title, 120);
  const d = esc(description, 300);
  const image = origin ? esc(`${origin}/icons/icon-512.png`, 400) : null;
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    invite ? '<meta name="robots" content="noindex">' : null,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${esc(siteName, 60)}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    image ? `<meta property="og:image" content="${image}">` : null,
    image ? '<meta property="og:image:width" content="512">' : null,
    image ? '<meta property="og:image:height" content="512">' : null,
    image ? `<meta property="og:image:alt" content="${esc(`${siteName} app icon`, 80)}">` : null,
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
  ].filter(Boolean).join('\n  ');
}

// The page with the tags in place of its <title>. A function replacement: "$&" or "$1" in a server's name is text.
function inject(template, tags) {
  const TITLE = /<title>[^<]*<\/title>/;
  return TITLE.test(template) ? template.replace(TITLE, () => tags) : template.replace(/<head>/i, (m) => `${m}\n  ${tags}`);
}

module.exports = function setupInvitePreview({ app, api, db, now, brand, publicOrigin, countHit, limitNet, netOf, PUBLIC_DIR }) {
  const TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); // read once: updates restart Hearth
  const peekKey = (req) => `invitepeek:net:${netOf(req.ip)}`;

  // The server's name and member count, only when it opted in and the link still works (as joining checks it).
  function peek(code) {
    code = String(code || '');
    if (!CODE.test(code)) return null;
    const inv = db.prepare('SELECT server_id, max_uses, uses, expires_at FROM invites WHERE code = ?').get(code);
    if (!inv || (inv.expires_at && inv.expires_at < now()) || (inv.max_uses && inv.uses >= inv.max_uses)) return null;
    const s = db.prepare('SELECT id, name, kind, invite_preview FROM servers WHERE id = ?').get(inv.server_id);
    if (!s || s.kind === 'group' || !s.invite_preview) return null;
    return { name: s.name, memberCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n };
  }

  const baseHtml = () => {
    const b = brand();
    return inject(TEMPLATE, headTags({ title: b.name, description: b.tagline || BASE_PITCH, siteName: b.name, origin: originOf(publicOrigin()) }));
  };
  const inviteHtml = (server) => {
    const b = brand();
    return inject(TEMPLATE, headTags(server
      ? { title: `Join ${server.name} on ${b.name}`, description: `${plural(server.memberCount, 'member', 'members')} \u00b7 ${PITCH}`, siteName: b.name, origin: originOf(publicOrigin()), invite: true }
      : { title: `You\u2019re invited to a server on ${b.name}`, description: PITCH, siteName: b.name, origin: originOf(publicOrigin()), invite: true }));
  };

  // Compressed like the app's other files. The pages that are the same for everyone (the app's page, the generic
  // invite card) keep their compressed copies until the instance's name or address changes.
  const kept = { base: { html: null }, generic: { html: null } };
  function send(req, res, html, memo) {
    res.type('html');
    res.setHeader('Vary', 'Accept-Encoding');
    const ae = String(req.headers['accept-encoding'] || '');
    const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
    if (!enc) return res.send(html);
    if (memo && memo.html !== html) { memo.html = html; memo.br = null; memo.gzip = null; }
    let body = memo && memo[enc];
    if (!body) {
      body = enc === 'br' ? zlib.brotliCompressSync(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(html, { level: 9 });
      if (memo) memo[enc] = body;
    }
    res.setHeader('Content-Encoding', enc);
    res.setHeader('Content-Length', body.length);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  function appPage(req, res) {
    res.setHeader('Cache-Control', 'no-cache');
    send(req, res, baseHtml(), kept.base);
  }

  app.get('/invite/:code', (req, res) => {
    // Never refused: past the allowance, the generic card without looking anything up.
    const server = countHit(peekKey(req), PEEK_WINDOW) <= PEEK_MAX ? peek(req.params.code) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    send(req, res, inviteHtml(server), server ? null : kept.generic);
  });

  api.get('/invites/:code/preview', (req, res) => {
    limitNet(req, 'invitepeek', PEEK_MAX, PEEK_WINDOW);
    res.json({ instance: brand().name, server: peek(req.params.code) });
  });

  return { appPage, peek };
};
module.exports.esc = esc;
module.exports.originOf = originOf;
module.exports.headTags = headTags;
module.exports.inject = inject;
module.exports.PEEK_MAX = PEEK_MAX;
