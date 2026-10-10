#!/usr/bin/env node
// A tiny Hearth bot, as a starting point for your own (see docs/BOTS.md).
//
// It's a plain Node HTTP(S) server with no dependencies. It:
//  - checks the signature on every webhook Hearth sends, and refuses old or replayed ones;
//  - registers one slash command, /roll [sides], and answers it with a message;
//  - says hello in the first channel it's allowed in when a server installs it.
//
// Hearth only sends webhooks to https addresses, so either give it a certificate (TLS_CERT, TLS_KEY) or put it
// behind something that does https for it (Caddy, nginx, a tunnel).
//
//   HEARTH_URL=https://chat.example.com BOT_TOKEN=hb_… WEBHOOK_SECRET=… PORT=8443 \
//   TLS_CERT=cert.pem TLS_KEY=key.pem node scripts/example-bot.js
//
// The token and the webhook secret are shown once, when you create the bot (Server settings → Bots). Keep them
// out of git and out of URLs.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const REPLAY_WINDOW_SEC = 300; // Hearth's timestamps more than 5 minutes off are refused

// Is this webhook really from Hearth? The signature is HMAC-SHA256 over "<timestamp>.<raw body>" with your
// webhook secret, sent as "X-Hearth-Signature: v1=<hex>". Check it against the raw bytes (before parsing the
// JSON), compare in constant time, and refuse timestamps outside the replay window.
function verify(secret, headers, rawBody, { now = Date.now(), windowSec = REPLAY_WINDOW_SEC } = {}) {
  const ts = String(headers['x-hearth-timestamp'] || '');
  const sig = String(headers['x-hearth-signature'] || '');
  if (!/^\d{1,12}$/.test(ts) || !sig.startsWith('v1=')) return false;
  if (Math.abs(now / 1000 - Number(ts)) > windowSec) return false;
  const want = crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest();
  const got = Buffer.from(sig.slice(3), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const roll = (sides) => 1 + crypto.randomInt(sides);

// The bot itself: returns a request handler for the webhook, and start() to register its commands.
function createBot({ hearthUrl, token, secret, log = () => {} }) {
  const base = String(hearthUrl).replace(/\/+$/, '') + '/api/bot/v1';
  // Every call sends the token in the Authorization header (Hearth refuses it anywhere else).
  async function hearth(method, path, body) {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json.code || ''} ${json.error || ''}`.trim());
    return json;
  }
  const seen = new Set(); // delivery ids already handled (retries reuse the id)

  async function handle(evt) {
    if (evt.type === 'bot.installed') {
      const channelId = (evt.data.channelIds || [])[0];
      if (channelId) await hearth('POST', `/channels/${channelId}/messages`, { content: 'Hi! I roll dice. Try /roll or /roll 20.' }).catch((e) => log(e.message));
    } else if (evt.type === 'command.invoked' && evt.data.command === 'roll') {
      const sides = evt.data.args.sides === undefined ? 6 : Math.floor(evt.data.args.sides);
      const reply = sides >= 2 && sides <= 1000
        ? { content: `🎲 rolled **${roll(sides)}** (1–${sides})` }
        : { content: 'Pick between 2 and 1000 sides.', ephemeral: true }; // only the person who asked sees this
      await hearth('POST', `/interactions/${evt.data.interactionId}/callback`, reply).catch((e) => log(e.message));
    }
  }

  function onRequest(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!verify(secret, req.headers, raw)) { res.writeHead(401).end(); return; }
      let evt;
      try { evt = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400).end(); return; }
      // Answer straight away (Hearth waits 5 seconds at most), then do the work.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      if (evt.v !== 1 || seen.has(evt.id)) return;
      seen.add(evt.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      handle(evt).catch((e) => log(e.message));
    });
  }

  async function start() {
    await hearth('PUT', '/commands', { commands: [
      { name: 'roll', description: 'Roll a die', options: [{ name: 'sides', type: 'number', required: false, description: 'How many sides (default 6)' }] },
    ] });
    const me = await hearth('GET', '/me');
    log(`Signed in as ${me.name} (@${me.username}).`);
  }
  return { onRequest, start, hearth };
}

if (require.main === module) {
  const env = process.env;
  for (const k of ['HEARTH_URL', 'BOT_TOKEN', 'WEBHOOK_SECRET']) if (!env[k]) { console.error(`Set ${k}.`); process.exit(1); }
  const bot = createBot({ hearthUrl: env.HEARTH_URL, token: env.BOT_TOKEN, secret: env.WEBHOOK_SECRET, log: (m) => console.log(m) });
  const tls = env.TLS_CERT && env.TLS_KEY ? { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) } : null;
  const server = tls ? https.createServer(tls, bot.onRequest) : http.createServer(bot.onRequest);
  server.listen(Number(env.PORT) || 8443, env.HOST || '127.0.0.1', async () => {
    console.log(`Example bot listening on ${tls ? 'https' : 'http'}://${env.HOST || '127.0.0.1'}:${server.address().port}`);
    try { await bot.start(); console.log('Ready.'); } catch (e) { console.error(e.message); process.exit(1); }
  });
}

module.exports = { verify, createBot, roll, REPLAY_WINDOW_SEC };
