// A mail server for the tests: Hearth sends its emails here over plain SMTP with nodemailer, exactly as it does to
// a real mail server, and each one is kept in memory as { to, subject, text }. Nothing is relayed or written to disk.
//
// It speaks just enough of RFC 5321 for an SMTP client: EHLO/HELO, MAIL FROM, RCPT TO (one or more), DATA, RSET,
// NOOP and QUIT. It offers no STARTTLS and no AUTH, so the client sends in the clear without logging in (it only
// listens on 127.0.0.1). Messages are decoded the way a mail app would: folded headers, encoded-word subjects
// (RFC 2047), quoted-printable or base64 bodies, the text/plain part of a multipart message. Line breaks come
// back as \n. A text's own final line break can't be told apart from the one SMTP ends every message with, so
// none is kept.
//
//   const sink = await startSmtpSink();   // sink.port; SMTP_HOST=127.0.0.1 SMTP_PORT=sink.port for the server
//   await sink.idle();                    // every mail sent so far has arrived
//   sink.messages                         // [{ to, subject, text }], oldest first
//   await sink.close();
const net = require('node:net');

const HOST = '127.0.0.1';

// Bytes in a JS string, one char per byte (how the socket is read), for decoding in the message's own charset.
const bytes = (s) => Buffer.from(s, 'latin1');
function decodeCharset(buf, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
const param = (value, name) => {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value || '');
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
};

// =XX escapes to bytes; everything else is taken as is.
function unescapeHex(t) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else out.push(t.charCodeAt(i) & 255);
  }
  return Buffer.from(out);
}
// Quoted-printable (RFC 2045 §6.7): spaces at a line end are padding, and '=' at a line end is a soft break.
const decodeQuotedPrintable = (s) => unescapeHex(s.replace(/[ \t]+$/gm, '').replace(/=\n/g, '').replace(/=$/, ''));

// Encoded words in a header (RFC 2047): =?charset?Q?…?= or =?charset?B?…?=. Whitespace between two of them is
// dropped, and the bytes of neighbours in the same charset are joined first, since a character may be split.
function decodeHeader(value) {
  const re = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g;
  const parts = [];
  let last = 0;
  for (let m; (m = re.exec(value));) {
    const between = value.slice(last, m.index);
    if (between && !(/^\s+$/.test(between) && parts.length && parts[parts.length - 1].word)) parts.push({ text: between });
    const charset = m[1].replace(/\*.*$/, '').toLowerCase();
    const buf = /[Bb]/.test(m[2]) ? Buffer.from(m[3], 'base64') : unescapeHex(m[3].replace(/_/g, ' '));
    const prev = parts[parts.length - 1];
    if (prev && prev.word && prev.charset === charset) prev.word = Buffer.concat([prev.word, buf]); else parts.push({ word: buf, charset });
    last = re.lastIndex;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts.map((p) => (p.word ? decodeCharset(p.word, p.charset) : decodeCharset(bytes(p.text), 'utf-8'))).join('');
}

// One MIME entity (lines already joined with \n): its headers (names lower-cased, folded lines joined) and body.
function splitEntity(raw) {
  // The headers end at the first empty line (a part with no headers starts with one).
  const bare = raw.startsWith('\n');
  const cut = bare ? 0 : raw.indexOf('\n\n');
  const head = bare ? '' : cut < 0 ? raw : raw.slice(0, cut);
  const body = bare ? raw.slice(1) : cut < 0 ? '' : raw.slice(cut + 2);
  const headers = {};
  for (const line of head.replace(/\n(?=[ \t])/g, '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(i + 1).trim(); }
  }
  return { headers, body };
}

// The plain text of an entity: decoded by its transfer encoding and charset; for multipart, its text/plain part.
function plainText({ headers, body }) {
  const type = (headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return null;
    const parts = []; let cur = null;
    for (const line of body.split('\n')) {
      const l = line.replace(/[ \t]+$/, '');
      if (l === `--${boundary}--`) break;
      if (l === `--${boundary}`) { if (cur) parts.push(cur.join('\n')); cur = []; } else if (cur) cur.push(line);
    }
    if (cur) parts.push(cur.join('\n'));
    for (const p of parts) { const t = plainText(splitEntity(p)); if (t !== null) return t; }
    return null;
  }
  if (type !== 'text/plain') return null;
  const cte = (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase();
  const buf = cte === 'quoted-printable' ? decodeQuotedPrintable(body) : cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : bytes(body);
  return decodeCharset(buf, param(headers['content-type'], 'charset') || 'utf-8').replace(/\r\n?/g, '\n');
}

function parseMessage(raw, recipients) {
  const entity = splitEntity(raw);
  const text = plainText(entity);
  return { to: recipients.join(', '), subject: decodeHeader(entity.headers.subject || ''), text: text === null ? '' : text };
}

function startSmtpSink() {
  const messages = [];
  const sessions = new Set();
  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };

  const server = net.createServer((socket) => {
    sessions.add(socket); touch();
    socket.setEncoding('latin1');
    let buffer = '';
    let greeted = false; let from = null; let rcpts = []; let data = null; // data: the lines of a message being received
    const reply = (line) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    const reset = () => { from = null; rcpts = []; data = null; };
    const command = (line) => {
      const verb = line.split(/\s/, 1)[0].toUpperCase();
      const arg = line.slice(verb.length).trim();
      let m;
      switch (verb) {
        case 'EHLO': case 'HELO': greeted = true; reset(); return reply(`250 ${HOST}`);
        case 'MAIL':
          if (!greeted) return reply('503 Send EHLO first');
          if (!(m = /^FROM:\s*<([^>]*)>/i.exec(arg))) return reply('501 Syntax: MAIL FROM:<address>');
          reset(); from = m[1]; return reply('250 OK');
        case 'RCPT':
          if (from === null) return reply('503 Send MAIL FROM first');
          if (!(m = /^TO:\s*<([^>]+)>/i.exec(arg))) return reply('501 Syntax: RCPT TO:<address>');
          rcpts.push(m[1]); return reply('250 OK');
        case 'DATA':
          if (!rcpts.length) return reply('503 Send RCPT TO first');
          data = []; return reply('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET': reset(); return reply('250 OK');
        case 'NOOP': return reply('250 OK');
        case 'QUIT': reply('221 Bye'); return socket.end();
        default: return reply('500 Command not recognized');
      }
    };
    socket.on('data', (chunk) => {
      touch();
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data === null) { command(line); continue; }
        if (line !== '.') { data.push(line.startsWith('.') ? line.slice(1) : line); continue; }
        // The message is kept before it's acknowledged, so it's there by the time the sender hears "250".
        messages.push(parseMessage(data.join('\n'), rcpts));
        reset();
        reply('250 OK: message accepted');
      }
    });
    socket.on('error', () => { /* the sender went away */ });
    socket.on('close', () => { sessions.delete(socket); touch(); });
    reply(`220 ${HOST} ESMTP test mail sink`);
  });
  server.unref(); // never what keeps a test process running

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      resolve({
        port: server.address().port,
        messages,
        // Resolves once no SMTP session is open and nothing has happened for `quiet` ms, counted from this call at
        // the earliest. Hearth sends some emails after its HTTP answer (security notices, reset links), so a test
        // waits here before reading messages instead of racing the sender.
        idle(quiet = 150, timeout = 15000) {
          const since = Date.now();
          return new Promise((done, fail) => {
            const check = () => {
              const calm = Date.now() - Math.max(since, lastActivity);
              if (!sessions.size && calm >= quiet) return done();
              if (Date.now() - since > timeout) return fail(new Error(`SMTP sink: still busy after ${timeout} ms (${sessions.size} session(s) open)`));
              setTimeout(check, sessions.size ? 20 : Math.max(10, quiet - calm));
            };
            check();
          });
        },
        close() {
          for (const s of sessions) s.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startSmtpSink };
