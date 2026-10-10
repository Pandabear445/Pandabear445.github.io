// Updates: things you track for yourself (a topic in the news, a YouTube channel, a subreddit, a game's patch
// notes, a GitHub project's releases, any RSS feed). The server checks them every half hour and keeps only what
// was published after you started tracking, so this page is always new stuff, never a pile of old news.
import { h, clear, icon, toast, copyText, fmtStamp } from './util.js';
import { api } from './api.js';
import { modal, field, menu, confirmDialog } from './ui.js';

const KIND_HELP = {
  topic: { label: 'A topic in the news', ph: 'e.g. "Elden Ring DLC" or "NASA Artemis"', hint: 'Searches news sites for this phrase.' },
  youtube: { label: 'A YouTube channel', ph: 'youtube.com/@channel or @handle', hint: 'New videos from this channel.' },
  reddit: { label: 'A subreddit', ph: 'e.g. gaming or r/buildapcsales', hint: 'New posts in this subreddit.' },
  steam: { label: 'A game on Steam', ph: 'Game name or Steam store link', hint: 'Patch notes and news from the developers.' },
  github: { label: 'A GitHub project', ph: 'owner/project or the GitHub link', hint: 'New releases.' },
  rss: { label: 'Any website with a feed (RSS)', ph: 'https://example.com/feed', hint: 'Blogs, news sites, podcasts…' },
};
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : fmtStamp(t); };

export function createUpdates(ctx) {
  // ctx: { S, mediaNewsUrl(u), onUnread(n) }
  let state = { trackers: [], items: [], unread: 0, filter: null, loaded: false };
  const setUnread = (n) => { state.unread = n; if (ctx.S.me) ctx.S.me.updatesUnread = n; ctx.onUnread(n); };

  async function load() {
    const r = await api('GET', `/me/trackers${state.filter ? `?feed=${encodeURIComponent(state.filter)}` : ''}`);
    state = { ...state, trackers: r.trackers, items: r.items, loaded: true, more: r.items.length >= 60 };
    setUnread(r.unread);
  }

  function view() {
    const wrap = h('div', { class: 'updates' });
    const draw = () => {
      clear(wrap);
      const head = h('div', { class: 'updates-head' },
        h('div', null, h('h2', null, 'Updates'), h('p', { class: 'muted-p' }, 'New things from what you track. Checked about every 30 minutes; only stuff published after you started tracking shows up.')),
        h('div', { class: 'row gap' },
          state.unread ? h('button', { class: 'btn ghost', onclick: async () => { const r = await api('POST', '/me/tracker-items/read', { all: true }); state.items.forEach((i) => { i.read = true; }); state.trackers.forEach((t) => { t.unread = 0; }); setUnread(r.unread); draw(); } }, icon('check'), 'Mark all read') : null,
          h('button', { class: 'btn primary', onclick: () => trackDialog(() => load().then(draw)) }, icon('plus'), 'Track something')));
      wrap.append(head);
      if (!state.loaded) { wrap.append(h('span', { class: 'spinner' })); return; }
      if (!state.trackers.length) {
        wrap.append(h('div', { class: 'empty-state' }, icon('rss'), h('h3', null, 'Track anything'),
          h('p', null, 'Follow a topic, a YouTube channel, a subreddit, a game’s patch notes or a GitHub project, and new posts show up here.'),
          h('div', { class: 'row gap wrap center' }, ...[['topic', 'A news topic'], ['youtube', 'A YouTube channel'], ['steam', 'Game patch notes'], ['reddit', 'A subreddit']].map(([k, l]) => h('button', { class: 'btn', onclick: () => trackDialog(() => load().then(draw), k) }, l)))));
        return;
      }
      // trackers as chips: click to filter, menu for settings
      wrap.append(h('div', { class: 'tracker-chips' },
        h('button', { class: `chip${!state.filter ? ' active' : ''}`, onclick: () => { state.filter = null; load().then(draw); } }, 'Everything', state.unread ? h('span', { class: 'badge inline' }, state.unread) : null),
        ...state.trackers.map((t) => h('span', { class: `chip tracker${state.filter === t.id ? ' active' : ''}${t.paused ? ' paused' : ''}` },
          h('button', { class: 'chip-main', onclick: () => { state.filter = state.filter === t.id ? null : t.id; load().then(draw); }, title: `${t.kindName}: ${t.query}` },
            t.paused ? icon('pause') : null, t.title, t.unread ? h('span', { class: 'badge inline' }, t.unread) : null),
          h('button', { class: 'chip-more', 'aria-label': `Options for ${t.title}`, 'data-pop-anchor': '', onclick: (e) => menu(e.currentTarget, trackerMenu(t, draw), { align: 'end' }) }, icon('more'))))));
      const failing = state.trackers.filter((t) => t.lastError);
      if (failing.length) wrap.append(h('p', { class: 'warn-box' }, `Couldn’t check ${failing.map((t) => t.title).join(', ')} last time: ${failing[0].lastError}. It’ll try again.`));
      if (!state.items.length) {
        wrap.append(h('div', { class: 'empty-state small' }, h('p', null, 'Nothing new yet. New posts appear here as soon as they’re published (checked about every 30 minutes).')));
        return;
      }
      const list = h('div', { class: 'update-list' });
      state.items.forEach((i) => list.append(card(i, draw)));
      wrap.append(list);
      if (state.more) {
        wrap.append(h('button', { class: 'btn ghost', onclick: async () => {
          const last = state.items[state.items.length - 1];
          const r = await api('GET', `/me/trackers?before=${last.foundAt}${state.filter ? `&feed=${encodeURIComponent(state.filter)}` : ''}`);
          state.items.push(...r.items); state.more = r.items.length >= 60; draw();
        } }, 'Older'));
      }
      // Seen = read (after a moment on screen).
      const unseen = state.items.filter((i) => !i.read).map((i) => i.id);
      if (unseen.length) setTimeout(async () => {
        if (!wrap.isConnected) return;
        const r = await api('POST', '/me/tracker-items/read', { ids: unseen }).catch(() => null);
        if (r) { setUnread(r.unread); state.trackers.forEach((t) => { t.unread = 0; }); }
      }, 1500);
    };
    draw();
    load().then(draw).catch((e) => { clear(wrap).append(h('p', { class: 'form-error' }, e.message)); });
    return wrap;
  }

  function card(i, redraw) {
    const t = state.trackers.find((x) => x.id === i.feedId);
    return h('article', { class: `update-card${i.read ? '' : ' unread'}` },
      i.image ? h('img', { class: 'update-img', src: ctx.mediaNewsUrl(i.image), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.currentTarget.remove() }) : null,
      h('div', { class: 'update-text' },
        h('div', { class: 'update-meta' }, t ? h('span', { class: 'update-tracker' }, t.title) : null, i.source && (!t || i.source !== t.title) ? h('span', null, i.source) : null, h('span', null, ago(i.date || i.foundAt))),
        h('a', { class: 'update-title', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, i.title),
        i.summary ? h('p', { class: 'update-summary' }, i.summary) : null,
        h('div', { class: 'row gap tight' },
          h('a', { class: 'btn ghost sm', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Open'),
          h('button', { class: 'btn ghost sm', onclick: () => { copyText(i.url); toast('Link copied. Paste it in any chat to share.'); } }, icon('link'), 'Copy link'))));
  }

  function trackerMenu(t, redraw) {
    const patch = async (b) => { try { const n = await api('PATCH', `/me/trackers/${t.id}`, b); Object.assign(t, n); redraw(); } catch (e) { toast(e.message, 'error'); } };
    return [
      { header: `${t.kindName}: ${t.query}` },
      { label: t.notify ? 'Turn notifications off' : 'Notify me about new posts', icon: t.notify ? 'bellOff' : 'bell', action: () => patch({ notify: !t.notify }) },
      { label: t.paused ? 'Resume' : 'Pause', icon: t.paused ? 'play' : 'pause', action: () => patch({ paused: !t.paused }) },
      { label: 'Only posts with these words…', icon: 'search', action: () => {
        const k = h('input', { class: 'input', value: t.keywords, placeholder: 'patch, update, release' });
        modal({ title: 'Keyword filter', size: 'sm', body: field('Keywords (comma-separated, empty = everything)', k), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => patch({ keywords: k.value }) }] });
      } },
      { label: 'Rename…', icon: 'edit', action: () => {
        const k = h('input', { class: 'input', value: t.title, maxlength: '100' });
        modal({ title: 'Rename', size: 'sm', body: field('Name', k), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => patch({ title: k.value }) }] });
      } },
      { label: 'Check now', icon: 'rss', action: async () => {
        try { const r = await api('POST', `/me/trackers/${t.id}/check`); toast(r.found ? `${r.found} new.` : 'Nothing new right now.'); await load(); redraw(); } catch (e) { toast(e.message, 'error'); }
      } },
      '-',
      { label: 'Stop tracking', icon: 'trash', danger: true, action: async () => {
        if (!(await confirmDialog({ title: `Stop tracking ${t.title}?`, text: 'Its posts on this page go too.', confirm: 'Stop tracking', danger: true }))) return;
        const r = await api('DELETE', `/me/trackers/${t.id}`); setUnread(r.unread);
        if (state.filter === t.id) state.filter = null;
        await load(); redraw();
      } },
    ];
  }

  function trackDialog(after, kind = 'topic') {
    const kindSel = h('select', { class: 'input' }, ...Object.entries(KIND_HELP).map(([k, v]) => h('option', { value: k }, v.label)));
    kindSel.value = kind;
    const q = h('input', { class: 'input', maxlength: '300' });
    const kw = h('input', { class: 'input', maxlength: '300', placeholder: 'Optional: patch, update, release' });
    const notify = h('input', { type: 'checkbox', checked: true });
    const prev = h('div', { class: 'stack' });
    const hint = h('span', { class: 'field-hint' });
    const sync = () => { const v = KIND_HELP[kindSel.value]; q.placeholder = v.ph; hint.textContent = v.hint; clear(prev); };
    kindSel.onchange = sync; sync();
    const preview = async () => {
      clear(prev).append(h('span', { class: 'spinner' }));
      try {
        const r = await api('POST', '/me/trackers/preview', { kind: kindSel.value, query: q.value });
        clear(prev).append(h('p', { class: 'field-hint' }, `Found “${r.title || q.value}”. Its latest posts (these count as already seen):`),
          ...r.items.map((i) => h('div', { class: 'feed-prev' }, i.image ? h('img', { src: ctx.mediaNewsUrl(i.image), alt: '', loading: 'lazy' }) : h('span', { class: 'feed-prev-ph' }, icon('rss')),
            h('span', null, h('strong', null, i.title), h('span', { class: 'field-hint' }, i.date ? ` · ${new Date(i.date).toLocaleDateString()}` : '')))));
      } catch (e) { clear(prev).append(h('p', { class: 'form-error' }, e.message)); }
    };
    modal({ title: 'Track something', size: 'md',
      body: h('div', { class: 'stack' }, field('What', kindSel), h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Which one'), h('div', { class: 'row gap' }, q, h('button', { class: 'btn', onclick: preview }, 'Preview')), hint),
        field('Only posts mentioning', kw), h('label', { class: 'row gap tight' }, notify, h('span', null, 'Notify me when something new comes out')), prev),
      actions: [{ label: 'Cancel' }, { label: 'Track it', kind: 'primary', action: async () => {
        if (!q.value.trim()) throw new Error('Type what to track.');
        const t = await api('POST', '/me/trackers', { kind: kindSel.value, query: q.value, keywords: kw.value, notify: notify.checked });
        toast(`Tracking ${t.title}. New posts will show up in Updates.`);
        after && after();
      } }] });
    setTimeout(() => q.focus(), 30);
  }

  // A new post arrived (from the server, while the app is open).
  function onNew(p) {
    setUnread(p.unread);
    if (p.notify) toast(`${p.count} new from ${p.title}: ${p.first.title}`);
  }

  return { view, onNew, trackDialog, reload: load };
}
