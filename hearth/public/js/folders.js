// Server folders in the left bar.
//
// Compared with the usual "drag one server onto another" folders:
//   - You never have to drag: right-click a server → Move to folder, or open Organize servers (a plain list with
//     a folder picker and up/down buttons per server). Dragging still works, with clear drop markers.
//   - Folders have a name, a colour and an emoji, show the name on hover, and when closed show a combined
//     unread dot and @mention count.
//   - Focus a folder ("School", "Gaming", "Work") and the bar shows only its servers until you switch back.
//   - Mark a whole folder as read, or mute it, in one click.
//   - The arrangement is saved to your account, so every device you sign in on shows the same folders.
import { h, clear, icon, toast } from './util.js';
import { api } from './api.js';
import { modal, field, contextMenu, menu, confirmDialog } from './ui.js';

const COLORS = ['#5865f2', '#3ba55d', '#f2a541', '#ed4245', '#eb459e', '#00b0f4', '#9b59b6', '#95a5a6'];
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function createFolders(ctx) {
  // ctx: { S, servers() → real servers (no group chats), favorites() → Set of favorite server ids, rerender(),
  //        openServer(id), serverUnread(s), serverMenuItems(s), setNotify(key, level), isMutedServer(s),
  //        markServerRead(s), railSide(), serverIcon(s) → element }
  const rail = () => {
    const r = ctx.S.me && ctx.S.me.rail;
    if (!r || !Array.isArray(r.folders)) ctx.S.me.rail = { folders: [], order: [], focus: null };
    return ctx.S.me.rail;
  };
  const folderById = (id) => rail().folders.find((f) => f.id === id);
  const folderOf = (sid) => rail().folders.find((f) => f.servers.includes(sid));

  // ------------------------------------------------------------------ saving (debounced; other devices follow)
  let timer = null;
  let lastLocal = 0;
  function save() {
    lastLocal = Date.now();
    normalize();
    ctx.rerender();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = rail();
      api('PUT', '/me/rail', { folders: r.folders, order: r.order, focus: r.focus }).catch((e) => toast(e.message, 'error'));
    }, 400);
  }
  // From another device (or the echo of our own save, which we skip while still editing here).
  function applyRemote(r) { if (ctx.S.me && r && Date.now() - lastLocal > 3000) { ctx.S.me.rail = r; ctx.rerender(); } }

  // Keeps the order list in step with what exists: every folder once, every server not in a folder once.
  function normalize() {
    const r = rail();
    const live = new Set(ctx.servers().map((s) => s.id));
    const inFolder = new Set(r.folders.flatMap((f) => f.servers));
    const seen = new Set();
    r.order = r.order.filter((k) => {
      if (seen.has(k)) return false; seen.add(k);
      if (k.startsWith('f:')) return !!folderById(k.slice(2));
      const sid = k.slice(2);
      return !inFolder.has(sid) && (live.has(sid) || !ctx.S.serversLoaded);
    });
    for (const f of r.folders) if (!seen.has('f:' + f.id)) r.order.push('f:' + f.id);
    for (const s of ctx.servers()) if (!inFolder.has(s.id) && !r.order.includes('s:' + s.id)) r.order.push('s:' + s.id);
    if (r.focus && !folderById(r.focus)) r.focus = null;
  }

  // ------------------------------------------------------------------ what the bar shows
  // Returns [{ type: 'server', server, folder? } | { type: 'folder', folder, servers }].
  function entries() {
    normalize();
    const r = rail();
    const byId = new Map(ctx.servers().map((s) => [s.id, s]));
    const favs = ctx.favorites();
    if (r.focus) {
      const f = folderById(r.focus);
      return f.servers.map((id) => byId.get(id)).filter(Boolean).map((server) => ({ type: 'server', server, folder: f }));
    }
    const out = [];
    for (const k of r.order) {
      if (k.startsWith('s:')) { const s = byId.get(k.slice(2)); if (s && !favs.has(s.id)) out.push({ type: 'server', server: s }); continue; }
      const f = folderById(k.slice(2));
      const servers = f.servers.map((id) => byId.get(id)).filter((s) => s && !favs.has(s.id));
      if (servers.length) out.push({ type: 'folder', folder: f, servers });
    }
    return out;
  }
  function folderUnread(servers) {
    let unread = false; let mentions = 0;
    for (const s of servers) { const u = ctx.serverUnread(s); unread = unread || u.unread; mentions += u.mentions; }
    return { unread, mentions };
  }

  // Draws the servers part of the bar into `railEl`, using the app's tile() for single servers.
  function render(railEl, tile) {
    const r = rail();
    if (r.focus) {
      const f = folderById(r.focus);
      railEl.append(h('div', { class: 'rail-item' }, h('button', {
        class: 'rail-btn rail-focus', style: { '--fc': f.color }, 'aria-label': `Showing only ${f.name}. Click to choose.`, 'data-tip': `Only ${f.name} — click to show everything`, 'data-tip-side': ctx.railSide(), 'data-pop-anchor': '',
        onclick: (e) => focusMenu(e.currentTarget),
      }, f.emoji ? h('span', { class: 'folder-emoji' }, f.emoji) : icon('compass'))));
    }
    for (const e of entries()) {
      if (e.type === 'server') { railEl.append(serverTile(e.server, tile)); continue; }
      const f = e.folder;
      const { unread, mentions } = folderUnread(e.servers);
      const head = h('button', {
        class: `rail-btn rail-folder${f.open ? ' open' : ''}`, style: { '--fc': f.color },
        'aria-label': `${f.name} folder, ${e.servers.length} servers${mentions ? `, ${mentions} mentions` : ''}. ${f.open ? 'Close' : 'Open'}.`, 'aria-expanded': String(!!f.open),
        'data-tip': f.name, 'data-tip-side': ctx.railSide(), draggable: 'true',
        onclick: () => { f.open = !f.open; save(); },
        oncontextmenu: (ev) => contextMenu(ev, folderMenuItems(f)),
      },
      f.open ? (f.emoji ? h('span', { class: 'folder-emoji' }, f.emoji) : icon('folder'))
        : h('span', { class: 'folder-mini' }, e.servers.slice(0, 4).map((s) => h('span', { class: 'folder-mini-icon' }, ctx.serverIcon(s)))),
      !f.open && mentions ? h('span', { class: 'badge', 'aria-hidden': 'true' }, mentions > 99 ? '99+' : mentions) : null);
      const item = h('div', { class: `rail-item folder-item${!f.open && unread && !f.muted ? ' unread' : ''}`, dataset: { key: 'f:' + f.id } }, h('span', { class: 'pill', 'aria-hidden': 'true' }), head);
      dnd(item, { kind: 'folder', id: f.id, canInto: true });
      if (!f.open) { railEl.append(item); continue; }
      railEl.append(h('div', { class: 'rail-folder-group', style: { '--fc': f.color } }, item, ...e.servers.map((s) => serverTile(s, tile, f))));
    }
  }
  function serverTile(s, tile, inFolder = null) {
    const el = tile(s);
    el.dataset.key = 's:' + s.id;
    const btn = el.querySelector('.rail-btn');
    if (btn) btn.setAttribute('draggable', 'true');
    dnd(el, { kind: 'server', id: s.id, folder: inFolder ? inFolder.id : null, canInto: true });
    return el;
  }

  // ------------------------------------------------------------------ drag and drop
  let dragging = null; // { kind, id }
  const vertical = () => document.documentElement.dataset.rail !== 'top';
  function zone(el, ev) {
    const b = el.getBoundingClientRect();
    const t = vertical() ? (ev.clientY - b.top) / b.height : (ev.clientX - b.left) / b.width;
    return t < 0.28 ? 'before' : t > 0.72 ? 'after' : 'into';
  }
  function clearMarks() { document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into')); }
  function dnd(el, target) {
    el.addEventListener('dragstart', (ev) => {
      dragging = { kind: target.kind, id: target.id };
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', `${target.kind}:${target.id}`); } catch { /* old browsers */ }
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => { dragging = null; el.classList.remove('dragging'); clearMarks(); });
    el.addEventListener('dragover', (ev) => {
      if (!dragging || (dragging.kind === target.kind && dragging.id === target.id)) return;
      ev.preventDefault();
      let z = zone(el, ev);
      if (z === 'into' && dragging.kind === 'folder') z = ev.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2 ? 'before' : 'after';
      clearMarks();
      el.classList.add('drop-' + z);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const d = dragging; dragging = null;
      const z = el.classList.contains('drop-into') ? 'into' : el.classList.contains('drop-before') ? 'before' : 'after';
      clearMarks();
      if (!d) return;
      move(d, target, z);
    });
  }
  // Moves a dragged server or folder relative to a target.
  function move(d, target, z) {
    const r = rail();
    if (d.kind === 'folder') {
      const key = 'f:' + d.id;
      const tKey = target.kind === 'folder' ? 'f:' + target.id : target.folder ? 'f:' + target.folder : 's:' + target.id;
      if (key === tKey) return;
      r.order = r.order.filter((k) => k !== key);
      const i = r.order.indexOf(tKey);
      r.order.splice(z === 'before' ? i : i + 1, 0, key);
      return save();
    }
    const sid = d.id;
    detach(sid);
    if (target.kind === 'folder') {
      const f = folderById(target.id);
      if (z === 'into') { f.servers.push(sid); f.open = true; } else {
        const i = r.order.indexOf('f:' + f.id); r.order.splice(z === 'before' ? i : i + 1, 0, 's:' + sid);
      }
      return save();
    }
    if (target.folder) { // a server inside an open folder
      const f = folderById(target.folder);
      const i = f.servers.indexOf(target.id);
      f.servers.splice(z === 'before' ? i : i + 1, 0, sid);
      return save();
    }
    const tKey = 's:' + target.id;
    const i = r.order.indexOf(tKey);
    if (z === 'into') { // dropped onto another server: a new folder with both
      const f = { id: newId(), name: 'New folder', color: COLORS[r.folders.length % COLORS.length], emoji: '', open: true, muted: false, servers: [target.id, sid] };
      r.folders.push(f);
      r.order.splice(i, 1, 'f:' + f.id);
      save();
      setTimeout(() => editFolder(f, { created: true }), 50);
      return;
    }
    r.order.splice(z === 'before' ? i : i + 1, 0, 's:' + sid);
    save();
  }
  function detach(sid) {
    const r = rail();
    r.order = r.order.filter((k) => k !== 's:' + sid);
    for (const f of r.folders) f.servers = f.servers.filter((x) => x !== sid);
  }

  // ------------------------------------------------------------------ menus and dialogs
  function folderMenuItems(f) {
    const servers = ctx.servers().filter((s) => f.servers.includes(s.id));
    const r = rail();
    return [
      { header: f.name },
      { label: 'Edit folder…', icon: 'edit', action: () => editFolder(f) },
      { label: r.focus === f.id ? 'Show all servers' : 'Focus on this folder', icon: 'compass', action: () => { r.focus = r.focus === f.id ? null : f.id; save(); } },
      { label: 'Mark all as read', icon: 'check', action: () => servers.forEach((s) => ctx.markServerRead(s)) },
      { label: f.muted ? 'Unmute folder' : 'Mute folder', icon: f.muted ? 'bell' : 'bellOff', action: () => {
        f.muted = !f.muted;
        servers.forEach((s) => ctx.setNotify('s:' + s.id, f.muted ? 'muted' : 'default'));
        save();
      } },
      { label: 'Organize servers…', icon: 'menu', action: () => openOrganize() },
      '-',
      { label: 'Ungroup (keep the servers)', icon: 'trash', danger: true, action: () => removeFolder(f) },
    ];
  }
  function removeFolder(f) {
    const r = rail();
    const i = r.order.indexOf('f:' + f.id);
    r.order.splice(i, 1, ...f.servers.map((s) => 's:' + s));
    r.folders = r.folders.filter((x) => x !== f);
    if (r.focus === f.id) r.focus = null;
    save();
  }
  // Extra items for a server's right-click menu.
  function serverMenuExtras(s) {
    const f = folderOf(s.id);
    return [
      { label: 'Move to folder…', icon: 'folder', action: () => pickFolder(s) },
      f ? { label: `Take out of ${f.name}`, icon: 'logout', action: () => { detach(s.id); const i = rail().order.indexOf('f:' + f.id); rail().order.splice(i + 1, 0, 's:' + s.id); save(); } } : null,
      { label: 'Organize servers…', icon: 'menu', action: () => openOrganize() },
    ];
  }
  function pickFolder(s) {
    const r = rail();
    const cur = folderOf(s.id);
    const m = modal({ title: `Move ${s.name} to a folder`, size: 'sm', body: h('div', { class: 'stack' },
      ...r.folders.map((f) => h('button', { class: `quick-row${cur === f ? ' picked' : ''}`, onclick: () => { detach(s.id); f.servers.push(s.id); save(); m.close(); } },
        h('span', { class: 'folder-dot', style: { background: f.color } }, f.emoji || ''), h('span', { class: 'quick-text' }, h('strong', null, f.name), h('span', null, `${f.servers.length} server${f.servers.length === 1 ? '' : 's'}`)))),
      h('button', { class: 'btn', onclick: () => { m.close(); const f = newFolder([s.id]); editFolder(f, { created: true }); } }, icon('plus'), 'New folder')) });
  }
  function newFolder(serverIds = []) {
    const r = rail();
    // The folder takes the place of the (first) server it's made from.
    const where = serverIds.length ? r.order.indexOf('s:' + serverIds[0]) : -1;
    const inside = serverIds.length && folderOf(serverIds[0]);
    serverIds.forEach(detach);
    const f = { id: newId(), name: 'New folder', color: COLORS[r.folders.length % COLORS.length], emoji: '', open: true, muted: false, servers: serverIds };
    r.folders.push(f);
    const at = where >= 0 ? where : inside ? r.order.indexOf('f:' + inside.id) + 1 : r.order.length;
    r.order.splice(at, 0, 'f:' + f.id);
    save();
    return f;
  }
  function editFolder(f, { created = false } = {}) {
    const name = h('input', { class: 'input', maxlength: '32', value: f.name === 'New folder' && created ? '' : f.name, placeholder: 'e.g. School, Gaming, Work' });
    const emoji = h('input', { class: 'input emoji-input', maxlength: '8', value: f.emoji, placeholder: '📚' });
    let color = f.color;
    const sw = h('div', { class: 'row gap tight wrap' });
    const drawSw = () => { clear(sw); COLORS.forEach((c) => sw.append(h('button', { class: `color-dot${c === color ? ' active' : ''}`, style: { background: c }, 'aria-label': c, onclick: () => { color = c; drawSw(); } }))); };
    drawSw();
    modal({ title: created ? 'Name your folder' : 'Edit folder', size: 'sm', body: h('div', { class: 'stack' }, field('Name', name), field('Emoji (optional)', emoji), h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Colour'), sw)),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => { f.name = name.value.trim() || 'Folder'; f.emoji = emoji.value.trim(); f.color = color; save(); } }] });
  }
  function focusMenu(anchor) {
    const r = rail();
    menu(anchor, [
      { header: 'Show in the bar' },
      { label: 'All servers', checked: !r.focus, action: () => { r.focus = null; save(); } },
      ...r.folders.map((f) => ({ label: `${f.emoji ? f.emoji + ' ' : ''}${f.name}`, checked: r.focus === f.id, action: () => { r.focus = f.id; save(); } })),
    ], { side: ctx.railSide() });
  }

  // A plain list for arranging everything without dragging (keyboard and touch friendly).
  function openOrganize() {
    const body = h('div', { class: 'organize' });
    const draw = () => {
      normalize();
      const r = rail();
      const byId = new Map(ctx.servers().map((s) => [s.id, s]));
      clear(body);
      const moveKey = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; save(); draw(); };
      const folderSelect = (s) => {
        const cur = folderOf(s.id);
        const sel = h('select', { class: 'input sm', 'aria-label': `Folder for ${s.name}`, onchange: () => {
          const v = sel.value;
          detach(s.id);
          if (v === '') r.order.push('s:' + s.id); else if (v === '+') { const f = newFolder([s.id]); editFolder(f, { created: true }); } else folderById(v).servers.push(s.id);
          save(); draw();
        } }, h('option', { value: '' }, 'No folder'), ...r.folders.map((f) => h('option', { value: f.id }, `${f.emoji ? f.emoji + ' ' : ''}${f.name}`)), h('option', { value: '+' }, 'New folder…'));
        sel.value = cur ? cur.id : '';
        return sel;
      };
      const serverRow = (s, list, i) => h('div', { class: 'org-row' },
        h('span', { class: 'org-icon' }, ctx.serverIcon(s)), h('span', { class: 'org-name' }, s.name), folderSelect(s),
        h('button', { class: 'icon-btn sm', 'aria-label': `Move ${s.name} up`, onclick: () => moveKey(list, i, -1) }, '↑'),
        h('button', { class: 'icon-btn sm', 'aria-label': `Move ${s.name} down`, onclick: () => moveKey(list, i, 1) }, '↓'));
      r.order.forEach((k, i) => {
        if (k.startsWith('s:')) { const s = byId.get(k.slice(2)); if (s) body.append(serverRow(s, r.order, i)); return; }
        const f = folderById(k.slice(2));
        body.append(h('div', { class: 'org-folder', style: { '--fc': f.color } },
          h('div', { class: 'org-row head' },
            h('span', { class: 'folder-dot', style: { background: f.color } }, f.emoji || ''), h('strong', { class: 'org-name' }, f.name),
            h('button', { class: 'btn ghost sm', onclick: () => editFolder(f) }, 'Edit'),
            h('button', { class: 'btn ghost sm', onclick: () => { r.focus = r.focus === f.id ? null : f.id; save(); draw(); } }, r.focus === f.id ? 'Unfocus' : 'Focus'),
            h('button', { class: 'icon-btn sm', 'aria-label': `Move ${f.name} up`, onclick: () => moveKey(r.order, i, -1) }, '↑'),
            h('button', { class: 'icon-btn sm', 'aria-label': `Move ${f.name} down`, onclick: () => moveKey(r.order, i, 1) }, '↓'),
            h('button', { class: 'btn ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: `Ungroup ${f.name}?`, text: 'The servers stay; only the folder goes.', confirm: 'Ungroup' })) { removeFolder(f); draw(); } } }, 'Ungroup')),
          ...f.servers.map((id, j) => byId.get(id) && serverRow(byId.get(id), f.servers, j)).filter(Boolean),
          f.servers.length ? null : h('p', { class: 'field-hint' }, 'Empty — pick this folder for a server below.')));
      });
      if (!ctx.servers().length) body.append(h('p', { class: 'muted-p' }, 'Join or create a server first.'));
    };
    draw();
    modal({ title: 'Organize servers', size: 'md', className: 'organize-modal',
      body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Group servers into folders and put them in any order. You can also drag servers in the left bar: drop one onto another to make a folder. Your folders follow you to every device.'),
        h('div', null, h('button', { class: 'btn', onclick: () => { const f = newFolder([]); draw(); editFolder(f, { created: true }); } }, icon('plus'), 'New folder')), body) });
  }

  return { render, entries, serverMenuExtras, openOrganize, applyRemote, folderOf };
}
