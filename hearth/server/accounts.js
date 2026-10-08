// Account safety: a verified email for password resets, a recovery key that keeps your encrypted messages
// through a reset, and two-factor sign-in (authenticator app + backup codes).
//
// How a reset works with end-to-end encryption: your password unlocks your private key, and the server never
// has either. So an emailed reset link gets you back into the account, but your old key can only come back
// if you also have your recovery key (which unlocks a second, separately encrypted copy of it). Without it,
// the reset makes you new keys: friends' apps automatically re-share every server's key with you, but old
// direct messages can't be read any more. The app explains this before anyone confirms.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
// RFC 6238 time-based codes (what Google Authenticator, Authy, 1Password, Bitwarden… show): HMAC-SHA1,
// 30-second steps, 6 digits.
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

module.exports = function setupAccounts(ctx) {
  const { api, auth, db, fail, wrap, rateLimit, getSetting, setSetting, getUserRow, selfUser, broadcastUser, bcrypt, newId, seal, unseal,
    tokenId, requireInstanceAdmin, adminLog, secEvent, cleanIp, recordIp, emitKeyState, brandName, isB64ish, isSalt, DATA_DIR } = ctx;
  const now = () => Date.now();

  // ------------------------------------------------------------------ sending email
  // SMTP, set in Admin → Owner → Email (or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM/PUBLIC_URL in .env).
  function mailCfg() {
    let v = {};
    try { v = JSON.parse(getSetting('mail') || '{}') || {}; } catch { /* none */ }
    const pass = v.pass ? (unseal(v.pass) || {}).p || '' : process.env.SMTP_PASS || '';
    return {
      host: v.host || process.env.SMTP_HOST || '', port: +(v.port || process.env.SMTP_PORT || 587), user: v.user || process.env.SMTP_USER || '', pass,
      from: v.from || process.env.MAIL_FROM || '', publicUrl: (v.publicUrl || process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    };
  }
  const mailReady = () => { const c = mailCfg(); return !!((c.host && c.from) || process.env.MAIL_OUTBOX_DIR) && !!c.publicUrl; };
  let transport = null; let transportKey = '';
  async function sendMail({ to, subject, text }) {
    const c = mailCfg();
    // For testing: write emails to a folder instead of sending them.
    if (process.env.MAIL_OUTBOX_DIR) {
      fs.mkdirSync(process.env.MAIL_OUTBOX_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MAIL_OUTBOX_DIR, `${now()}-${crypto.randomBytes(3).toString('hex')}.json`), JSON.stringify({ to, subject, text }, null, 2));
      return;
    }
    if (!c.host || !c.from) fail(503, 'Email isn’t set up on this server yet.');
    const key = JSON.stringify([c.host, c.port, c.user, c.pass]);
    if (!transport || key !== transportKey) {
      const nodemailer = require('nodemailer');
      transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000 });
      transportKey = key;
    }
    await transport.sendMail({ from: c.from, to, subject, text });
  }
  const mask = (email) => { if (!email) return ''; const [u, d] = email.split('@'); return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, u.length - 1)))}@${d}`; };

  api.get('/admin/mail', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const c = mailCfg();
    res.json({ host: c.host, port: c.port, user: c.user, passSet: !!c.pass, from: c.from, publicUrl: c.publicUrl, ready: mailReady() });
  });
  api.put('/admin/mail', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const b = req.body || {};
    let v = {};
    try { v = JSON.parse(getSetting('mail') || '{}') || {}; } catch { /* none */ }
    if (b.host !== undefined) v.host = String(b.host || '').trim().slice(0, 200);
    if (b.port !== undefined) v.port = Math.max(1, Math.min(65535, Math.round(+b.port) || 587));
    if (b.user !== undefined) v.user = String(b.user || '').trim().slice(0, 200);
    if (b.pass !== undefined) v.pass = b.pass ? seal({ p: String(b.pass).slice(0, 300) }) : '';
    if (b.from !== undefined) v.from = String(b.from || '').trim().slice(0, 200);
    if (b.publicUrl !== undefined) {
      const u = String(b.publicUrl || '').trim().replace(/\/+$/, '');
      if (u && !/^https:\/\/[^\s/]+$/.test(u)) fail(400, 'Your server’s address must look like https://chat.example.com');
      v.publicUrl = u;
    }
    setSetting('mail', JSON.stringify(v));
    transport = null;
    adminLog(req, 'mail_settings', null, v.host || '');
    res.json({ ok: true, ready: mailReady() });
  });
  api.post('/admin/mail/test', auth, wrap(async (req, res) => {
    requireInstanceAdmin(req.userId);
    rateLimit('mailtest:' + req.userId, 10, 3600000);
    const to = String((req.body || {}).to || '').trim();
    if (!EMAIL_RE.test(to)) fail(400, 'Enter an email address to send the test to.');
    try { await sendMail({ to, subject: `${brandName()}: test email`, text: `It works! ${brandName()} can send email (password resets and email confirmations).` }); } catch (e) { if (e.status) throw e; fail(502, `Sending failed: ${String(e.message || e).slice(0, 200)}`); }
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ one-time tokens (reset links, email codes)
  function newToken(uid, kind, data, ttlMs) {
    db.prepare('DELETE FROM auth_tokens WHERE (user_id = ? AND kind = ?) OR expires_at < ?').run(uid, kind, now());
    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO auth_tokens (id, user_id, kind, data, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(tokenId(raw), uid, kind, JSON.stringify(data || {}), now() + ttlMs, now());
    return raw;
  }
  const findToken = (raw, kind) => {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
    const t = db.prepare('SELECT * FROM auth_tokens WHERE id = ? AND kind = ?').get(tokenId(raw), kind);
    return t && t.expires_at > now() ? t : null;
  };
  setInterval(() => db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now()), 3600000).unref();

  // Confirms it's really you (current password) before changing email, 2FA or the recovery key.
  async function checkPassword(row, authKey) {
    if (typeof authKey !== 'string' || !(await bcrypt.compare(authKey, row.auth_hash))) fail(401, 'Your password is not right.');
  }

  // ------------------------------------------------------------------ email on your account
  api.post('/me/email', auth, wrap(async (req, res) => {
    rateLimit('email:' + req.userId, 6, 3600000);
    const row = getUserRow(req.userId);
    await checkPassword(row, (req.body || {}).authKey);
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, 'That doesn’t look like an email address.');
    const other = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.userId);
    if (other) fail(409, 'That email is already used by another account.');
    if (!mailReady()) fail(503, 'Email isn’t set up on this server yet. Ask the owner.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    newToken(req.userId, 'email', { email, code: sha(code), tries: 0 }, 30 * 60000);
    await sendMail({ to: email, subject: `${brandName()}: your confirmation code is ${code}`, text: `Your code to confirm this email for ${row.username} on ${brandName()} is:\n\n    ${code}\n\nIt works for 30 minutes. If you didn't ask for this, ignore this email.` });
    res.json({ ok: true, sentTo: email });
  }));
  api.post('/me/email/verify', auth, (req, res) => {
    const t = db.prepare("SELECT * FROM auth_tokens WHERE user_id = ? AND kind = 'email'").get(req.userId);
    if (!t || t.expires_at < now()) fail(400, 'That code expired. Send a new one.');
    const d = JSON.parse(t.data);
    if (d.tries >= 5) { db.prepare('DELETE FROM auth_tokens WHERE id = ?').run(t.id); fail(429, 'Too many wrong codes. Send a new one.'); }
    if (!safeEq(sha(String((req.body || {}).code || '').replace(/\D/g, '')), d.code)) {
      d.tries += 1;
      db.prepare('UPDATE auth_tokens SET data = ? WHERE id = ?').run(JSON.stringify(d), t.id);
      fail(400, 'That code isn’t right.');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(d.email, req.userId)) fail(409, 'That email is already used by another account.');
    db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(d.email, req.userId);
    db.prepare('DELETE FROM auth_tokens WHERE id = ?').run(t.id);
    broadcastUser(req.userId);
    res.json(selfUser(getUserRow(req.userId)));
  });
  api.delete('/me/email', auth, wrap(async (req, res) => {
    const row = getUserRow(req.userId);
    await checkPassword(row, (req.body || {}).authKey);
    db.prepare('UPDATE users SET email = NULL, email_verified = 0 WHERE id = ?').run(req.userId);
    broadcastUser(req.userId);
    res.json(selfUser(getUserRow(req.userId)));
  }));

  // ------------------------------------------------------------------ recovery key
  // The browser makes a random recovery key, encrypts a second copy of your private key with it and sends
  // only that encrypted copy here. The recovery key itself never leaves your device.
  api.put('/me/recovery', auth, wrap(async (req, res) => {
    const row = getUserRow(req.userId);
    const b = req.body || {};
    await checkPassword(row, b.authKey);
    if (!isB64ish(b.encPrivateKeyRecovery, 4000) || !isSalt(b.recoverySalt)) fail(400, 'Bad key material.');
    db.prepare('UPDATE users SET enc_private_key_recovery = ?, recovery_salt = ? WHERE id = ?').run(b.encPrivateKeyRecovery, b.recoverySalt, req.userId);
    res.json(selfUser(getUserRow(req.userId)));
  }));
  api.delete('/me/recovery', auth, wrap(async (req, res) => {
    const row = getUserRow(req.userId);
    await checkPassword(row, (req.body || {}).authKey);
    db.prepare('UPDATE users SET enc_private_key_recovery = NULL, recovery_salt = NULL WHERE id = ?').run(req.userId);
    res.json(selfUser(getUserRow(req.userId)));
  }));

  // ------------------------------------------------------------------ two-factor sign-in
  const secretOf = (row) => { const s = row.totp_secret ? unseal(row.totp_secret) : null; return s && s.s ? b32decode(s.s) : null; };
  function totpOk(row, code) {
    const secret = secretOf(row);
    const c = String(code || '').replace(/\D/g, '');
    if (!secret || c.length !== 6) return false;
    const step = Math.floor(now() / 30000);
    for (const d of [-1, 0, 1]) {
      const s = step + d;
      if (row.totp_last_step && s <= row.totp_last_step) continue; // each code works once
      if (safeEq(hotp(secret, s), c)) { db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(s, row.id); return true; }
    }
    return false;
  }
  function backupOk(row, code) {
    const c = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (c.length !== 10) return false;
    const list = JSON.parse(row.backup_codes || '[]');
    const h = sha(c);
    const i = list.findIndex((x) => safeEq(x, h));
    if (i < 0) return false;
    list.splice(i, 1);
    db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(list), row.id);
    return true;
  }
  const newBackupCodes = (uid) => {
    const codes = Array.from({ length: 10 }, () => b32encode(crypto.randomBytes(7)).toLowerCase().slice(0, 10));
    db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(codes.map(sha)), uid);
    return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
  };
  // For login and password reset: throws unless a right code (or an unused backup code) came with it.
  function require2fa(row, body) {
    if (!row.totp_enabled) return;
    const b = body || {};
    if (!b.totp && !b.backupCode) fail(401, 'Enter the 6-digit code from your authenticator app.', 'need_2fa');
    rateLimit('totp:' + row.id, 8, 15 * 60000);
    if (b.totp ? totpOk(row, b.totp) : backupOk(row, b.backupCode)) return;
    secEvent('failed_2fa', '', row.username);
    fail(401, b.totp ? 'That code isn’t right. Check your phone’s clock and try the newest code.' : 'That backup code isn’t right or was already used.', 'bad_2fa');
  }

  api.post('/me/2fa/setup', auth, wrap(async (req, res) => {
    const row = getUserRow(req.userId);
    await checkPassword(row, (req.body || {}).authKey);
    if (row.totp_enabled) fail(400, 'Two-factor sign-in is already on.');
    const secret = b32encode(crypto.randomBytes(20));
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?').run(seal({ s: secret }), req.userId);
    const issuer = encodeURIComponent(brandName());
    res.json({ secret: secret.match(/.{1,4}/g).join(' '), uri: `otpauth://totp/${issuer}:${encodeURIComponent(row.username)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` });
  }));
  api.post('/me/2fa/enable', auth, (req, res) => {
    rateLimit('totpsetup:' + req.userId, 10, 15 * 60000);
    const row = getUserRow(req.userId);
    if (row.totp_enabled) fail(400, 'Two-factor sign-in is already on.');
    if (!totpOk(row, (req.body || {}).code)) fail(400, 'That code isn’t right. Type the 6 digits your app shows now.');
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.userId);
    const backupCodes = newBackupCodes(req.userId);
    // Everyone else signed in on this account has to sign in again, now with a code.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.userId, tokenId(req.token));
    secEvent('2fa_enabled', cleanIp(req.ip), row.username);
    res.json({ backupCodes, user: selfUser(getUserRow(req.userId)) });
  });
  api.post('/me/2fa/disable', auth, wrap(async (req, res) => {
    const row = getUserRow(req.userId);
    const b = req.body || {};
    await checkPassword(row, b.authKey);
    require2fa(row, b);
    db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, backup_codes = '[]' WHERE id = ?").run(req.userId);
    secEvent('2fa_disabled', cleanIp(req.ip), row.username);
    res.json(selfUser(getUserRow(req.userId)));
  }));
  api.post('/me/2fa/backup-codes', auth, (req, res) => {
    const row = getUserRow(req.userId);
    require2fa(row, { totp: (req.body || {}).code });
    res.json({ backupCodes: newBackupCodes(req.userId) });
  });
  api.post('/admin/users/:id/2fa/remove', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const r = getUserRow(req.params.id);
    if (!r) fail(404, 'No such user.');
    db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, backup_codes = '[]' WHERE id = ?").run(r.id);
    adminLog(req, '2fa_removed', r.id, r.username);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ forgot password
  // Always answers the same way, so it can't be used to find out which accounts or emails exist.
  api.post('/auth/forgot', wrap(async (req, res) => {
    rateLimit('forgot:' + req.ip, 5, 15 * 60000);
    if (!mailReady()) fail(503, 'Password reset by email isn’t set up on this server. Ask the owner.');
    const login = String((req.body || {}).login || '').trim().slice(0, 200);
    const row = login.includes('@')
      ? db.prepare('SELECT * FROM users WHERE email = ? AND email_verified = 1').get(login.toLowerCase())
      : db.prepare('SELECT * FROM users WHERE username = ?').get(login);
    if (row && row.email && row.email_verified && !row.is_bot) {
      rateLimit('forgotuser:' + row.id, 3, 3600000);
      const raw = newToken(row.id, 'reset', {}, 30 * 60000);
      const link = `${mailCfg().publicUrl}/#reset=${raw}`;
      sendMail({ to: row.email, subject: `${brandName()}: reset your password`, text:
        `Someone (hopefully you) asked to reset the password for ${row.username} on ${brandName()}.\n\nOpen this link within 30 minutes to choose a new one:\n\n${link}\n\n`
        + (row.enc_private_key_recovery ? 'Have your recovery key ready: with it, all your old messages stay readable.\n\n' : 'Without a recovery key, your old direct messages won\'t be readable after the reset.\n\n')
        + 'If you didn\'t ask for this, ignore this email: your password stays the same.' }).catch(() => {});
      secEvent('reset_requested', cleanIp(req.ip), row.username);
    }
    res.json({ ok: true });
  }));
  api.post('/auth/reset/info', (req, res) => {
    rateLimit('resetinfo:' + req.ip, 20, 15 * 60000);
    const t = findToken((req.body || {}).token, 'reset');
    if (!t) fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    const row = getUserRow(t.user_id);
    res.json({ username: row.username, hasRecovery: !!row.enc_private_key_recovery, recoverySalt: row.recovery_salt || null, encPrivateKeyRecovery: row.enc_private_key_recovery || null, need2fa: !!row.totp_enabled });
  });
  api.post('/auth/reset', wrap(async (req, res) => {
    rateLimit('reset:' + req.ip, 10, 15 * 60000);
    const b = req.body || {};
    const t = findToken(b.token, 'reset');
    if (!t) fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    const row = getUserRow(t.user_id);
    require2fa(row, b);
    if (!/^[0-9a-f]{64}$/.test(b.authKey || '') || !isB64ish(b.encPrivateKey, 4000) || !isSalt(b.kdfSalt)) fail(400, 'Bad key material.');
    const keep = !!b.keepKeys && !!row.enc_private_key_recovery;
    if (!keep && !isB64ish(b.publicKey, 2000)) fail(400, 'Bad key material.');
    const hash = await bcrypt.hash(b.authKey, 11);
    const servers = db.prepare('SELECT server_id FROM members WHERE user_id = ?').all(row.id).map((m) => m.server_id);
    db.transaction(() => {
      db.prepare("UPDATE users SET auth_hash = ?, kdf = 'argon2id', kdf_salt = ?, enc_private_key = ? WHERE id = ?").run(hash, b.kdfSalt, b.encPrivateKey, row.id);
      if (!keep) {
        // New keys: the old ones are gone for good. Friends' apps see the change (and say so), and re-share
        // every server's current key with the new one.
        db.prepare('UPDATE users SET public_key = ?, sign_public_key = NULL, enc_sign_private_key = NULL, enc_private_key_recovery = NULL, recovery_salt = NULL WHERE id = ?').run(b.publicKey, row.id);
        db.prepare('DELETE FROM server_keys WHERE user_id = ?').run(row.id);
      }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = 'reset'").run(row.id);
    })();
    // New public key first, then "please share": members must already know the new key when they re-share.
    broadcastUser(row.id);
    if (!keep) servers.forEach((sid) => emitKeyState(sid));
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at, ua, last_seen, ip) VALUES (?, ?, ?, ?, ?, ?)').run(tokenId(token), row.id, now(), String(req.headers['user-agent'] || '').slice(0, 300), now(), cleanIp(req.ip));
    recordIp(row.id, req.ip, token);
    secEvent('password_reset', cleanIp(req.ip), `${row.username}${keep ? ' (kept keys)' : ' (new keys)'}`);
    sendMail({ to: row.email, subject: `${brandName()}: your password was changed`, text: `The password for ${row.username} on ${brandName()} was just reset, and every device was signed out.\n\nIf this wasn't you, reset it again right away and tell the server owner.` }).catch(() => {});
    const fresh = getUserRow(row.id);
    res.json({ token, user: selfUser(fresh), encPrivateKey: fresh.enc_private_key });
  }));

  // What selfUser() adds about these settings (only ever sent to the account itself).
  const selfExtras = (row) => ({ email: row.email || null, emailVerified: !!row.email_verified, emailMasked: mask(row.email), hasRecovery: !!row.enc_private_key_recovery, totpEnabled: !!row.totp_enabled, backupCodesLeft: row.totp_enabled ? JSON.parse(row.backup_codes || '[]').length : 0 });
  return { require2fa, selfExtras, mailReady, sendMail, mask };
};
