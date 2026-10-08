// "What's new": shown once after this server is updated (not on someone's very first visit).
// Newest first. Keep each item short and about what people can do.
export const CHANGES = [
  { version: '1.21.0', items: [
    'Settings → Sessions shows every device signed in to your account (device, IP address, last active). Sign one out, or all the others at once.',
    'Changing your password, email or recovery key now asks for your two-factor code too (when it’s on), and you get an email whenever something important changes.',
    'You can delete your account in Settings → Security & storage.',
    'Behind the scenes: tougher limits against password guessing, a tamper-proof audit log for admins, encrypted backups that are test-restored every day, and an automated attacker that checks every part of the server on each update.',
  ] },
  { version: '1.20.0', items: [
    'Forgot your password? Add an email in Settings → My Account and you can reset it from the sign-in screen. Save your recovery key there too, so a reset keeps all your old messages.',
    'Two-factor sign-in with an authenticator app, plus backup codes (Settings → My Account).',
    'Check my encryption: one button that tests every lock on your device and your keys. Message lengths are now hidden too.',
    'News bot: Server Settings → News bot posts new articles, videos, patch notes and releases on any topic as they come out — never old news.',
  ] },
  { version: '1.19.0', items: [
    'Push to talk: Settings → Voice & video → Input mode. In the desktop app your keys work even while a game is focused.',
    'Keybinds: pick your own keys (or mouse side buttons) for push to talk, mute and deafen in Settings → Keybinds.',
    'Desktop app: updates itself, Mute/Deafen buttons in the taskbar preview, the taskbar flashes when someone @mentions you, invite links open in the app, and it reconnects right after your PC wakes up.',
  ] },
  { version: '1.18.1', items: ['A new GIF picker laid out like Discord’s: GIFs, Stickers and Emoji tabs, Favorites and Trending tiles, and smoother scrolling.'] },
  { version: '1.18.0', items: [
    'Show the game you’re playing and the music you’re listening to (Settings → Games & music). Add your favorite games to your profile.',
    'Support the server: become a supporter from the 💜 card on Home.',
  ] },
  { version: '1.17.0', items: ['Polls, voice messages, events with RSVPs, message reminders, and a People page. Profiles got a big new header.'] },
];

const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
// Returns the entries newer than what this device last saw, and remembers the current version.
export function unseenChanges(current) {
  const KEY = 'hearth.seenVersion';
  let seen = null;
  try { seen = localStorage.getItem(KEY); localStorage.setItem(KEY, current); } catch { return []; }
  if (!seen || !current || cmp(current, seen) <= 0) return [];
  return CHANGES.filter((c) => cmp(c.version, seen) > 0 && cmp(c.version, current) <= 0);
}
