// Safe, small markdown: everything is HTML-escaped first, then a fixed set of patterns is applied.
import { escapeHtml, icons } from './util.js';

export const URL_RE = /\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g;
const IMAGE_URL_RE = /^https?:\/\/[^\s]+\.(gif|png|jpe?g|webp)(\?[^\s]*)?$/i;
const MEDIA_HOST_RE = /^https?:\/\/(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)\//i;

export function isImageUrl(url) {
  return IMAGE_URL_RE.test(url) || MEDIA_HOST_RE.test(url);
}

export function extractImageUrls(text) {
  return (String(text || '').match(URL_RE) || []).filter(isImageUrl).slice(0, 4);
}

// The links a message's text turns into (as render() makes them), leaving out code and, with skipSpoilers,
// ||spoilers||. Link previews use this on both sides: the sender to pick a link, readers to check that a
// preview belongs to a link really in the message.
export function linkedUrls(text, { skipSpoilers = false } = {}) {
  let s = String(text || '');
  s = s.replace(/```(?:[a-zA-Z0-9_+-]{1,20}\n)?([\s\S]*?)```/g, ' ');
  s = s.replace(/`([^`\n]+)`/g, ' ');
  if (skipSpoilers) s = s.replace(/\|\|([^|\n]+)\|\|/g, ' ');
  return s.match(URL_RE) || [];
}

export function isOnlyImageUrl(text) {
  const t = String(text || '').trim();
  return !/\s/.test(t) && isImageUrl(t);
}

// The app tells the renderer how to look up custom emoji (<:name:id>), role mentions (<@&id>) and channel mentions
// (<#id>). The channel lookup only knows channels the reader can see: any other id shows as #unknown-channel, so a
// mention never gives away a private channel's name.
let resolve = { emoji: () => null, role: () => null, channel: () => null };
export function setResolvers(r) { resolve = { ...resolve, ...r }; }
const CUSTOM_EMOJI = /<(a?):([A-Za-z0-9_]{2,32}):([a-z0-9]{6,40})>/g;
const ROLE_MENTION = /<@&([a-z0-9]{6,40})>/g;
export const CHANNEL_MENTION = /<#([a-z0-9]{6,40})>/g;
// Discord's timestamps, <t:seconds> or <t:seconds:style>, shown in each reader's own time zone and language (the
// same syntax server/webhooks.js turns into plain dates for webhook posts).
const TIMESTAMP = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g;
const STAMP_STYLES = {
  t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' },
};
const REL_UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
// The words for a timestamp in one of Discord's styles (f by default; R is relative, like "in 3 days"), or null
// for a time no date can hold.
export function formatStamp(seconds, style = 'f', now = Date.now()) {
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  if (style === 'R') {
    const diff = (d.getTime() - now) / 1000;
    const [unit, size] = REL_UNITS.find(([, n]) => Math.abs(diff) >= n) || REL_UNITS[REL_UNITS.length - 1];
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / size), unit);
  }
  return new Intl.DateTimeFormat(undefined, STAMP_STYLES[style] || STAMP_STYLES.f).format(d);
}

// A message's text with its mention, emoji and timestamp tokens in words, for places that show plain text
// (notifications, conversation previews, the reply bar).
export function readableText(text) {
  return String(text || '')
    .replace(CHANNEL_MENTION, (m, id) => { const c = resolve.channel(id); return c ? `#${c.name}` : '#unknown-channel'; })
    .replace(ROLE_MENTION, (m, id) => { const r = resolve.role(id); return r ? `@${r.name}` : '@deleted-role'; })
    .replace(CUSTOM_EMOJI, (m, a, name) => `:${name}:`)
    .replace(TIMESTAMP, (m, n, style) => formatStamp(n, style || 'f') || m);
}

// Text typed where there's no # picker (a server's welcome message, in Server settings): "#rules" becomes a link to
// the channel of that name among `channels` (those the reader can see), outside code. Anything else stays text.
export function linkChannelNames(text, channels) {
  const byName = new Map((channels || []).map((c) => [String(c.name).toLowerCase(), c.id]));
  return String(text || '').split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => (i % 2 ? part
    : part.replace(/(^|[\s*_~|(])#([\w-]{1,32})(?![\w-])/g, (m, pre, name) => (byName.has(name.toLowerCase()) ? `${pre}<#${byName.get(name.toLowerCase())}>` : m)))).join('');
}

// Discord's line formatting: # headings, -# small print, - or * bullets, 1. numbered steps (indent to nest).
// Matched on the escaped line before bold and italics, so a "* item" isn't taken for the start of italics.
// Headings need a space after the hashes, so #channel names and "#1" stay text.
const HEADING = /^(#{1,3}) +(?=\S)/;
const SUBTEXT = /^-# +(?=\S)/;
const BULLET = /^( {0,8})[-*] +(?=\S)/;
const NUMBERED = /^( {0,8})(\d{1,3})\. +(?=\S)/;
const QUOTE = /^&gt; /; // "> " quotes one line
const QUOTE_REST = /^&gt;&gt;&gt;(?: |$)/; // ">>> " quotes everything after it
const level = (indent) => Math.min(2, Math.floor((indent.length + 1) / 2));
function lineBlock(line) {
  let m = HEADING.exec(line);
  if (m) return { cls: `md-h${m[1].length}`, body: line.slice(m[0].length) };
  if ((m = SUBTEXT.exec(line))) return { cls: 'md-sub', body: line.slice(m[0].length) };
  if ((m = BULLET.exec(line))) return { cls: 'md-li', list: 'ul', lvl: level(m[1]), body: line.slice(m[0].length) };
  if ((m = NUMBERED.exec(line))) return { cls: 'md-li md-ol', list: 'ol', lvl: level(m[1]), n: +m[2], body: line.slice(m[0].length) };
  return null;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u;
export function isJumbo(text) {
  const t = String(text || '').replace(CUSTOM_EMOJI, '\u{1F642}').trim();
  if (!t || /[0-9#*]/.test(t)) return false;
  return EMOJI_ONLY.test(t) && [...t.replace(/\s/g, '')].length <= 27;
}

export function render(text, { mentionName = '', inline = false, everyone = true } = {}) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(text || '');

  // code blocks + inline code are stashed so nothing inside them is formatted
  s = s.replace(/```(?:[a-zA-Z0-9_+-]{1,20}\n)?([\s\S]*?)```/g, (_, code) => keep(`<pre class="md-pre"><code>${escapeHtml(code.replace(/^\n|\n$/g, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="md-code">${escapeHtml(code)}</code>`));
  // custom emoji, role and channel mentions, timestamps
  s = s.replace(CUSTOM_EMOJI, (m, a, name, id) => {
    const e = resolve.emoji(id);
    return keep(e ? `<img class="cemoji" src="${escapeHtml(e.url)}" alt=":${name}:" title=":${name}:" draggable="false" loading="lazy">` : escapeHtml(`:${name}:`));
  });
  s = s.replace(ROLE_MENTION, (m, id) => {
    const r = resolve.role(id);
    if (!r) return keep('<span class="mention">@deleted-role</span>');
    return keep(`<span class="mention role-mention${r.mine ? ' mention-me' : ''}"${r.color ? ` style="--rc:${escapeHtml(r.color)}"` : ''}>@${escapeHtml(r.name)}</span>`);
  });
  // A channel the reader can see links to it: the app opens it in place, and #c/<id> is the same link anywhere.
  s = s.replace(CHANNEL_MENTION, (m, id) => {
    const c = resolve.channel(id);
    if (!c) return keep(inline ? '#unknown-channel' : '<span class="channel-unknown">#unknown-channel</span>');
    const name = escapeHtml(c.name);
    if (inline) return keep(`#${name}`);
    const voice = c.type === 'voice';
    return keep(`<a class="mention channel-mention" href="#c/${escapeHtml(id)}" data-channel="${escapeHtml(id)}" data-server="${escapeHtml(c.serverId || '')}"`
      + `${voice ? ` aria-label="${name} (voice channel)"` : ''}>${voice ? `<span class="ic">${icons.speaker}</span>` : '#'}${name}</a>`);
  });
  s = s.replace(TIMESTAMP, (m, n, style) => {
    const words = formatStamp(n, style || 'f');
    if (!words) return m;
    if (inline) return keep(escapeHtml(words));
    return keep(`<time class="md-time" datetime="${new Date(Number(n) * 1000).toISOString()}" title="${escapeHtml(formatStamp(n, 'F'))}">${escapeHtml(words)}</time>`);
  });
  // links
  s = s.replace(URL_RE, (url) => keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>`));

  s = escapeHtml(s);

  // Bold, underline, italics, strike, spoilers and @mentions, inside one line.
  const fmt = (t) => {
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    t = t.replace(/\|\|([^|\n]+)\|\|/g, '<span class="md-spoiler" tabindex="0" role="button" aria-label="Spoiler, select to reveal">$1</span>');
    return t.replace(/(^|\s)@([a-zA-Z0-9_.]{2,24})/g, (m, pre, name) => {
      const special = ['everyone', 'channel', 'here'].includes(name.toLowerCase());
      if (special && !everyone) return `${pre}@${name}`;
      const me = mentionName && (name.toLowerCase() === mentionName.toLowerCase() || special);
      return `${pre}<span class="mention${me ? ' mention-me' : ''}">@${name}</span>`;
    });
  };

  const lines = s.split('\n');
  if (inline) {
    // On one line (replies, thread cards, previews): the words without the line markers; bullets stay as dots.
    s = lines.map((line) => {
      const t = line.replace(QUOTE_REST, '').replace(QUOTE, '');
      const b = lineBlock(t);
      return !b ? fmt(t) : (b.list === 'ul' ? '• ' : b.list === 'ol' ? `${b.n}. ` : '') + fmt(b.body);
    }).join(' ');
  } else {
    // Each line is a row: a block (heading, small print, list item, quote) or plain text. A block starts and ends
    // its own line, so no <br> goes next to one, except where a blank line was typed.
    const rows = [];
    let quoteRest = false;
    let ol = []; // the last number at each list level while a numbered list goes on (1. 1. 1. counts 1 2 3)
    for (const line of lines) {
      let t = line;
      let quoted = quoteRest;
      if (!quoted && QUOTE_REST.test(t)) { quoteRest = quoted = true; t = t.replace(QUOTE_REST, ''); }
      else if (!quoted && QUOTE.test(t)) { quoted = true; t = t.replace(QUOTE, ''); }
      const b = lineBlock(t);
      if (b && b.list === 'ol') { b.n = ol[b.lvl] != null ? ol[b.lvl] + 1 : b.n; ol[b.lvl] = b.n; ol.length = b.lvl + 1; }
      else if (b && b.list === 'ul') ol.length = b.lvl;
      else ol = [];
      let html = b ? `<span class="${b.cls}${b.lvl ? ` md-lv${b.lvl}` : ''}"${b.list === 'ol' ? ` data-n="${b.n}"` : ''}>${fmt(b.body)}</span>` : fmt(t);
      if (quoted) html = `<span class="md-quote">${html}</span>`;
      rows.push({ html, block: quoted || !!b });
    }
    s = rows.map((r, i) => {
      const prev = rows[i - 1];
      const gap = !prev || prev.block ? '' : !r.block || !prev.html ? '<br>' : '';
      return gap + r.html;
    }).join('');
  }
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  return s;
}

export function mentionsUser(text, username) {
  if (!username) return false;
  const re = new RegExp(`(^|\\s)@(${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|everyone|here)(?![a-zA-Z0-9_.])`, 'i');
  return re.test(String(text || ''));
}

// Longer documents (Terms of Service, profile pages): headings, bullet lists and paragraphs,
// with the normal inline formatting inside each line. Everything is escaped by render().
export function renderDoc(text) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map((l) => render(l, { inline: true })).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.map((l) => `<li>${render(l, { inline: true })}</li>`).join('')}</ul>`); list = null; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) { flushPara(); flushList(); const n = hm[1].length; out.push(`<h${n}>${render(hm[2], { inline: true })}</h${n}>`); continue; }
    const lm = /^\s*[-*]\s+(.*)$/.exec(line);
    if (lm) { flushPara(); (list ||= []).push(lm[1]); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}
