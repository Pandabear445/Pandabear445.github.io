// The VAPID "subject" (RFC 8292): a contact address push services can use to reach whoever runs this server.
// Apple's push service (iPhone, iPad, Safari on Mac) refuses pushes whose subject isn't a mailto: or https:
// address, and reports say it refuses placeholders such as admin@localhost too. Google's and Mozilla's are
// more lenient, so a bad subject shows up as "notifications work everywhere except on Apple devices".
//
// vapidSubject(env) → { subject, placeholder, fixed }
//   VAPID_SUBJECT, tidied (mailto: <a@b> → mailto:a@b), when it's a real mailto: or https: address;
//   else the server's own https PUBLIC_URL; else the old default, with placeholder: true so the server can warn.
const DEFAULT = 'mailto:admin@example.com';
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost|local|localdomain|test|invalid|example)$/i;

function tidy(raw) {
  let s = String(raw || '').trim();
  const m = /^mailto:\s*<?\s*([^<>\s]+?)\s*>?$/i.exec(s);
  if (m) s = `mailto:${m[1]}`;
  return s;
}
function check(s) {
  const mail = /^mailto:[^\s@<>]+@([^\s@<>]+\.[^\s@<>.]+)$/i.exec(s);
  if (mail) return PLACEHOLDER_HOST.test(mail[1]) ? 'placeholder' : 'ok';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !u.hostname.includes('.')) return 'bad';
    return PLACEHOLDER_HOST.test(u.hostname) ? 'placeholder' : 'ok';
  } catch { return 'bad'; }
}
function vapidSubject(env = process.env) {
  const given = tidy(env.VAPID_SUBJECT);
  if (given && check(given) === 'ok') return { subject: given, placeholder: false, fixed: given !== String(env.VAPID_SUBJECT).trim() };
  let site = '';
  try { const u = new URL(String(env.PUBLIC_URL || '').trim()); if (u.protocol === 'https:') site = u.origin; } catch { /* not set */ }
  if (site && check(site) === 'ok') return { subject: site, placeholder: false, fixed: !!given };
  return { subject: given && check(given) !== 'bad' ? given : DEFAULT, placeholder: true, fixed: false };
}
module.exports = { vapidSubject, DEFAULT };
