// What the server's pages may use without asking, and what needs the person's OK first. In a browser, the
// microphone, the camera and reading the clipboard each come with the browser's own prompt; the desktop
// app has to ask itself (main.js shows a native dialog and remembers a yes for that server). Everything
// else the server's pages don't need is refused. No Electron in here, so plain Node can test it.

// Harmless, or decided elsewhere: the screen itself is only ever captured after the person picks it in the
// app's own picker window (the 'screen' result below), whatever 'display-capture' says.
const ALWAYS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']);

// Which consents a request needs. A media request names what it wants (mediaTypes on a request,
// mediaType on a check); when it doesn't say, it needs both.
function kindsFor(perm, details = {}) {
  if (perm === 'clipboard-read') return ['clipboard'];
  if (perm !== 'media') return null;
  const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : details.mediaType ? [details.mediaType] : [];
  const kinds = [];
  if (types.includes('audio')) kinds.push('microphone');
  if (types.includes('video')) kinds.push('camera');
  return kinds.length ? kinds : ['microphone', 'camera'];
}

// A media request that names no device is screen capture: Electron asks this for getDisplayMedia() and for the
// old getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } }), which would capture the whole
// desktop straight away. Either way the person picks what to share first (main.js shows the picker).
const isScreenRequest = (perm, details) => perm === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0;

// 'allow', 'deny', 'screen' (the person picks a screen or window first) or 'ask' (with the consents still missing).
//   fromServer: the request comes from the server's own page (exact origin, see origin.js)
//   granted:    the consents remembered for this server, e.g. { microphone: true }
function decide(perm, details = {}, { fromServer = false, granted = {} } = {}) {
  if (!fromServer) return { result: 'deny' };
  if (ALWAYS.has(perm)) return { result: 'allow' };
  if (isScreenRequest(perm, details)) return { result: details.isMainFrame === false ? 'deny' : 'screen' };
  const kinds = kindsFor(perm, details);
  if (!kinds) return { result: 'deny' };
  if (details.isMainFrame === false) return { result: 'deny' }; // only the app itself, never a frame inside it
  const missing = kinds.filter((k) => granted[k] !== true);
  return missing.length ? { result: 'ask', kinds: missing } : { result: 'allow' };
}

const NAMES = { microphone: 'your microphone', camera: 'your camera', clipboard: 'what you copied (your clipboard)' };
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
// The native dialog's text. Microphone and camera are remembered by default (calls need them every time);
// the clipboard is asked each time unless the person ticks the box, since it may hold a password.
function prompt(kinds, host) {
  const clip = kinds.includes('clipboard');
  return {
    type: 'question',
    buttons: ['Don’t allow', 'Allow'],
    defaultId: clip ? 0 : 1,
    cancelId: 0,
    title: 'Permission',
    message: `Let ${host} use ${list(kinds.map((k) => NAMES[k] || k))}?`,
    detail: clip
      ? 'Hearth asks because a page wants to read what you copied, for example when you press a Paste button. Only allow this if you just did that: the clipboard can hold passwords.'
      : 'Hearth needs this for calls and voice messages. You can change your mind later under Help → Reset permissions.',
    checkboxLabel: `Remember this for ${host}`,
    checkboxChecked: !clip,
  };
}

module.exports = { decide, kindsFor, prompt, isScreenRequest, ALWAYS };
