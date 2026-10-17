// Incoming webhooks: a secret address per channel that programs post to, the way they post to Discord or Slack.
//
// Uptime Kuma, Grafana, Home Assistant, Jellyfin, GitHub Actions and most CI tools can post to a Discord webhook
// address. Paste a Hearth one instead (https://<hearth>/api/webhooks/<id>/<secret>) and they keep working, with no
// bot to write. Discord-style JSON (content, username, embeds), Slack-style JSON (text, attachments, blocks), a
// Slack form (payload=…), plain text, and GitHub's own events at …/github are all understood.
//
// The rules that keep it safe:
//  - Made, renamed, re-keyed and deleted by people with Manage Channels in that channel (or Manage Server). Making,
//    renaming or re-keying one is posting there, so it also needs Send Messages in the channel (a timeout takes that
//    away). A webhook belongs to whoever made its current address: others change it only from above that person's
//    highest role. The secret is shown once; only a SHA-256 hash of it is kept. Making, changing, rotating and
//    deleting are audit-logged (by webhook id, never the secret).
//  - What comes in is text from outside, so it's stored like a bot post: sealed with the server's at-rest key, not
//    end-to-end encrypted, and the app labels it that way. It's shown through the app's own escaping Markdown.
//  - Nothing is fetched when a post arrives. An avatar_url is kept as a link and only ever shown through the avatar
//    proxy (/media/avatar: netguard, images only), and only when it's on a known avatar host (Discord, GitHub,
//    Gravatar, or one the admin listed in WEBHOOK_AVATAR_HOSTS); see avatarHost in mediasign.js. Anything else
//    shows the webhook's own picture, so a webhook can't make this server fetch any picture on the internet.
//  - It pings nobody unless the webhook was allowed to (off by default; only someone who may mention @everyone in
//    that channel can turn it on, or get a new address for one that may): @everyone, @here, role and @name
//    mentions are defused before the post is stored. Pushes for "All messages" happen either way.
//  - Limits per webhook, per channel and per address; a 64 KB body (1 MB for GitHub events) that must arrive within
//    a few seconds, Discord's own length limits, and the instance word filter. A wrong id and a wrong secret get the
//    same 404.
//  - It pauses while its own account is suspended, and while the person who made its address is suspended, banned
//    from the server or timed out there (they still know the address). The instance's IP bans and maintenance apply.
//    All of that is checked again once the body is in, so a slow request can't post under rules that have changed.
// Each webhook posts as its own bot account (users.is_bot = 1, no bots row: it can't sign in or use the bot API).
// Deleting a webhook whose posts are still there keeps its row as a tombstone (deleted_at) and marks the account
// deleted, so old posts keep their author and nothing can post as it again. When no post is left (it never posted,
// or its channel or server went), the row goes and a trigger in db.js wipes the account like a deleted person's.
// See docs/BOTS.md ("Incoming webhooks").
const crypto = require('crypto');

const NAME_MAX = 32;
const PER_CHANNEL = 10;
const PER_SERVER = 50;
const MAX_TEXT = 8000; // a whole post, once its embeds are turned into text
// Discord's limits (a payload that breaks one gets the same 400 Discord would give), plus Slack's parts.
const L = { content: 2000, text: 4000, username: 80, embeds: 10, title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024,
  footer: 2048, author: 256, embedTotal: 6000, attachments: 20, blocks: 50, blockText: 3000 };
const ID_RE = /^[a-z0-9]{8,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ZW = '\u200b'; // after an @, it stops the app from reading a mention there
const SLACK_COLORS = { good: 0x2eb67d, warning: 0xecb22e, danger: 0xe01e5a };
// How long a body may take to arrive once the address checks out (notifiers send a few KB at once).
const BODY_MS = Math.max(1000, Number(process.env.WEBHOOK_BODY_MS) || 15000);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DUMMY_HASH = sha256('no such webhook');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ Discord-style answers
// Programs written for Discord read { message, code } (and retry_after on a 429), so that's what they get.
class HookError extends Error {
  constructor(status, body, retryAfter) { super(body.message); this.status = status; this.body = body; this.retryAfter = retryAfter; }
}
const unknownHook = () => new HookError(404, { message: 'Unknown Webhook', code: 10015 });
const emptyMessage = () => new HookError(400, { message: 'Cannot send an empty message', code: 50006 });
const badJson = (message = 'The request body contains invalid JSON.') => new HookError(400, { message, code: 50109 });
// "Invalid Form Body" with the path of the field that's wrong, nested the way Discord does it.
function invalid(path, code, message) {
  const errors = {};
  let node = errors;
  const parts = path ? path.split('.') : [];
  parts.forEach((p, i) => { node = node[p] = i === parts.length - 1 ? { _errors: [{ code, message }] } : {}; });
  if (!parts.length) errors._errors = [{ code, message }];
  throw new HookError(400, { message: 'Invalid Form Body', code: 50035, errors });
}

// ------------------------------------------------------------------ reading what was sent
// Control characters out (newlines and tabs stay; \u0000 matters, the app's Markdown uses it inside), and the
// direction overrides that can make text read differently from what it is.
const clean = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
const oneLine = (s) => clean(s).replace(/\s+/g, ' ').trim();
// A display name: no invisible or control characters, no piles of combining marks, one line, at most `max`.
function cleanName(v, max = NAME_MAX) {
  const s = String(v ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}
function str(v, path, max) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
  if (typeof v !== 'string') invalid(path, 'BASE_TYPE_STRING', 'Must be a string.');
  if (v.length > max) invalid(path, 'BASE_TYPE_MAX_LENGTH', `Must be ${max} or fewer in length.`);
  return v;
}
function listOf(v, path, max) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) invalid(path, 'BASE_TYPE_ARRAY', 'Must be an array.');
  if (v.length > max) invalid(path, 'BASE_TYPE_MAX_LENGTH', `Must be ${max} or fewer in length.`);
  return v;
}
// A link to show (http or https only; Hearth's Markdown turns it into a link by itself).
const link = (v) => {
  if (typeof v !== 'string' || v.length > 2048 || !/^https?:\/\/\S+$/i.test(v)) return '';
  try { return new URL(v).href; } catch { return ''; }
};
// The picture someone asked for: only an https address, kept as text and shown through the news bot's proxy.
function avatarOf(v) {
  if (typeof v !== 'string' || !v || v.length > 512) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
const when = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''; };
// An embed's timestamp. One with no time zone is UTC (Uptime Kuma sends "2026-10-11 05:00:00.123"): read as the
// server's local time instead, it would be off by hours on any server not set to UTC, under a "UTC" label.
const NO_ZONE = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?$/;
function stamp(v) {
  if (typeof v === 'number') return when(v);
  if (typeof v !== 'string' || !v.trim()) return '';
  const s = v.trim().slice(0, 64);
  return when(Date.parse(NO_ZONE.test(s) ? `${s.replace(' ', 'T')}Z` : s));
}

// Discord Markdown into Hearth's: masked links show where they go (Hearth has no hidden links, which is safer),
// timestamps become dates, headings become bold lines.
const MASKED = /\[([^\]\n]{1,256})\]\( ?<?(https?:\/\/[^\s<>()]{1,2048})>?(?: "[^"\n]{0,256}")? ?\)/g;
const fromDiscordMd = (s) => clean(s)
  .replace(MASKED, (m, label, url) => (label.trim() === url ? url : `${label.trim()} (${url})`))
  .replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (m, n) => when(Number(n) * 1000) || m)
  .replace(/^#{1,3} +(.+)$/gm, '**$1**')
  .replace(/^-# +(.+)$/gm, '$1');
// Slack's mrkdwn: <url|label> links, <!here>, *bold*, ~strike~, and its &amp; &lt; &gt; escapes. (Every run inside
// <…> has a length cap, so text full of unclosed "<" can't make these scan it over and over.)
const fromSlackMd = (s) => clean(s)
  .replace(/<!(here|channel|everyone)(?:\|[^>]{0,256})?>/g, '@$1')
  .replace(/<!subteam\^[A-Za-z0-9]{1,40}(?:\|@?([^>]{1,256}))?>/g, (m, name) => `@${name || 'group'}`)
  .replace(/<!date\^(\d{1,13})\^[^|>]{0,256}(?:\|([^>]{0,256}))?>/g, (m, n, fb) => when(Number(n) * 1000) || fb || '')
  .replace(/<@[A-Za-z0-9]{1,40}\|([^>]{1,256})>/g, '@$1').replace(/<@([A-Za-z0-9]{1,40})>/g, '@$1')
  .replace(/<#[A-Za-z0-9]{1,40}\|([^>]{1,256})>/g, '#$1').replace(/<#([A-Za-z0-9]{1,40})>/g, '#$1')
  .replace(/<((?:https?|mailto):[^|>\s]{1,2048})\|([^>]{1,256})>/g, (m, url, label) => (url.startsWith('mailto:') || label === url ? label : `${label} (${url})`))
  .replace(/<((?:https?|mailto):[^|>\s]{1,2048})>/g, (m, url) => url.replace(/^mailto:/, ''))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, '$1**$2**')
  .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/gm, '$1~~$2~~');

// An embed's colour as a coloured dot (Hearth's Markdown has no colours): red, green… is what alerts use it for.
function colorNum(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0xffffff) return v;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (SLACK_COLORS[t] !== undefined) return SLACK_COLORS[t];
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(t);
  if (m) return parseInt(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1], 16) || null;
  return /^\d{1,8}$/.test(t) && +t > 0 && +t <= 0xffffff ? +t : null;
}
function dot(n) {
  if (!n) return '';
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
  if (d < 48) return max >= 128 ? '\u26aa' : '\u26ab';
  const h = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  if (h < 15 || h >= 330) return '\ud83d\udd34';
  if (h < 40) return '\ud83d\udfe0';
  if (h < 70) return '\ud83d\udfe1';
  if (h < 170) return '\ud83d\udfe2';
  if (h < 260) return '\ud83d\udd35';
  return '\ud83d\udfe3';
}

// One embed (or Slack attachment) as lines of Markdown: author, coloured title, link, description, fields, footer.
// Pictures (image, thumbnail, icons) are left out: showing them would make every reader's app fetch them.
function embedText(e, path, tally, md = fromDiscordMd) {
  if (!isObj(e)) invalid(path, 'MODEL_TYPE_CONVERT', 'Only dictionaries may be used in a ModelType');
  const title = str(e.title, `${path}.title`, L.title);
  const description = str(e.description, `${path}.description`, L.description);
  const author = isObj(e.author) ? str(e.author.name, `${path}.author.name`, L.author) : '';
  const footer = isObj(e.footer) ? str(e.footer.text, `${path}.footer.text`, L.footer) : '';
  const fields = listOf(e.fields, `${path}.fields`, L.fields).map((f, i) => {
    if (!isObj(f)) invalid(`${path}.fields.${i}`, 'MODEL_TYPE_CONVERT', 'Only dictionaries may be used in a ModelType');
    return { name: str(f.name, `${path}.fields.${i}.name`, L.fieldName), value: str(f.value, `${path}.fields.${i}.value`, L.fieldValue) };
  });
  tally(title.length + description.length + author.length + footer.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0));
  const lines = [];
  if (author.trim()) lines.push(oneLine(md(author)));
  if (title.trim()) lines.push(`**${oneLine(md(title))}**`);
  const url = link(e.url);
  if (url) lines.push(url);
  if (description.trim()) lines.push(md(description).trim());
  for (const f of fields) {
    const n = oneLine(md(f.name)); const v = md(f.value).trim();
    if (n) lines.push(`**${n}**`);
    if (v) lines.push(v);
  }
  const foot = [oneLine(md(footer)), stamp(e.timestamp)].filter(Boolean).join(' \u00b7 ');
  if (foot) lines.push(foot);
  const d = dot(colorNum(e.color));
  if (d && lines.length) lines[0] = `${d} ${lines[0]}`;
  return lines.join('\n');
}

function fromDiscord(b) {
  const content = str(b.content, 'content', L.content);
  const username = str(b.username, 'username', L.username);
  const embeds = listOf(b.embeds, 'embeds', L.embeds);
  let total = 0;
  const parts = embeds.map((e, i) => embedText(e, `embeds.${i}`, (n) => { total += n; }));
  if (total > L.embedTotal) invalid('embeds', 'MAX_EMBED_SIZE_EXCEEDED', `Embed size exceeds maximum size of ${L.embedTotal}`);
  return { text: [fromDiscordMd(content).trim(), ...parts].filter(Boolean).join('\n\n'), username, avatar: b.avatar_url, allowed: b.allowed_mentions };
}

// Slack's rich text (what its own composer and Block Kit Builder make): sections, lists, code blocks and quotes,
// with bold, italic, strike, code, links, emoji, dates and @mentions inside. Mentions come out as plain @words,
// so the ping rules below treat them like any other.
const RICH = 100; // elements per level
function styled(t, st) {
  let core = t.trim();
  if (!core || !isObj(st)) return t;
  if (st.code) core = `\`${core}\``;
  if (st.bold) core = `**${core}**`;
  if (st.italic) core = `*${core}*`;
  if (st.strike) core = `~~${core}~~`;
  // Spaces stay outside the markers, or the Markdown wouldn't see them as markers.
  return t.slice(0, t.length - t.trimStart().length) + core + t.slice(t.trimEnd().length);
}
function emojiOf(e) {
  const u = typeof e.unicode === 'string' && /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6}){0,9}$/i.test(e.unicode) ? e.unicode.split('-').map((h) => parseInt(h, 16)) : null;
  if (u && u.every((n) => n <= 0x10ffff && (n < 0xd800 || n > 0xdfff))) return String.fromCodePoint(...u);
  return typeof e.name === 'string' && /^[\w+-]{1,64}$/.test(e.name) ? `:${e.name}:` : '';
}
function richInline(els, path) {
  return listOf(els, path, RICH).map((e, i) => {
    if (!isObj(e)) return '';
    const p = `${path}.${i}`;
    const txt = () => clean(str(e.text, `${p}.text`, L.blockText));
    const id = (v) => String(v || '').replace(/[^\w.-]/g, '').slice(0, 40);
    switch (e.type) {
      case 'text': return styled(txt(), e.style);
      case 'link': {
        const url = link(e.url); const label = oneLine(txt());
        if (!url) return styled(label, e.style);
        return label && label !== url ? `${styled(label, e.style)} (${url})` : url;
      }
      case 'emoji': return emojiOf(e);
      case 'user': return id(e.user_id) ? `@${id(e.user_id)}` : '';
      case 'usergroup': return '@group';
      case 'channel': return id(e.channel_id) ? `#${id(e.channel_id)}` : '';
      case 'broadcast': return ['here', 'channel', 'everyone'].includes(e.range) ? `@${e.range}` : '';
      case 'date': return when(Number(e.timestamp) * 1000) || oneLine(clean(str(e.fallback, `${p}.fallback`, L.blockText)));
      case 'color': return typeof e.value === 'string' && /^#?[0-9a-f]{3,8}$/i.test(e.value) ? e.value : '';
      default: return '';
    }
  }).join('');
}
function richText(blk, path) {
  return listOf(blk.elements, `${path}.elements`, RICH).map((el, i) => {
    if (!isObj(el)) return '';
    const p = `${path}.elements.${i}`;
    const inner = () => richInline(el.elements, `${p}.elements`);
    switch (el.type) {
      case 'rich_text_section': return inner().trim();
      case 'rich_text_preformatted': { const code = inner().replace(/`{3,}/g, '``'); return code.trim() ? `\`\`\`\n${code}\n\`\`\`` : ''; }
      case 'rich_text_quote': return inner().trim().split('\n').map((l) => `> ${l}`).join('\n');
      case 'rich_text_list': {
        const pad = '  '.repeat(Math.max(0, Math.min(6, Number(el.indent) || 0)));
        const start = Math.max(1, Math.min(9999, Number(el.offset) + 1 || 1));
        return listOf(el.elements, `${p}.elements`, RICH).map((item, j) => {
          const t = isObj(item) ? oneLine(richInline(item.elements, `${p}.elements.${j}.elements`)) : '';
          return t ? `${pad}${el.style === 'ordered' ? `${start + j}.` : '-'} ${t}` : '';
        }).filter(Boolean).join('\n');
      }
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

// Slack Block Kit: headers, sections (and their fields), context lines and rich text; the rest (buttons, images,
// dividers) is skipped.
function blockText(blk, path, tally) {
  if (!isObj(blk)) return '';
  const t = (o, p) => (isObj(o) ? str(o.text, p, L.blockText) : '');
  let out = '';
  if (blk.type === 'rich_text') {
    out = richText(blk, path);
  } else if (blk.type === 'header') {
    const head = oneLine(t(blk.text, `${path}.text`));
    out = head ? `**${head}**` : '';
  } else if (blk.type === 'section') {
    out = [t(blk.text, `${path}.text`), ...listOf(blk.fields, `${path}.fields`, 10).map((f, i) => t(f, `${path}.fields.${i}.text`))]
      .map((s) => fromSlackMd(s).trim()).filter(Boolean).join('\n');
  } else if (blk.type === 'context') {
    out = listOf(blk.elements, `${path}.elements`, 10).map((e, i) => (isObj(e) && e.type !== 'image' ? oneLine(fromSlackMd(t(e, `${path}.elements.${i}.text`))) : ''))
      .filter(Boolean).join(' \u00b7 ');
  }
  tally(out.length);
  return out;
}
function fromSlack(b) {
  const username = str(b.username, 'username', L.username);
  const blocks = listOf(b.blocks, 'blocks', L.blocks);
  const atts = listOf(b.attachments, 'attachments', L.attachments);
  let total = 0;
  const tally = (n) => { total += n; };
  const parts = blocks.map((blk, i) => blockText(blk, `blocks.${i}`, tally)).filter(Boolean);
  // With blocks, Slack shows them instead of "text" (which is then only the notification's fallback). When none of
  // them is a kind shown here (images, buttons…), the text is what's left to show.
  const text = parts.length ? '' : str(b.text, 'text', L.text);
  atts.forEach((a, i) => {
    const path = `attachments.${i}`;
    if (!isObj(a)) invalid(path, 'MODEL_TYPE_CONVERT', 'Only dictionaries may be used in a ModelType');
    const pre = str(a.pretext, `${path}.pretext`, L.description);
    const fields = listOf(a.fields, `${path}.fields`, L.fields).map((f) => (isObj(f) ? { name: f.title, value: f.value } : f));
    const bare = !a.title && !a.text && !fields.length && !pre;
    const ts = Number(a.ts);
    const emb = { title: a.title, url: a.title_link, description: bare ? a.fallback : a.text, author: { name: a.author_name }, footer: { text: a.footer }, color: a.color, fields,
      timestamp: Number.isFinite(ts) && ts > 0 ? ts * 1000 : undefined };
    parts.push([pre && fromSlackMd(pre).trim(), embedText(emb, path, tally, fromSlackMd)].filter(Boolean).join('\n'));
  });
  if (total > L.embedTotal) invalid('attachments', 'MAX_EMBED_SIZE_EXCEEDED', `Attachment size exceeds maximum size of ${L.embedTotal}`);
  return { text: [fromSlackMd(text).trim(), ...parts].filter(Boolean).join('\n\n'), username, avatar: b.icon_url, allowed: null };
}

// GitHub's webhook events, the way Discord's …/github address shows them. Events it doesn't show answer 204.
const short = (s, n) => { const t = oneLine(s || ''); return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t; };
function fromGithub(event, b) {
  if (!isObj(b)) return null;
  const repo = short(isObj(b.repository) ? b.repository.full_name : '', 100);
  const who = short(isObj(b.sender) ? b.sender.login : '', 40);
  const by = who ? ` (by ${who})` : '';
  const head = (s) => `**[${repo}] ${s}**`;
  const item = (x) => (isObj(x) ? `#${Number(x.number) || 0} ${short(x.title, 200)}` : '');
  const body = (x) => (isObj(x) && x.body ? short(x.body, 300) : '');
  const out = (lines) => ({ text: lines.filter(Boolean).join('\n'), username: '', avatar: isObj(b.sender) ? b.sender.avatar_url : null, allowed: null });
  const a = String(b.action || '');
  switch (event) {
    case 'push': {
      const ref = String(b.ref || '');
      const branch = short(ref.replace(/^refs\/(heads|tags)\//, ''), 100);
      const commits = Array.isArray(b.commits) ? b.commits.filter(isObj) : [];
      if (b.deleted) return out([head(`${ref.startsWith('refs/tags/') ? 'Tag' : 'Branch'} deleted: ${branch}`) + by]);
      if (!commits.length) return b.created ? out([head(`New ${ref.startsWith('refs/tags/') ? 'tag' : 'branch'} created: ${branch}`) + by]) : null;
      return out([`**[${repo}:${branch}] ${commits.length} new commit${commits.length === 1 ? '' : 's'}**${by}`, link(b.compare),
        ...commits.slice(0, 5).map((c) => `\`${String(c.id || '').slice(0, 7)}\` ${short(String(c.message || '').split('\n')[0], 100)}${isObj(c.author) && c.author.name ? ` \u2014 ${short(c.author.name, 40)}` : ''}`),
        commits.length > 5 ? `\u2026and ${commits.length - 5} more` : '']);
    }
    case 'pull_request': {
      const pr = b.pull_request;
      const did = a === 'closed' && isObj(pr) && pr.merged ? 'merged' : a;
      if (!['opened', 'closed', 'reopened', 'merged', 'ready_for_review'].includes(did)) return null;
      return out([head(`Pull request ${did.replace(/_/g, ' ')}: ${item(pr)}`) + by, isObj(pr) ? link(pr.html_url) : '', a === 'opened' ? body(pr) : '']);
    }
    case 'issues': {
      if (!['opened', 'closed', 'reopened'].includes(a)) return null;
      return out([head(`Issue ${a}: ${item(b.issue)}`) + by, isObj(b.issue) ? link(b.issue.html_url) : '', a === 'opened' ? body(b.issue) : '']);
    }
    case 'issue_comment':
      if (a !== 'created') return null;
      return out([head(`New comment on ${isObj(b.issue) && b.issue.pull_request ? 'pull request' : 'issue'} ${item(b.issue)}`) + by, isObj(b.comment) ? link(b.comment.html_url) : '', body(b.comment)]);
    case 'release':
      if (a !== 'published') return null;
      return out([head(`New release published: ${short(isObj(b.release) ? b.release.name || b.release.tag_name : '', 100)}`) + by, isObj(b.release) ? link(b.release.html_url) : '']);
    case 'star': case 'watch':
      return a === 'created' || a === 'started' ? out([head('New star added') + by]) : null;
    case 'fork':
      return out([head(`Fork created: ${short(isObj(b.forkee) ? b.forkee.full_name : '', 100)}`) + by]);
    default:
      return null; // ping and everything else
  }
}

// The body, read by the route itself (index.js leaves /api/webhooks/ alone): JSON, a Slack form, or plain text.
function payloadOf(req, kind) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8').replace(/^\ufeff/, '') : '';
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let b;
  if (type === 'application/json' || type.endsWith('+json') || (!type && /^\s*[{[]/.test(raw))) {
    if (!raw.trim()) throw emptyMessage();
    try { b = JSON.parse(raw); } catch { throw badJson(); }
  } else if (type === 'application/x-www-form-urlencoded') {
    // Slack's payload=…, Discord's payload_json=…, or plain fields. (curl -d sends JSON with this type too.)
    const f = new URLSearchParams(raw);
    const inner = f.get('payload_json') ?? f.get('payload');
    const fields = ['content', 'username', 'text'].filter((k) => f.has(k));
    if (inner !== null) { try { b = JSON.parse(inner); } catch { throw badJson(); } } else if (!fields.length && /^\s*\{/.test(raw)) { try { b = JSON.parse(raw); } catch { throw badJson(); } } else b = Object.fromEntries(fields.map((k) => [k, f.get(k)]));
  } else if (type === 'text/plain' || !type) {
    if (kind === 'github') throw badJson('Send GitHub events as JSON (Content type: application/json).');
    if (raw.length > L.text) invalid('content', 'BASE_TYPE_MAX_LENGTH', `Must be ${L.text} or fewer in length.`);
    return { text: clean(raw).trim(), username: '', avatar: null, allowed: null };
  } else {
    throw badJson('Send JSON (application/json), a Slack-style form or plain text. Files aren’t supported.');
  }
  if (kind === 'github') return fromGithub(String(req.headers['x-github-event'] || ''), b);
  if (!isObj(b)) invalid('', 'DICT_TYPE_CONVERT', 'Only dictionaries may be used in a DictType');
  const discord = b.content != null || b.embeds != null;
  return kind === 'slack' || (!discord && (b.text != null || b.attachments != null || b.blocks != null)) ? fromSlack(b) : fromDiscord(b);
}

// Which pings this post may make: none unless the webhook may ping, and then what the payload's allowed_mentions
// lists (Discord's rule: without it, everything).
function allowedPings(w, am) {
  if (!w.allow_mentions) return { everyone: false, roles: false, users: false };
  if (!isObj(am)) return { everyone: true, roles: true, users: true };
  const parse = Array.isArray(am.parse) ? am.parse.map(String) : [];
  const listed = (k) => Array.isArray(am[k]) && am[k].length > 0;
  return { everyone: parse.includes('everyone'), roles: parse.includes('roles') || listed('roles'), users: parse.includes('users') || listed('users') };
}
// The app reads a mention as an @ at the start or after a space (and <@&role>), so an invisible space after that
// @ defuses it. Role mentions become the role's plain name, without the characters a mention is made of (a role
// can be named "<@&…>", which would otherwise put a live mention back).
function defuse(text, allow, roleName) {
  let s = text;
  if (!allow.roles) s = s.replace(/<@&([a-z0-9]{6,40})>/g, (m, id) => `@${ZW}${String(roleName(id)).replace(/[<>@&]/g, '')}`);
  if (!allow.everyone) s = s.replace(/(^|\s)@(?=(?:everyone|here|channel)\b)/gi, `$1@${ZW}`);
  if (!allow.users) s = s.replace(/(^|\s)@(?!(?:everyone|here|channel)\b)(?=[\w.])/gi, `$1@${ZW}`);
  return s;
}

module.exports = function setupWebhooks(ctx) {
  const { api, express, db, fail, HttpError, rateLimit, limitNet, newId, auth, auditLog, serverAudit, chanRef, checkWords, perms, PM, getUserRow, publicUser, requireChannel, toChannel,
    getIo, maintenance, ipBanned, bannedMsg, stillSuspended, botPost, notifyChannelMessage } = ctx;
  const now = () => Date.now();
  const io = () => getIo() || { to: () => ({ emit() {} }) };
  const live = 'SELECT * FROM channel_webhooks WHERE id = ? AND deleted_at IS NULL';

  // ------------------------------------------------------------------ rows and checks
  // Constant-time, and the same work whether the id exists or not, so a guesser can't tell which half was wrong.
  function hookFor(id, token) {
    const sid = String(id || ''); const tok = String(token || '');
    const w = ID_RE.test(sid) ? db.prepare(live).get(sid) : null;
    const same = crypto.timingSafeEqual(Buffer.from(w ? w.token_hash : DUMMY_HASH, 'hex'), Buffer.from(sha256(`${sid}.${tok}`), 'hex'));
    return w && same && TOKEN_RE.test(tok) ? w : null;
  }
  const newToken = (id) => { const token = crypto.randomBytes(32).toString('base64url'); return { token, hash: sha256(`${id}.${token}`), path: `/api/webhooks/${id}/${token}` }; };
  const MC = PM.MANAGE_CHANNELS; const MS = PM.MANAGE_SERVER; const ME = PM.MENTION_EVERYONE;
  const mayManage = (base, chan) => (base & MS) === MS || ((base & MC) === MC && (chan & MC) === MC);
  // Who can let a webhook ping: someone who may mention @everyone there themselves (server-wide and in the channel,
  // the same check people's own pings get).
  const canPing = (s, c, uid) => (perms.base(s, uid) & ME) === ME && (perms.channel(s, c, uid) & ME) === ME;
  const isMember = (serverId, uid) => !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, uid);
  // A text channel of a server (not a group chat) that this person can see and manage the webhooks of.
  function manageable(channelId, uid) {
    const c = requireChannel(String(channelId), uid);
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
    if (s.kind === 'group') fail(400, 'Webhooks can’t be added to group chats.');
    if (c.type !== 'text') fail(400, 'Webhooks post in text channels.');
    if (!mayManage(perms.base(s, uid), perms.channel(s, c, uid))) fail(403, 'You need Manage Channels in this channel (or Manage Server) to manage its webhooks.');
    return { c, s };
  }
  // Making a webhook, renaming it or giving it a new address is posting in this channel through it, so it needs what
  // posting needs: Send Messages there, which a timeout takes away. Otherwise Manage Channels would get around a
  // read-only channel or a timeout.
  const canPost = (s, c, uid) => !perms.timedOut(s.id, uid) && (perms.channel(s, c, uid) & PM.SEND_MESSAGES) !== 0;
  function mayPost(s, c, uid) {
    if (perms.timedOut(s.id, uid)) fail(403, 'You’re timed out in this server, so you can’t set up webhooks until it ends.');
    if (!canPost(s, c, uid)) fail(403, 'You need to be able to send messages in this channel to set up its webhooks.');
  }
  // A webhook belongs to whoever made its current address (they hold it). Anyone else changes it only from above
  // that person's highest role, as with everything else, unless they've left the server. Roles members pick
  // themselves don't count on either side (perms.topAssigned): they can sit above Manage Channels moderators, so a
  // holder could otherwise pick one to put their webhook out of a moderator's reach, or a moderator pick one to get
  // above a holder they're below.
  const holderOk = (s, w, uid) => !w.created_by || w.created_by === uid || !isMember(s.id, w.created_by) || perms.topAssigned(s, uid) > perms.topAssigned(s, w.created_by);
  function mayChange(s, w, uid) {
    if (!holderOk(s, w, uid)) fail(403, 'Its address was made by someone at or above your highest role, so only they (or someone above them) can change it.');
  }
  const hookIn = (c, id) => {
    const w = db.prepare('SELECT * FROM channel_webhooks WHERE id = ? AND channel_id = ? AND deleted_at IS NULL').get(String(id), c.id);
    if (!w) fail(404, 'No such webhook.');
    return w;
  };
  // Why a webhook can't post right now (null: it can). The person who made its address still knows it, so it stops
  // while they're suspended, banned from the server or timed out there; and while its own account is suspended (what
  // an instance admin does to an account whose posts were reported).
  function pausedWhy(w) {
    const acct = getUserRow(w.bot_user_id);
    if (acct && stillSuspended(acct)) return 'Its account is suspended.';
    const by = w.created_by && getUserRow(w.created_by);
    if (!by) return null;
    if (stillSuspended(by)) return 'The account that made its address is suspended.';
    if (db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(w.server_id, by.id)) return 'The person who made its address is banned from this server.';
    if (perms.timedOut(w.server_id, by.id)) return 'The person who made its address is timed out.';
    return null;
  }
  // May this webhook post? Its account must still be there, and it mustn't be paused.
  function usable(w) {
    const acct = getUserRow(w.bot_user_id);
    if (!acct || acct.deleted_at) throw unknownHook();
    const why = pausedWhy(w);
    if (why) throw new HookError(403, { message: `This webhook is paused. ${why}`, code: 50001 });
    return w;
  }
  // makerHere: a webhook keeps working when the person who made it leaves (as on Discord), so the list says so.
  // canChange: whether this person may rename, re-key or delete it (role order).
  const hookOut = (w, s, uid) => ({
    id: w.id, channelId: w.channel_id, serverId: w.server_id, name: w.name, userId: w.bot_user_id, allowMentions: !!w.allow_mentions,
    createdBy: w.created_by || null, createdByName: ((w.created_by && getUserRow(w.created_by)) || {}).username || null,
    makerHere: !!w.created_by && isMember(w.server_id, w.created_by), paused: pausedWhy(w), canChange: holderOk(s, w, uid),
    createdAt: w.created_at, rotatedAt: w.rotated_at || null, lastUsedAt: w.last_used_at || null,
  });
  const nameFrom = (v) => {
    const n = cleanName(v);
    if (!n) fail(400, 'Give the webhook a name (up to 32 characters).');
    checkWords(n);
    return n;
  };
  // Its account's username: the name made safe, with "_hook" on the end, numbered if taken.
  function freeUsername(name) {
    const base = `${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9_.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 12) || 'webhook'}_hook`;
    let u = base;
    for (let i = 2; db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(u); i++) u = `${base}${i}`;
    return u;
  }
  // Open settings panels refresh themselves: told to the people who can see this channel and manage its webhooks
  // (Manage Server alone doesn't reveal a private channel).
  function changed(s, c) {
    const ids = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(s.id).map((r) => r.user_id);
    const ev = perms.forServer(s, ids);
    const rooms = ids.filter((u) => { const ch = ev.channel(c, u); return (ch & PM.VIEW_CHANNEL) !== 0 && mayManage(ev.base(u), ch); }).map((u) => `user:${u}`);
    if (rooms.length) io().to(rooms).emit('webhooks:update', { channelId: c.id, serverId: s.id });
  }
  const roleName = (serverId, id) => {
    const r = db.prepare('SELECT name FROM roles WHERE id = ? AND server_id = ?').get(id, serverId);
    return r ? r.name : 'deleted-role';
  };
  // Who a post that may ping pings, worked out like a member's app does (mentionedIds in app.js).
  function recipients(s, text, allow) {
    const names = allow.users ? [...new Set([...text.matchAll(/(?:^|\s)@([\w.]{2,24})/g)].map((m) => m[1].toLowerCase()))].slice(0, 50) : [];
    const roles = allow.roles ? [...new Set([...text.matchAll(/<@&([a-z0-9]{6,40})>/g)].map((m) => m[1]))].slice(0, 20) : [];
    const ids = new Set();
    if (names.length) {
      db.prepare(`SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? AND lower(u.username) IN (SELECT value FROM json_each(?))`)
        .all(s.id, JSON.stringify(names)).forEach((r) => ids.add(r.user_id));
    }
    if (roles.length) {
      db.prepare(`SELECT DISTINCT mr.user_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
          WHERE mr.server_id = ? AND mr.role_id IN (SELECT value FROM json_each(?))`).all(s.id, JSON.stringify(roles)).forEach((r) => ids.add(r.user_id));
    }
    return { ids: [...ids], everyone: allow.everyone && /(^|\s)@(everyone|channel|here)\b/i.test(text) };
  }

  // ------------------------------------------------------------------ the public addresses: /api/webhooks/:id/:token
  const hooks = express.Router();
  // Checked before the body is read: who's asking, whether the address is right, and the limits.
  function gate(req, res, next) {
    try {
      if (ipBanned(req.ip)) throw new HookError(403, { message: bannedMsg, code: 0 });
      if (maintenance()) throw new HookError(503, { message: 'This Hearth is under maintenance. Try again later.', code: 0 });
      // Per network (limitNet: an IPv4 address, or an IPv6 /64, so rotating addresses inside one changes nothing).
      limitNet(req, 'hookip', 300, 60000);
      const w = hookFor(req.params.id, req.params.token);
      if (!w) {
        limitNet(req, 'hookbad', 30, 60000);
        throw unknownHook();
      }
      usable(w);
      if (req.method === 'POST') {
        // Discord's own limits are about these: 5 per 2 seconds per webhook, 30 a minute per channel.
        rateLimit('hook:' + w.id, 5, 2000);
        rateLimit('hookch:' + w.channel_id, 30, 60000);
        rateLimit('hookh:' + w.id, 1000, 3600000);
      }
      req.hook = w;
      next();
    } catch (e) { next(e); }
  }
  // The body has BODY_MS to arrive. (receive() checks the webhook again anyway: this keeps a leaked address from
  // holding many requests open for minutes.)
  function deadline(req, res, next) {
    const t = setTimeout(() => {
      if (res.headersSent) { req.destroy(); return; }
      res.on('finish', () => req.destroy());
      res.set('Connection', 'close').status(408).json({ message: 'The request body took too long to arrive.', code: 0 });
    }, BODY_MS);
    res.on('close', () => clearTimeout(t));
    next();
  }
  const body = (limit) => [deadline, express.raw({ type: () => true, limit })];

  function receive(req, res, kind) {
    // The webhook as it is now, not as it was when the request started: a new address, a deletion, a pause or pings
    // turned off while the body was on its way all count.
    const w = db.prepare(live).get(req.hook.id);
    if (!w || w.token_hash !== req.hook.token_hash) throw unknownHook();
    usable(w);
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(w.channel_id);
    if (!c || c.type !== 'text') throw unknownHook();
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
    const p = payloadOf(req, kind);
    if (!p) return res.status(204).end(); // a GitHub event that isn't shown (ping, labels, ...)
    let text = p.text.trim();
    if (!text) throw emptyMessage();
    if (text.length > MAX_TEXT) text = `${Array.from(text.slice(0, MAX_TEXT)).slice(0, -1).join('')}…`;
    const name = p.username ? cleanName(p.username) : '';
    try { checkWords(text, name); } catch (e) {
      if (e instanceof HttpError) throw new HookError(400, { message: 'Message was blocked by this server’s word filter.', code: 200000 });
      throw e;
    }
    const allow = allowedPings(w, p.allowed);
    text = defuse(text, allow, (id) => roleName(s.id, id));
    const pings = allow.everyone || allow.roles || allow.users;
    const row = botPost(w.bot_user_id, c, text, { extra: { webhook: { id: w.id, name: name || null, avatar: avatarOf(p.avatar), pings } } });
    // Pushes like anyone's post: mentions only from a webhook that may ping, and "All messages" either way (an alert
    // on a phone is most of the point of piping Uptime Kuma into a channel).
    const r = pings ? recipients(s, text, allow) : { ids: [], everyone: false };
    notifyChannelMessage(c, row.id, w.bot_user_id, null, null, r.ids, r.everyone, { mayEveryone: allow.everyone });
    if (!w.last_used_at || now() - w.last_used_at > 60000) db.prepare('UPDATE channel_webhooks SET last_used_at = ? WHERE id = ?').run(now(), w.id);
    // ?wait=true: the message back, as Discord gives it (enough of it for the programs that read the id).
    if (/^(true|1)$/i.test(String(req.query.wait || ''))) {
      return res.json({ id: row.id, type: 0, content: text, channel_id: c.id, guild_id: c.server_id, webhook_id: w.id, author: { id: w.id, username: name || w.name, bot: true },
        embeds: [], attachments: [], mentions: [], mention_roles: [], mention_everyone: false, pinned: false, tts: false, flags: 0, timestamp: new Date(row.created_at).toISOString(), edited_timestamp: null });
    }
    res.status(204).end();
  }

  // GET answers what Discord's does (some programs check the address with it), minus the secret.
  hooks.get('/:id/:token', gate, (req, res) => {
    const w = req.hook;
    res.json({ type: 1, id: w.id, name: w.name, avatar: null, channel_id: w.channel_id, guild_id: w.server_id, application_id: null });
  });
  hooks.post('/:id/:token', gate, body('64kb'), (req, res) => receive(req, res, 'auto'));
  hooks.post('/:id/:token/slack', gate, body('64kb'), (req, res) => receive(req, res, 'slack'));
  hooks.post('/:id/:token/github', gate, body('1mb'), (req, res) => receive(req, res, 'github'));
  hooks.use((req, res) => res.status(404).json({ message: '404: Not Found', code: 0 }));
  hooks.use((err, req, res, next) => {
    if (res.headersSent) return; // the body deadline already answered (408) and the read then failed
    if (err instanceof HookError) {
      if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      return res.status(err.status).json(err.body);
    }
    if (err && err.type === 'entity.too.large') return res.status(413).json({ message: 'Request entity too large', code: 40005 });
    if (err && typeof err.type === 'string') return res.status(400).json({ message: 'The request body couldn’t be read.', code: 50109 });
    if (err instanceof HttpError && err.status === 429) {
      const wait = err.retryAfter || 1;
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ message: 'You are being rate limited.', retry_after: wait, global: false });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, code: 0 });
    next(err);
  });
  api.use('/webhooks', hooks);

  // ------------------------------------------------------------------ managing them (people with Manage Channels)
  const limitUi = (req, res, next) => { try { rateLimit('hookui:' + req.userId, 60, 60000); next(); } catch (e) { next(e); } };
  const listOut = (c, s, uid) => db.prepare('SELECT * FROM channel_webhooks WHERE channel_id = ? AND deleted_at IS NULL ORDER BY created_at').all(c.id).map((w) => hookOut(w, s, uid));
  const fresh = (id) => db.prepare(live).get(id);

  api.get('/channels/:id/webhooks', auth, limitUi, (req, res) => {
    const { c, s } = manageable(req.params.id, req.userId);
    res.json({ webhooks: listOut(c, s, req.userId), canPing: canPing(s, c, req.userId), canPost: canPost(s, c, req.userId), max: PER_CHANNEL });
  });
  // The address (with its secret) is in this answer only: just a hash of the secret is kept.
  api.post('/channels/:id/webhooks', auth, limitUi, (req, res) => {
    const { c, s } = manageable(req.params.id, req.userId);
    mayPost(s, c, req.userId);
    // Each webhook is an account, so making them is limited per person by the hour and by the day.
    rateLimit('hookmake:' + req.userId, 20, 3600000);
    rateLimit('hookmaked:' + req.userId, 60, 86400000);
    const b = req.body || {};
    const name = nameFrom(b.name);
    const pings = b.allowMentions === true;
    if (pings && !canPing(s, c, req.userId)) fail(403, 'Only people who can mention @everyone in this channel can let a webhook ping.');
    if (db.prepare('SELECT COUNT(*) n FROM channel_webhooks WHERE channel_id = ? AND deleted_at IS NULL').get(c.id).n >= PER_CHANNEL) fail(400, `A channel can have up to ${PER_CHANNEL} webhooks.`);
    if (db.prepare('SELECT COUNT(*) n FROM channel_webhooks WHERE server_id = ? AND deleted_at IS NULL').get(s.id).n >= PER_SERVER) fail(400, `A server can have up to ${PER_SERVER} webhooks.`);
    const id = newId(); const userId = newId();
    const t = newToken(id);
    db.transaction(() => {
      db.prepare(`INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, profile, created_at, is_bot) VALUES (?, ?, ?, '', '', ?, ?, 1)`)
        .run(userId, freeUsername(name), `!${crypto.randomBytes(16).toString('hex')}`, JSON.stringify({ displayName: name, bio: 'A webhook: it posts what a program outside Hearth sends.' }), now());
      db.prepare('INSERT INTO channel_webhooks (id, channel_id, server_id, bot_user_id, name, token_hash, allow_mentions, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, c.id, s.id, userId, name, t.hash, pings ? 1 : 0, req.userId, now());
    })();
    auditLog(req, 'webhook_created', s.id, `${name} (${id}) in #${c.name}${pings ? '; may ping' : ''}`);
    serverAudit(s, req.userId, 'webhook_create', id, { name, channel: chanRef(s, c), pings: pings || undefined }, c.id);
    changed(s, c);
    res.json({ webhook: hookOut(fresh(id), s, req.userId), token: t.token, path: t.path });
  });
  // Rename, and let it ping or not. Taking pings away needs only the role order; giving them needs Mention Everyone.
  api.patch('/channels/:id/webhooks/:hookId', auth, limitUi, (req, res) => {
    const { c, s } = manageable(req.params.id, req.userId);
    const w = hookIn(c, req.params.hookId);
    mayChange(s, w, req.userId);
    const b = req.body || {};
    const changes = [];
    if (b.name !== undefined) {
      const name = nameFrom(b.name);
      if (name !== w.name) {
        mayPost(s, c, req.userId); // a new name changes what its posts, old ones too, say about who wrote them
        const u = getUserRow(w.bot_user_id);
        let p = {};
        try { p = JSON.parse((u && u.profile) || '{}'); } catch { /* */ }
        db.transaction(() => {
          db.prepare('UPDATE channel_webhooks SET name = ? WHERE id = ?').run(name, w.id);
          db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify({ ...p, displayName: name }), w.bot_user_id);
        })();
        changes.push(`renamed to ${name}`);
        toChannel(c).emit('user:update', publicUser(getUserRow(w.bot_user_id)));
      }
    }
    if (b.allowMentions !== undefined) {
      const on = b.allowMentions === true;
      if (on !== !!w.allow_mentions) {
        if (on && !canPing(s, c, req.userId)) fail(403, 'Only people who can mention @everyone in this channel can let a webhook ping.');
        db.prepare('UPDATE channel_webhooks SET allow_mentions = ? WHERE id = ?').run(on ? 1 : 0, w.id);
        changes.push(on ? 'may ping' : 'pings off');
      }
    }
    if (changes.length) {
      auditLog(req, 'webhook_changed', s.id, `${w.name} (${w.id}) in #${c.name}: ${changes.join(', ')}`);
      const now2 = fresh(w.id);
      serverAudit(s, req.userId, 'webhook_update', w.id, { name: now2.name, channel: chanRef(s, c),
        renamed: now2.name !== w.name ? { from: w.name, to: now2.name } : undefined, pings: !!now2.allow_mentions !== !!w.allow_mentions ? !!now2.allow_mentions : undefined }, c.id);
      changed(s, c);
    }
    res.json({ webhook: hookOut(fresh(w.id), s, req.userId) });
  });
  // A new secret (a leaked address): the old one stops working at once, requests already on their way included. The
  // person who asked for it now holds the only address, so the webhook is theirs from then on (whose suspension,
  // ban or timeout pauses it, and whose role order guards it). One that may ping can only be re-keyed by someone
  // who could let it ping, or else the new secret would hand them pings they don't have.
  api.post('/channels/:id/webhooks/:hookId/token', auth, limitUi, (req, res) => {
    const { c, s } = manageable(req.params.id, req.userId);
    const w = hookIn(c, req.params.hookId);
    mayChange(s, w, req.userId);
    mayPost(s, c, req.userId);
    rateLimit('hookrotate:' + req.userId, 20, 3600000);
    if (w.allow_mentions && !canPing(s, c, req.userId)) fail(403, 'This webhook may ping everyone, so only someone who can mention @everyone here can get a new address for it. Turn its pings off first.');
    const t = newToken(w.id);
    db.prepare('UPDATE channel_webhooks SET token_hash = ?, rotated_at = ?, created_by = ? WHERE id = ?').run(t.hash, now(), req.userId, w.id);
    const from = w.created_by && w.created_by !== req.userId ? `; the address was ${(getUserRow(w.created_by) || {}).username || w.created_by}’s` : '';
    auditLog(req, 'webhook_token_rotated', s.id, `${w.name} (${w.id}) in #${c.name}${from}`);
    serverAudit(s, req.userId, 'webhook_rotate', w.id, { name: w.name, channel: chanRef(s, c) }, c.id);
    changed(s, c);
    res.json({ webhook: hookOut(fresh(w.id), s, req.userId), token: t.token, path: t.path });
  });
  api.delete('/channels/:id/webhooks/:hookId', auth, limitUi, (req, res) => {
    const { c, s } = manageable(req.params.id, req.userId);
    const w = hookIn(c, req.params.hookId);
    mayChange(s, w, req.userId);
    // With posts still in the channel, the row stays as a tombstone and its account is marked deleted, so those
    // posts keep their author. Without any, the row goes and the trigger in db.js wipes the account.
    const posted = !!db.prepare('SELECT 1 FROM messages WHERE channel_id = ? AND author_id = ? LIMIT 1').get(c.id, w.bot_user_id);
    if (posted) {
      db.transaction(() => {
        db.prepare('UPDATE channel_webhooks SET deleted_at = ?, token_hash = ? WHERE id = ?').run(now(), sha256(crypto.randomBytes(32).toString('hex')), w.id);
        db.prepare('UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), w.bot_user_id);
      })();
      toChannel(c).emit('user:update', publicUser(getUserRow(w.bot_user_id)));
    } else db.prepare('DELETE FROM channel_webhooks WHERE id = ?').run(w.id);
    auditLog(req, 'webhook_deleted', s.id, `${w.name} (${w.id}) in #${c.name}`);
    serverAudit(s, req.userId, 'webhook_delete', w.id, { name: w.name, channel: chanRef(s, c) }, c.id);
    changed(s, c);
    res.json({ ok: true });
  });

  return { hookFor };
};
module.exports.parse = { fromDiscord, fromSlack, fromGithub, defuse, cleanName, dot };
