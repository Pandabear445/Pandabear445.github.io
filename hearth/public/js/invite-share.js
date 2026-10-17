// Sharing an invite (app.js openInvite, the "Invite your people" welcome after creating or importing a server, and
// the "It's just you here" card): the words people copy or share, kept here so they can be checked on their own.
// Plain text only. Nothing is sent anywhere by Hearth: copying puts it on the clipboard, Share hands it to the
// device's own share sheet. No contacts, no tracking, no counts.

// How long a link lasts, as the invite dialog offers it (hours; 0 = never).
export function expiryWords(hours) {
  const h = Number(hours) || 0;
  if (!h) return null;
  if (h < 24) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

// How this instance lets new people in, from /api/config: 'open', 'code' (making an account needs the instance's
// sign-up code) or 'closed' (only people who already have an account). Anything unclear counts as closed, so the
// words below never promise a sign-up that isn't there.
export function signUpMode(config) {
  if (!config || !config.registrationOpen) return 'closed';
  return config.registrationRequiresCode ? 'code' : 'open';
}

// The last line of the invite message: where they'll make an account, and what that takes. Never the sign-up code
// itself (that's the instance's to give out, and a copied message travels further than meant).
function accountLine(instance, mode) {
  const where = instance || 'Hearth';
  if (mode === 'code') return `You’ll make an account on ${where} first, which needs a sign-up code: ask me for it.`;
  if (mode === 'closed') return `It only works with an account you already have on ${where} (it isn’t taking new sign-ups).`;
  return `You’ll make an account on ${where} first.`;
}

// "Join me in <server> on Hearth: <link>", then what Hearth is and where they'll make an account (mode: signUpMode).
// With link: null (for the share sheet, which carries the link on its own) the first line ends at the server's name.
export function inviteMessage({ serverName, link, instance, mode = 'open' }) {
  const first = link ? `Join me in ${serverName} on Hearth: ${link}` : `Join me in ${serverName} on Hearth.`;
  return `${first}\nIt’s free, private chat (messages are end-to-end encrypted). ${accountLine(instance, mode)}`;
}

// The invite dialog's line about new people (mode: signUpMode). manages: this person can change sign-ups (an
// instance owner or admin), so they're told where.
export function joinNote({ serverName, instance, mode = 'open', manages = false }) {
  const where = instance || 'Hearth';
  if (mode === 'code') {
    return `New people need ${where}’s sign-up code to make an account, then land right in ${serverName}. Send them the code separately; it isn’t in the link or the message. `
      + (manages ? 'It’s in Admin → Registration & Terms.' : `Whoever runs ${where} has it.`);
  }
  if (mode === 'closed') {
    return `${where} isn’t taking new sign-ups, so only people who already have an account here can join.`
      + (manages ? ' You can open sign-ups in Admin → Registration & Terms.' : '');
  }
  return `New people make an account on ${where} first, then land right in ${serverName}.`;
}

// For a server just imported from Discord: an announcement to post there, with how long the link lasts, and when
// making an account takes more than the link (mode: signUpMode), what it takes. The link stays last.
export function movingMessage({ link, hours, mode = 'open', instance }) {
  const lasts = expiryWords(hours);
  const needs = mode === 'code' ? ' Making an account there needs a sign-up code, so ask me for it.'
    : mode === 'closed' ? ` For now it only works for people who already have an account on ${instance || 'it'}.` : '';
  return `We’re trying Hearth, a self-hosted chat where messages are end-to-end encrypted.${needs} Our channels and roles are already set up: ${link}${lasts ? ` (link expires in ${lasts})` : ''}`;
}

// The device's share sheet: phones and some desktop browsers. Not in the desktop app or the Android app's web view,
// where it's missing or doesn't reach a real share sheet.
export function canShare({ nav = globalThis.navigator, desktop = false, android = false } = {}) {
  return !desktop && !android && !!nav && typeof nav.share === 'function';
}

// "It's just you here. Invite people": in a server (not a group chat) where you're the only member and may invite,
// until you dismiss it there.
export function nudgeWanted(server, { canInvite, dismissed }) {
  return !!server && server.kind !== 'group' && Array.isArray(server.memberIds) && server.memberIds.length === 1 && !!canInvite && !dismissed;
}

// Dismissals are remembered per server in this browser (a convenience: blocked storage just shows the card again).
const NUDGE_KEY = 'hearth.inviteNudgeDismissed';
const NUDGE_KEEP = 200;
function dismissedList(storage) {
  try {
    const v = JSON.parse((storage || globalThis.localStorage).getItem(NUDGE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
export function nudgeDismissed(serverId, storage) {
  return dismissedList(storage).includes(serverId);
}
export function dismissNudge(serverId, storage) {
  try {
    const list = dismissedList(storage).filter((x) => x !== serverId);
    list.push(serverId);
    (storage || globalThis.localStorage).setItem(NUDGE_KEY, JSON.stringify(list.slice(-NUDGE_KEEP)));
  } catch { /* storage blocked: it's hidden until the channel is drawn again */ }
}
