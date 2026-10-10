// "What's new": shown once after this server is updated (not on someone's very first visit).
// Newest first. Keep each item short and about what people can do.
export const CHANGES = [
  { version: '1.26.1', items: [
    'Watch together has a full screen button (or press F, or double-click the video). The shared controls and Sync stay at the bottom and fade away while you watch; Esc goes back. On phones it fills the screen and turns sideways where it can.',
  ] },
  { version: '1.26.0', items: [
    'Creator memberships: server owners can sell monthly memberships, like Patreon inside your server. Each one gives a role, and roles can open private channels. Members join from the server\u2019s Memberships row and pay on Stripe\u2019s page; the money goes to the creator. Everything that\u2019s free stays free.',
    'Fixed: on phones and tablets the member list no longer covers the chat every time you open a channel (tap the people button when you want it).',
  ] },
  { version: '1.25.1', items: [
    'Fixed: if a file failed to download once (a brief connection drop or a server restart), it kept failing until you reloaded the app. Now pressing Download again simply tries again, and the error says what went wrong.',
    'Photos, videos and audio files have a Download button (top-right corner), and you can click anywhere on a file card to download it.',
  ] },
  { version: '1.25.0', items: [
    'Watch together: skipping ahead works (dragging YouTube\u2019s progress bar used to snap back). New shared buttons to jump back 10 s or ahead 10/30 s, play/pause for everyone, a clock, and a note when someone else jumps or pauses. Video links in chat get a \u201cWatch together\u201d button.',
    'Screen sharing keeps your DMs private: while you share, direct messages and group chats are covered (and their previews and notifications hidden) unless you press \u201cShow while sharing\u201d. Settings \u2192 Chat can turn it off.',
    'Your regions now keep copies of the server\u2019s encrypted daily backups, so losing the main server isn\u2019t losing everything (reinstall a region once to add this).',
  ] },
  { version: '1.24.1', items: [
    'Fixed: some news feeds (long patch notes, news summaries full of HTML) could freeze the server for up to a minute while the news bot read them, so everyone saw \u201cReconnecting\u2026\u201d and \u201cFailed to fetch\u201d. Feeds are now read in the background with a time limit, and much faster.',
  ] },
  { version: '1.24.0', items: [
    'Call regions, like Discord: press \ud83c\udf10 in the call bar (or right-click a voice channel) to move a call to another region, and everyone in it switches together without hanging up.',
    'The news bot shows as online, appears under Bots in the member list, posts the newest item as soon as you follow something, and no longer skips articles that sites list a few hours late.',
  ] },
  { version: '1.23.0', items: [
    'Study tools are now Recall: flashcards with pictures, Learn, Smart Review, Write, Match, practice tests, Blitz and more, plus courses with exam dates and a focus timer. Turn it on in Settings \u2192 Study tools, then open More \u2192 Study.',
    'Your decks stay end-to-end encrypted and sync between your devices. Decks you made with the old study tools move over by themselves.',
  ] },
  { version: '1.22.1', items: [
    'A tidier app, with every feature still there: Updates, Study, People and Saved messages sit under \u201cMore\u201d in the sidebar, the + next to Direct messages starts a message or a group chat, and pinned messages and notification options are in each chat\u2019s \u22ef menu.',
    'Settings is shorter: Profile, Security and Appearance each have tabs at the top (Sessions is now Security \u2192 Signed-in devices), and profile styling opens when you want it.',
  ] },
  { version: '1.22.0', items: [
    'Server folders: right-click a server \u2192 Move to folder, or drag one onto another. Folders get a name, colour and emoji, can be focused (show only that folder), muted or marked read, and follow you to every device.',
    'Group chats are easier: \u201cNew group chat\u201d under the + next to Direct messages and on the Friends page, up to 25 people, a group picture, and the owner can remove people.',
    'Updates: track a topic, a YouTube channel, a subreddit, a game\u2019s patch notes or a GitHub project, and new posts show up on your Updates page (never old news).',
    'Study tools (turn them on in Settings \u2192 Study tools): a focus timer you can share with your call, flashcards with spaced repetition and quizzes, assignments with reminders, and stats \u2014 all end-to-end encrypted.',
    'Desktop app: fixed blank preview tiles in Appearance, a right-click menu (copy, paste, spelling), zoom, Ctrl+, for Settings, its own settings in Apps & devices, and it keeps retrying when the server is unreachable.',
  ] },
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
