// "What's new": shown once after this server is updated (not on someone's very first visit).
// Newest first. Keep each item short and about what people can do.
export const CHANGES = [
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
