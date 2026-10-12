// Channel and category order in a server's sidebar: drag and drop, and Move up / Move down in the channel and
// category menus. Both send the whole list as the person sees it (POST /servers/:id/channel-order for channels,
// PATCH /servers/:id { categoryOrder } for categories); this works out what that list may change.
//
// What's stored: each channel's `position` (one sequence for the whole server; only the order inside a category
// matters) and `category` (a name: categories are labels on channels, with no permissions of their own, so the
// checks go by the channels in them), plus the server's `category_order` (names, top to bottom; a category missing
// from it comes after the ones in it, in the order of its first channel).
//
// A full list can't say which item "moved", so these rules decide:
//   - What the person can't see keeps its place. A hidden channel stays in its category, right after the channel it
//     followed before (among the ones they see and that are still there), so nobody's reorder drops it to the end; a
//     category they see no channel of keeps its place in the order. The list they send has to be exactly the
//     channels they see, and a hidden channel's id is refused like an id that doesn't exist, so nothing about
//     hidden channels shows.
//   - What they see but can't manage (Manage Channels denied in that channel) can't change category and keeps its
//     order among the other such channels. A category holding such a channel keeps its order among the other such
//     categories. What they do manage goes wherever they put it, around those.
//   - A channel only goes into a category they can see (dragging only offers those). Making new categories is still
//     Edit channel's job. Categories are labels, not locks: a channel they manage can go into a category whose other
//     channels they can't manage (as Edit channel's category field allows), and a single such category can end up
//     anywhere, since the categories around it can move.
//   - The apps also send the layout they started from (`from`, `categoryOrderFrom`). If it isn't what's stored now
//     (someone else moved something in the meantime), the list is refused as stale instead of quietly undoing that.
const catOf = (c) => c.category || (c.type === 'voice' ? 'Voice' : 'Text');
const STALE = 'The channel list changed in the meantime. Try again.';
const UNKNOWN = 'Pick one of the categories in the list.';
// Where a category name is typed (Edit channel's and Create channel's category field, Rename category's new name), a
// made-up name is accepted (it makes a new category), so naming a category of channels the person can't see can't
// get the same answer as a made-up one. It gets this instead, which says no more than the refusal itself does.
const CLOSED = 'You can’t add channels to that category. Pick one from the list or type a different name.';
const CLOSED_RENAME = 'You can’t add channels to that category, so you can’t rename this one to it. Type a different name.';

// Whether `name` is a category of channels the person can't see: it has channels, and they see none of them. Such a
// category belongs to the people who can see its channels, so this person can't put anything in it, merge into it or
// rename it. Where the name comes from a list (a drag, Rename category's `from`) it's refused like a name that isn't
// in it; where it's typed it gets CLOSED. A name with no channels is a new category; one with a channel they see is
// theirs. What still shows: that a category by a guessed name exists (categories are names shared by the whole
// server), never its place in the order or its channels.
// except: a channel not to count (the one being moved, which is wherever it is now).
function hiddenCategory(channels, seen, name, except = null) {
  let any = false;
  for (const c of channels) {
    if (c.id === except || catOf(c) !== name) continue;
    if (seen.has(c.id)) return false;
    any = true;
  }
  return any;
}

// Every category that has a channel, top to bottom, the way the apps show them (orderedCategories in app.js).
// channels: the server's channels by position (then age).
function categoriesInOrder(channels, stored) {
  const exist = new Set(channels.map(catOf)); // in the order of each one's first channel
  const first = [...new Set(Array.isArray(stored) ? stored : [])].filter((k) => typeof k === 'string' && exist.has(k));
  const listed = new Set(first);
  return [...first, ...[...exist].filter((k) => !listed.has(k))];
}
const parseOrder = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// Which items changed place between two orders of the same items: all but the longest run that kept its order,
// so dragging one channel past five others counts as one move, not six.
function movedItems(before, after) {
  const at = new Map(before.map((x, i) => [x, i]));
  const seq = after.map((x) => at.get(x));
  const tails = []; const tailAt = []; const prev = [];
  for (let i = 0; i < seq.length; i++) {
    let lo = 0; let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < seq[i]) lo = mid + 1; else hi = mid; }
    tails[lo] = seq[i]; tailAt[lo] = i; prev[i] = lo ? tailAt[lo - 1] : -1;
  }
  const kept = new Set();
  for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = prev[i]) kept.add(after[i]);
  return after.filter((x) => !kept.has(x));
}

// The categories as the person sees them, top to bottom (what orderedCategories in app.js shows them).
const visibleCategories = (channels, stored, seen) => categoriesInOrder(channels.filter((c) => seen.has(c.id)), stored);

// Whether `from` ([[category, [channel ids top to bottom]], …], what the person's app showed) is still how the channels
// they see are laid out. The order of the categories doesn't matter here (that's the category order's own list).
function sameLayout(channels, seen, from) {
  const now = new Map();
  for (const c of channels) {
    if (!seen.has(c.id)) continue;
    const k = catOf(c);
    if (!now.has(k)) now.set(k, []);
    now.get(k).push(c.id);
  }
  if (from.length !== now.size) return false;
  return from.every(([k, ids]) => now.has(k) && now.get(k).join('\n') === ids.join('\n'));
}

// A new channel order. channels: every channel of the server by position; stored: its category_order; ids: the
// channels the person sees, top to bottom; moves: Map of channel id -> category for the ones going into another
// category; seen / managed: Sets of the channel ids they can see / manage; from: the layout their app started from
// (optional, see sameLayout). fail(status, message) throws.
// Returns { updates: [{ c, position, category? }] (rows to write), recategorized: [{ c, from, to }],
// reordered: [channels that changed place inside their category] }.
function planChannels({ channels, stored, ids, moves, seen, managed, from, fail }) {
  const visible = channels.filter((c) => seen.has(c.id));
  const byId = new Map(visible.map((c) => [c.id, c]));
  // ids are unique (the route checks), so this is "exactly the channels they see".
  if (ids.length !== visible.length || !ids.every((id) => byId.has(id))) fail(400, STALE);
  if (from && !sameLayout(channels, seen, from)) fail(400, STALE);
  const theirs = new Set(visible.map(catOf));
  const target = new Map(); // channel id -> its new category (real moves only)
  for (const [id, name] of moves) {
    const c = byId.get(id);
    if (!c) fail(400, STALE);
    if (!theirs.has(name)) fail(400, UNKNOWN);
    if (name === catOf(c)) continue;
    if (!managed.has(c.id)) fail(403, `You can’t move #${c.name}: you don’t have Manage Channels there.`);
    target.set(id, name);
  }
  const catNow = (c) => target.get(c.id) || catOf(c);
  const group = (list, key) => {
    const m = new Map();
    for (const c of list) { const k = key(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
    return m;
  };
  const oldIn = group(channels, catOf); // everything, as it is
  const newIn = group(ids.map((id) => byId.get(id)), catNow); // what they see, as they want it
  // Channels they can't manage keep their order among themselves (they can't change category, see above).
  for (const [k, list] of oldIn) {
    const was = list.filter((c) => seen.has(c.id) && !managed.has(c.id));
    const now = (newIn.get(k) || []).filter((c) => !managed.has(c.id));
    const i = was.findIndex((c, j) => now[j] !== c);
    if (i >= 0) fail(403, `You can’t move #${now[i].name}: you don’t have Manage Channels there.`);
  }
  // Hidden channels go back right after the channel they followed (the nearest one before them that they can see
  // and that's still in this category), or first in it if there's none.
  const order = categoriesInOrder(channels, stored);
  const rows = [];
  for (const k of order) {
    const vis = newIn.get(k) || [];
    const stays = new Set(vis);
    const after = new Map(); // anchor channel (null: the top) -> hidden channels right after it
    let anchor = null;
    for (const c of oldIn.get(k) || []) {
      if (seen.has(c.id)) { if (stays.has(c)) anchor = c; continue; }
      if (!after.has(anchor)) after.set(anchor, []);
      after.get(anchor).push(c);
    }
    const list = [...(after.get(null) || [])];
    for (const c of vis) list.push(c, ...(after.get(c) || []));
    for (const c of list) rows.push({ c, position: rows.length, category: target.get(c.id) });
  }
  const updates = rows.filter((r) => r.position !== r.c.position || r.category !== undefined);
  const recategorized = [...target].map(([id, to]) => ({ c: byId.get(id), from: catOf(byId.get(id)), to }));
  // For the audit log: in each category, the channels (of the ones that stayed in it) that changed place.
  const reordered = [];
  for (const [k, list] of newIn) {
    const stayed = list.filter((c) => !target.has(c.id));
    const was = (oldIn.get(k) || []).filter((c) => seen.has(c.id) && !target.has(c.id));
    reordered.push(...movedItems(was, stayed));
  }
  return { updates, recategorized, reordered };
}

// A new category order. requested: names top to bottom (cleaned; unknown ones and ones the person can't see are
// left out, the same way, and any of theirs that's missing keeps its place after the ones sent); from: the order
// their app showed (optional; refused as stale if it's no longer the order). Returns { order, moved } where order
// is the whole list to store and moved the categories that changed place.
function planCategories({ channels, stored, requested, seen, managed, from, fail }) {
  if (from && JSON.stringify(from) !== JSON.stringify(visibleCategories(channels, stored, seen))) fail(400, STALE);
  const all = categoriesInOrder(channels, stored);
  const theirs = new Set(); const locked = new Set();
  for (const c of channels) {
    if (!seen.has(c.id)) continue;
    theirs.add(catOf(c));
    if (!managed.has(c.id)) locked.add(catOf(c));
  }
  const asked = [...new Set(requested)].filter((k) => theirs.has(k));
  const sent = new Set(asked);
  const mine = [...asked, ...all.filter((k) => theirs.has(k) && !sent.has(k))];
  const was = all.filter((k) => locked.has(k));
  const now = mine.filter((k) => locked.has(k));
  const i = was.findIndex((k, j) => now[j] !== k);
  if (i >= 0) fail(403, `You can’t move the category “${now[i]}”: you don’t have Manage Channels in all of its channels.`);
  // Theirs fill the places theirs had; the others stay where they are.
  let j = 0;
  const order = all.map((k) => (theirs.has(k) ? mine[j++] : k));
  return { order, moved: movedItems(all.filter((k) => theirs.has(k)), mine) };
}

// Renaming a category (POST /servers/:id/categories/rename) relabels every channel in it. It's a change to the
// category, so it needs what dragging the category does: Manage Channels in every channel of it the person sees. A
// category they see no channel of is answered like one that doesn't exist. Naming it like another category merges
// the two, which moves its channels, so then they also have to see every one of them (a hidden channel keeps its
// category, as in planChannels), and the one merged into has to be one they see: a merge into a category of
// channels they can't see is refused (see hiddenCategory). Returns { relabel: the channels to relabel, merge }.
function planRename({ channels, seen, managed, from, to, fail }) {
  const inIt = channels.filter((c) => catOf(c) === from);
  if (!inIt.some((c) => seen.has(c.id))) fail(400, UNKNOWN);
  if (hiddenCategory(channels, seen, to)) fail(400, CLOSED_RENAME);
  const merge = to !== from && channels.some((c) => catOf(c) === to);
  const locked = `You can’t rename the category “${from}”: you don’t have Manage Channels in all of its channels.`;
  if (!inIt.every((c) => !seen.has(c.id) || managed.has(c.id))) fail(403, locked);
  if (merge && !inIt.every((c) => seen.has(c.id))) fail(403, locked);
  return { relabel: inIt, merge };
}

module.exports = { catOf, categoriesInOrder, visibleCategories, parseOrder, movedItems, sameLayout, planChannels, planCategories, planRename, hiddenCategory, STALE, UNKNOWN, CLOSED };
