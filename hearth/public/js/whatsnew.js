// "What's new": shown once after this server is updated (not on someone's very first visit).
// Newest first. Keep each item short and about what people can do.
export const CHANGES = [
  { version: '1.29.0', items: [
    'Webhooks: give a channel a webhook address (channel settings \u2192 Webhooks) and paste it into Uptime Kuma, Home Assistant, Grafana, GitHub or anything that posts to Discord or Slack. Posts show as the webhook, marked as not end-to-end encrypted, and can\u2019t ping anyone unless you allow it.',
    'Pick your roles: moderators can let members choose roles themselves (ping roles like @game-night, pronouns, colors, opt-in channels) from the server menu or the start of any channel.',
    'Repeating events: every week, every 2 weeks or every month, at the same local time even when the clocks change, and in your calendar with every date.',
    'Moderator tools: disconnect, move or server-mute people in voice (new Move Members and Mute Members permissions), delete a banned person\u2019s messages from the last hour, day or week, and delete up to 100 recent messages at once.',
    'Server audit log (Server settings \u2192 Audit log, with a new View Audit Log permission): who kicked, banned or timed out whom, and who changed roles, channels, permissions and settings, in plain sentences and never what anyone wrote. Reports about messages and members in a server now reach that server\u2019s moderators too (Server settings \u2192 Reports), without the reporter\u2019s name.',
    'Threads you won\u2019t miss: a message that starts a thread shows how many replies are new to you, and the Threads button in a channel lists its threads, newest reply first.',
    'Link previews: paste a link and press Preview to add a card with the page\u2019s title and picture. The card travels inside the encrypted message, so people reading never contact the site. Your server sees the links you preview; choose Ask, Always or Never in Settings \u2192 Chat.',
    'Disappearing messages: set a timer on a DM, a group chat or a channel (its ⋯ menu) and new messages there disappear for everyone after 1 hour, 1 day, 1 week or 4 weeks, with their files, reactions and pins. Turning it on tells you what it can’t stop, like screenshots and backups.',
    'Import from Discord (Add a server \u2192 Import from Discord): start a new server with a Discord server\u2019s roles, categories, channels and channel permissions from its server template. Hearth shows you how to copy the template (it never contacts Discord itself), and lists what comes over and what doesn\u2019t before anything is created.',
    'Android app: notifications even when the app is closed (through a push app such as ntfy), calls that keep going with the screen locked, and invite links that open straight in the app.',
    'Drag channels and categories into order in the sidebar, or drop a channel on a category\u2019s name to move it there; everyone sees the change at once. No mouse? Use Move up / Move down in the channel or category menu.',
    'Automatic Away: you show as Away after 5 to 30 minutes without using Hearth (10 by default, or never; Settings \u2192 Privacy & safety) and as Online again the moment you\u2019re back. Do Not Disturb and Invisible never change. Custom statuses can now clear themselves after 30 minutes, 1 hour, 4 hours, today or this week.',
    'Voice channels have a text chat beside the call: press the chat button in the call, or right-click the channel \u2192 Open chat to read and write without joining. Everyone who can see the voice channel can read it, and voice channels you already had keep your server\u2019s limits on who may post.',
    'Send later: schedule a message from the clock next to the send button. It\u2019s encrypted on your device right away and goes out at its time; edit, reschedule, send now or cancel it from the conversation\u2019s list. Anything scheduled from a device you sign out waits for you to confirm it.',
    'Nicknames: go by a different name in each server (server menu \u2192 Change nickname). People there see it in the member list, on your messages and in calls, while DMs and your profile keep your display name. Moderators with the new Manage nicknames permission can change other people\u2019s, and every change is in the server\u2019s audit log.',
    'Privacy: Hearth now serves its own fonts, so opening the app no longer contacts Google. A picture linked from another site waits until you click Load image, because that site sees your IP address (Settings \u2192 Privacy & safety \u2192 Outside images: Ask first, Always load or Never load). A watch-together video file from another site asks first too.',
    'Security: with two-factor on, changing your password, email or recovery key and other sensitive changes ask for a fresh code every time, even right after you sign in. Changing your password, turning on two-factor or logging out your other devices (now confirmed with your password) gives this device a new sign-in, so a copy of the old one stops working; your other tabs carry on by themselves.',
    'If someone resets their password without their recovery key, members see a Not verified shield on them, and nobody\u2019s app shares a server\u2019s or group\u2019s keys with them until someone there who knew them before compares safety numbers and presses \u201cNumbers match \u2014 verify and share keys\u201d. Until then they can\u2019t make invites or add people to group chats, so someone who only got into their email can\u2019t read along.',
    'Profile songs and GIFs lose hidden tags and comments (names, cover art, editing software) when uploaded. Webhook posts show their own picture only when it comes from Discord, GitHub, Gravatar or a site your server owner allows.',
    'Messages now carry their own id, reply, thread, send time and edit count inside the encryption. If the server moves, repeats, re-dates or rolls back a message, your app marks it with a small yellow flag that says what didn\u2019t match.',
    'Word filter (Settings \u2192 Privacy & safety): hide or blur messages with words you\u2019d rather not see, in servers and DMs. Your list is end-to-end encrypted and sees through accents, look-alike letters, formatting and spaced-out words. Servers can suggest a list too, which you can turn off.',
    'New server setting (Server settings \u2192 Overview \u2192 Privacy): \u201cNew members can\u2019t read messages from before they joined.\u201d With it on, everyone\u2019s apps switch to a fresh key whenever someone joins, so newcomers only see what\u2019s said after they arrive. It\u2019s off by default.',
    'For server owners: alerts can now also reach you on ntfy, a signed webhook, Discord or Slack (Admin \u2192 Health \u2192 Where alerts go), each with a Test button, and Prometheus can scrape /metrics once you set METRICS_TOKEN.',
    'For server owners: update zips can now be signed with your own key, and servers that pinned it refuse anything else (docs/SIGNING.md).',
    'For server owners: a region’s install command (Admin → Regions) now checks the download before running it and needs Hearth opened over https, and the relay setup never shows the relay secret on screen.',
    'Security fixes from a review of this release: roles members pick themselves can’t sit above moderators who mute, move or clean up messages; categories of channels you can’t see stay out of reach; and reminders and inbox copies of disappearing messages now disappear too.',
    'Calls are always checked against the security keys your device saw for each person, even if the server leaves a key out. When someone’s key changed, a blocked call now says so and asks you to compare safety numbers, instead of a generic “signature didn’t check out”.',
    'Invite your people: a new or imported server opens its invite link right away, with a message to copy (and, for a Discord import, an announcement to post there), a Share button on phones, and an “It’s just you here” reminder until someone joins. If your instance needs a sign-up code or is closed to new accounts, the message and dialog say so.',
    'Invite links now show a preview when pasted into Discord, Reddit, X or a text, and people who aren’t signed in see what they’re invited to. Previews only say “a server” unless you turn on Server settings → Overview → Privacy → “Show this server’s name and member count in invite link previews”.',
    'For server owners: releases now come as a ready-made Docker image for 64-bit Intel/AMD and ARM (Raspberry Pi 4 and 5 too). deploy/compose.image.yml runs it without building anything, and deploy/catalogs has templates for the Unraid, CasaOS, Umbrel, Dokploy and Coolify app stores. The Dokploy and Coolify ones make a registration code at install, so nobody who finds the new address can sign up before you and own it.',
    'Discord habits: type # to link a channel (people who can\u2019t see it just see #unknown-channel), and posts copied from Discord keep their # headings, -# small print, - and 1. lists, >>> quotes and <t:\u2026> times. Server welcome messages link #channel names too.',
    'Attachments: press the pencil on a file before sending to add a description (alt text) or mark it as a spoiler. Spoilers stay blurred until clicked, and both are end-to-end encrypted with the message. Your word filter checks descriptions too.',
    'Keyboard shortcuts: press Ctrl+/ (\u2318+/ on a Mac) to see them all, and Shift+Esc to mark the server you\u2019re in as read.',
  ] },
  { version: '1.28.2', items: [
    'Privacy: call relays (including other regions\u2019 relays) no longer get your account id, just a stand-in name that stays the same for you. They still see your IP address, as before.',
  ] },
  { version: '1.28.1', items: [
    'Security fixes from an automated code scan: a generous per-account limit on requests, so one account can\u2019t flood the server; stricter checks on file names, profile CSS and links you open; and the server\u2019s own keys are created safely even if two copies start at once.',
  ] },
  { version: '1.28.0', items: [
    'Search got much better (Ctrl+K): filters like from:@name, in:#channel, before:/after:/during: a date, has:file, has:image, has:link, is:edited and "exact phrases", and it can look through your whole history. Your search words never leave your device.',
    'Calls survive hiccups: if your connection drops, the call keeps going and rejoins by itself (others see you as reconnecting), even after a server restart. The call bar shows what’s really happening, and Call diagnostics (ⓘ in a call) shows how your connection is doing.',
    'Never lose your place: unread badges and a “New messages” line that follow you to every device, Jump to first unread, Mark as read/unread, and drafts that survive reloads.',
    'Saved messages sync to all your devices, with private notes only you can read. Notifications your way: per server, channel and DM, mute for a while, ignore @everyone, quiet hours. Lock screens just say “New message” unless you choose otherwise.',
    'Big files: uploads over 8 MB show real progress, can be cancelled and carry on after a dropped connection. Pictures open in a gallery, videos and songs play right in the chat, and Settings → Storage shows what you use.',
    'Bots: servers can add bots with slash commands, signed webhooks and only the access you approve (Server settings → Bots). Bots can’t read your messages; bot messages are marked as not end-to-end encrypted.',
    'Export my data (Settings → Privacy & safety): a zip of your account and every message you can read, decrypted on your device.',
    'Moderators can time someone out (they can read but not post or talk), and pins have a history.',
    'Security: a big round of fixes from a full audit. Removed members no longer get their roles back by rejoining, private channels can’t be opened by someone who can’t see them, sensitive owner actions ask for your password again, invites can be revoked, and much more (see SECURITY.md on the server’s code page).',
    'Easier to use with a keyboard and screen readers, and faster in big servers.',
    'For server owners: Admin \u2192 Health shows background jobs, backups, relays and disk space, and emails you when something needs a look. Admin \u2192 Security \u2192 Storage & limits shows who uses the space.',
  ] },
  { version: '1.27.1', items: [
    'Change your display name in a couple of taps: click your name at the bottom left \u2192 Change display name, or Settings \u2192 Security. It\u2019s what people see in chats and member lists, doesn\u2019t have to be unique, and emoji are welcome.',
  ] },
  { version: '1.27.0', items: [
    'Change your username in Settings \u2192 Security (it needs your password). Any name nobody has works, and your old one is free for others right away. Your password, friends and messages stay the same.',
    'Admins can change someone\u2019s username from their page in Admin \u2192 Users (for offensive or impersonating names).',
    'Admin: Storage & limits and Broadcast now live under Security.',
  ] },
  { version: '1.26.2', items: [
    'Watch together keeps playing when you leave the call\u2019s page: it shrinks into a mini player in the corner (drag it anywhere) and stays in sync with everyone, so you can chat or browse while you watch. Press \u2922 on it to go back to the call, or \u2715 to hide it (the sound keeps going). No more pausing and jumping back when you return.',
  ] },
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
