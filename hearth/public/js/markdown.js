// Safe, small markdown: everything is HTML-escaped first, then a fixed set of patterns is applied.
import { escapeHtml } from './util.js';

const URL_RE = /\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g;
const IMAGE_URL_RE = /^https?:\/\/[^\s]+\.(gif|png|jpe?g|webp)(\?[^\s]*)?$/i;
const MEDIA_HOST_RE = /^https?:\/\/(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)\//i;

export function isImageUrl(url) {
  return IMAGE_URL_RE.test(url) || MEDIA_HOST_RE.test(url);
}

export function extractImageUrls(text) {
  return (String(text || '').match(URL_RE) || []).filter(isImageUrl).slice(0, 4);
}

export function isOnlyImageUrl(text) {
  const t = String(text || '').trim();
  return !/\s/.test(t) && isImageUrl(t);
}

// The app tells the renderer how to look up custom emoji (<:name:id>) and role mentions (<@&id>).
let resolve = { emoji: () => null, role: () => null };
export function setResolvers(r) { resolve = { ...resolve, ...r }; }
const CUSTOM_EMOJI = /<(a?):([A-Za-z0-9_]{2,32}):([a-z0-9]{6,40})>/g;
const ROLE_MENTION = /<@&([a-z0-9]{6,40})>/g;

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
  // custom emoji and role mentions
  s = s.replace(CUSTOM_EMOJI, (m, a, name, id) => {
    const e = resolve.emoji(id);
    return keep(e ? `<img class="cemoji" src="${escapeHtml(e.url)}" alt=":${name}:" title=":${name}:" draggable="false" loading="lazy">` : escapeHtml(`:${name}:`));
  });
  s = s.replace(ROLE_MENTION, (m, id) => {
    const r = resolve.role(id);
    if (!r) return keep('<span class="mention">@deleted-role</span>');
    return keep(`<span class="mention role-mention${r.mine ? ' mention-me' : ''}"${r.color ? ` style="--rc:${escapeHtml(r.color)}"` : ''}>@${escapeHtml(r.name)}</span>`);
  });
  // links
  s = s.replace(URL_RE, (url) => keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>`));

  s = escapeHtml(s);

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="md-spoiler" tabindex="0" role="button" aria-label="Spoiler, select to reveal">$1</span>');
  s = s.replace(/(^|\s)@([a-zA-Z0-9_.]{2,24})/g, (m, pre, name) => {
    const special = ['everyone', 'channel', 'here'].includes(name.toLowerCase());
    if (special && !everyone) return `${pre}@${name}`;
    const me = mentionName && (name.toLowerCase() === mentionName.toLowerCase() || special);
    return `${pre}<span class="mention${me ? ' mention-me' : ''}">@${name}</span>`;
  });

  if (!inline) {
    s = s.split('\n').map((line) => (line.startsWith('&gt; ') ? `<span class="md-quote">${line.slice(5)}</span>` : line)).join('\n');
    s = s.replace(/\n/g, '<br>');
  } else {
    s = s.replace(/\n/g, ' ');
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
