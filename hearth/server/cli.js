// Small admin command line, used by scripts (e.g. setup-turn.sh). Safe to run while Hearth is running.
//   node server/cli.js set-turn "turn:203.0.113.7:3478?transport=udp,turn:203.0.113.7:3478?transport=tcp" SECRET
//   node server/cli.js get-turn
//   node server/cli.js get-turn-secret             (for setting up a relay in another region)
//   node server/cli.js add-turn "turn:198.51.100.9:3478?transport=udp,…" [SECRET]   (adds, keeps the others)
const { db } = require('./db');
const set = (k, v) => db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(k, v);
const get = (k) => (db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(k) || {}).value;
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'set-turn' && a && b) { set('turnUrls', a); set('turnSecret', b); console.log('TURN relay saved. Calls use it right away.'); }
else if (cmd === 'get-turn') console.log(JSON.stringify({ urls: get('turnUrls') || null, secretSet: !!get('turnSecret') }));
else if (cmd === 'get-turn-secret') { if (get('turnSecret')) console.log(get('turnSecret')); else process.exitCode = 1; }
else if (cmd === 'add-turn' && a) {
  const urls = [...new Set([...(get('turnUrls') || '').split(','), ...a.split(',')].map((x) => x.trim()).filter((u) => /^turns?:/.test(u)))].slice(0, 12);
  set('turnUrls', urls.join(','));
  if (b) set('turnSecret', b);
  console.log(`TURN relays saved (${urls.length / 2 | 0 || urls.length} relay${urls.length > 2 ? 's' : ''}). Calls use them right away.`);
} else { console.log('Usage: node server/cli.js set-turn <urls> <secret> | add-turn <urls> [secret] | get-turn | get-turn-secret'); process.exitCode = 1; }
