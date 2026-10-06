// Small admin command line, used by scripts (e.g. setup-turn.sh). Safe to run while Hearth is running.
//   node server/cli.js set-turn "turn:203.0.113.7:3478?transport=udp,turn:203.0.113.7:3478?transport=tcp" SECRET
//   node server/cli.js get-turn
const { db } = require('./db');
const set = (k, v) => db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(k, v);
const get = (k) => (db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(k) || {}).value;
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'set-turn' && a && b) { set('turnUrls', a); set('turnSecret', b); console.log('TURN relay saved. Calls use it right away.'); }
else if (cmd === 'get-turn') console.log(JSON.stringify({ urls: get('turnUrls') || null, secretSet: !!get('turnSecret') }));
else { console.log('Usage: node server/cli.js set-turn <urls> <secret> | get-turn'); process.exitCode = 1; }
