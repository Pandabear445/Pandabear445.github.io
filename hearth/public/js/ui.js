// Modals, popovers and menus.
import { h, icon } from './util.js';

const layer = () => document.getElementById('layer');
let openPop = null;

// Everything a keyboard user can reach inside `root`, in tab order.
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]') && el.getClientRects().length);
}
// Keeps Tab and Shift+Tab inside `root` (open dialogs), wrapping at either end.
export function trapTab(e, root) {
  if (e.key !== 'Tab') return;
  const list = focusables(root);
  if (!list.length) { e.preventDefault(); root.focus({ preventScroll: true }); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !root.contains(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !root.contains(at))) { e.preventDefault(); first.focus(); }
}
// Puts focus back where it was before a dialog or popup opened, if that place still exists.
function restoreFocus(...targets) {
  const t = targets.find((el) => el && el.isConnected && el.getClientRects().length);
  if (t) t.focus({ preventScroll: true });
}

export function closePopover() {
  if (!openPop) return;
  const pop = openPop;
  openPop = null;
  const hadFocus = pop.contains(document.activeElement);
  pop.remove();
  if (pop._anchor && pop._anchor.hasAttribute('aria-expanded')) pop._anchor.setAttribute('aria-expanded', 'false');
  // Focus was inside the popup: send it back to the button that opened it, so it isn't lost on the page.
  if (hadFocus) restoreFocus(pop._anchor, pop._returnTo);
}

document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.contains(e.target) && !e.target.closest('[data-pop-anchor]')) closePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openPop) { const pop = openPop; const inside = pop.contains(document.activeElement); closePopover(); if (!inside) restoreFocus(pop._anchor, pop._returnTo); e.stopPropagation(); return; }
  const modals = document.querySelectorAll('.modal-backdrop:not(.closing)');
  const top = modals[modals.length - 1];
  if (top && top._close) top._close();
});

// Position `content` next to `anchor`. side: 'right' | 'left' | 'top' | 'bottom'
export function popover(anchor, content, { side = 'right', align = 'start', className = '', label = '', focus = true } = {}) {
  const returnTo = document.activeElement;
  closePopover();
  const isMenu = content.classList && content.classList.contains('menu');
  if (isMenu) menuSemantics(content);
  // A menu is its own widget; anything else (pickers, profile cards) is a small non-modal dialog.
  const name = label || (anchor && anchor.getAttribute && (anchor.getAttribute('aria-label') || anchor.getAttribute('data-tip'))) || '';
  const pop = h('div', { class: `popover ${className}`, role: isMenu ? null : 'dialog', 'aria-label': isMenu ? null : name || 'Popup', tabindex: '-1' }, content);
  pop._anchor = anchor && anchor.isConnected && anchor.matches('button, [role=button], a') ? anchor : null;
  pop._returnTo = returnTo;
  if (pop._anchor) pop._anchor.setAttribute('aria-expanded', 'true');
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // Tab leaves a menu (like a native one); other popups keep focus inside until Esc.
    if (isMenu) { e.preventDefault(); closePopover(); restoreFocus(pop._anchor, pop._returnTo); } else trapTab(e, pop);
  });
  layer().append(pop);
  openPop = pop;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const gap = 8;
  let x;
  let y;
  if (side === 'right') { x = r.right + gap; y = align === 'end' ? r.bottom - pr.height : r.top; }
  else if (side === 'left') { x = r.left - pr.width - gap; y = r.top; }
  else if (side === 'top') { x = align === 'end' ? r.right - pr.width : r.left; y = r.top - pr.height - gap; }
  else { x = align === 'end' ? r.right - pr.width : r.left; y = r.bottom + gap; }
  if (side === 'right' && x + pr.width > window.innerWidth - 8) x = r.left - pr.width - gap;
  if (side === 'left' && x < 8) x = r.right + gap;
  x = Math.max(8, Math.min(x, window.innerWidth - pr.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - pr.height - 8));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  // Menus focus their first item; other popups take focus themselves unless something inside asks for it
  // (a search box), so keyboard users land inside instead of behind them.
  requestAnimationFrame(() => {
    if (!focus || openPop !== pop || pop.contains(document.activeElement)) return;
    const first = isMenu ? pop.querySelector('.menu-item') : null;
    (first || pop).focus({ preventScroll: true });
  });
  return pop;
}

// Roles and arrow keys for a .menu built by hand (the status menu) or by menuEl.
function menuSemantics(el) {
  if (el._menu) return;
  el._menu = true;
  if (!el.getAttribute('role')) el.setAttribute('role', 'menu');
  for (const it of el.querySelectorAll('.menu-item')) if (!it.getAttribute('role')) it.setAttribute('role', 'menuitem');
  for (const it of el.querySelectorAll('.menu-sep')) if (!it.getAttribute('role')) it.setAttribute('role', 'separator');
  el.addEventListener('keydown', (e) => {
    const btns = [...el.querySelectorAll('.menu-item:not(:disabled)')];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = btns[(i + 1) % btns.length];
    else if (e.key === 'ArrowUp') next = btns[(i - 1 + btns.length) % btns.length];
    else if (e.key === 'Home') next = btns[0];
    else if (e.key === 'End') next = btns[btns.length - 1];
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Typing a letter jumps to the next item that starts with it.
      const k = e.key.toLowerCase();
      const order = [...btns.slice(i + 1), ...btns.slice(0, i + 1)];
      next = order.find((b) => b.textContent.trim().toLowerCase().startsWith(k)) || null;
    }
    if (next) { e.preventDefault(); next.focus(); }
  });
}

// Menu items: { label, icon, hint, danger, action } | '-' (separator) | { header: 'Text' }
function menuEl(items) {
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => {
    if (it === '-') return h('div', { class: 'menu-sep', role: 'separator' });
    if (it.header) return h('div', { class: 'menu-header', role: 'presentation' }, it.header);
    return h('button', {
      class: `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`,
      role: it.checked !== undefined ? 'menuitemradio' : 'menuitem',
      'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
      onclick: () => { closePopover(); it.action(); },
    }, it.icon ? icon(it.icon, 'ic menu-ic') : null, h('span', { class: 'menu-label' }, it.label),
    it.checked ? icon('check', 'ic menu-check') : it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
  }));
  menuSemantics(el);
  return el;
}

export function menu(anchor, items, opts = {}) {
  return popover(anchor, menuEl(items), { side: 'bottom', ...opts });
}

// Right-click menu at the pointer.
export function contextMenu(e, items) {
  e.preventDefault();
  const pt = h('span', { style: { position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px', width: '1px', height: '1px' } });
  document.body.append(pt);
  const pop = popover(pt, menuEl(items), { side: 'bottom', className: 'ctx' });
  pt.remove();
  return pop;
}

// Tooltips for anything with data-tip (icon buttons). Shown on hover and keyboard focus.
let tipEl = null;
let tipTimer = 0;
function hideTip() { clearTimeout(tipTimer); if (tipEl) { tipEl.remove(); tipEl = null; } }
function showTip(target) {
  hideTip();
  const text = target.dataset.tip;
  if (!text) return;
  tipTimer = setTimeout(() => {
    if (!document.body.contains(target)) return;
    tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, text);
    document.body.append(tipEl);
    const r = target.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    const side = target.dataset.tipSide || 'top';
    let x = r.left + r.width / 2 - t.width / 2;
    let y = r.top - t.height - 8;
    if (side === 'right') { x = r.right + 10; y = r.top + r.height / 2 - t.height / 2; }
    if (side === 'left') { x = r.left - t.width - 10; y = r.top + r.height / 2 - t.height / 2; }
    if (side === 'bottom' || y < 6) y = r.bottom + 8;
    tipEl.style.left = Math.max(6, Math.min(x, innerWidth - t.width - 6)) + 'px';
    tipEl.style.top = y + 'px';
  }, 350);
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t); else hideTip();
});
document.addEventListener('focusin', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t && t.matches(':focus-visible')) showTip(t); else hideTip();
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('scroll', hideTip, true);

// Icon-only button with a tooltip and an accessible label.
export function ibtn(name, label, onclick, { cls = '', side, active = false, attrs = {} } = {}) {
  return h('button', {
    class: `icon-btn ${cls}${active ? ' active' : ''}`.trim(),
    'aria-label': label, 'data-tip': label, 'data-tip-side': side || null,
    'aria-pressed': active ? 'true' : null,
    onclick, ...attrs,
  }, icon(name));
}

let dialogSeq = 0;
export function modal({ title, label, body, actions = [], size = 'md', onClose, className = '', dismissable = true }) {
  closePopover();
  // Where focus goes back to on close. If this dialog was opened from inside another one that is closing
  // (Back / Next between dialogs), fall back to whatever opened that one.
  const opener = document.activeElement;
  const parent = opener && opener.closest && opener.closest('.modal-backdrop');
  const fallback = parent ? parent._opener : null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const hadFocus = backdrop.contains(document.activeElement) || document.activeElement === document.body;
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 140);
    if (onClose) onClose();
    // Only take focus back if no newer dialog opened on top in the meantime (it has focus now).
    const newer = [...document.querySelectorAll('.modal-backdrop:not(.closing)')].some((b) => backdrop.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (hadFocus && !newer) restoreFocus(opener, fallback);
  };
  const titleId = `dlg-${++dialogSeq}`;
  const box = h('div', {
    class: `modal modal-${size} ${className}`, role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    'aria-labelledby': title ? titleId : null, 'aria-label': title ? null : label || 'Dialog',
  },
  title ? h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title),
    dismissable ? h('button', { class: 'icon-btn modal-x', 'aria-label': 'Close', onclick: close }, icon('close')) : null) : null,
  h('div', { class: 'modal-body' }, body),
  actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
    class: `btn ${a.kind || 'ghost'}`,
    type: a.submit ? 'submit' : 'button',
    onclick: async (e) => {
      if (!a.action) return close();
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const keep = await a.action();
        if (keep !== false) close();
      } catch (err) {
        showError(box, err.message);
      } finally { btn.disabled = false; }
    },
  }, a.label))) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (dismissable && e.target === backdrop) close(); } }, box);
  backdrop._close = dismissable ? close : () => {};
  backdrop._opener = opener && opener.isConnected && !(parent && parent.classList.contains('closing')) ? opener : fallback || opener;
  backdrop.dataset.locked = dismissable ? '' : '1';
  layer().append(backdrop);
  // Focus the first field; dialogs without one focus themselves so screen readers start at the title.
  const first = box.querySelector('input:not([type=file]), textarea, select');
  setTimeout(() => {
    if (closed || box.contains(document.activeElement)) return;
    if (first && !className.includes('mys-modal')) first.focus({ preventScroll: true });
    else box.focus({ preventScroll: true });
  }, 30);
  box.addEventListener('keydown', (e) => {
    // Tab stays inside the dialog that's on top.
    if (e.key === 'Tab' && !openPop) trapTab(e, box);
    // enter submits primary
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT') {
      const primary = box.querySelector('.modal-foot .btn.primary, .modal-foot .btn.danger');
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });
  return { close, box };
}

// Shows an error in a dialog and ties it to the field it's about (`input`, or the field that has focus,
// or the dialog's only field), so screen readers read it with that field.
export function showError(box, message, input) {
  let err = box.querySelector('.form-error');
  if (!err) {
    err = h('div', { class: 'form-error', role: 'alert' });
    (box.querySelector('.modal-body') || box).append(err);
  }
  if (!err.id) err.id = `err-${++dialogSeq}`;
  err.textContent = message;
  const fields = [...box.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select')];
  const target = input || (fields.includes(document.activeElement) ? document.activeElement : fields.length === 1 ? fields[0] : null);
  if (target) markInvalid(target, err);
}

// aria-invalid + aria-describedby on `input` pointing at `err`, cleared again as soon as the person edits it.
export function markInvalid(input, err) {
  if (!err.id) err.id = `err-${++dialogSeq}`;
  input.setAttribute('aria-invalid', 'true');
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== err.id);
  input.setAttribute('aria-describedby', [...ids, err.id].join(' '));
  if (!input._clearsError) {
    input._clearsError = true;
    input.addEventListener('input', () => clearInvalid(input));
  }
}
export function clearInvalid(input) {
  input.removeAttribute('aria-invalid');
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && !x.startsWith('err-'));
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
}

export function confirmDialog({ title, text, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('p', { class: 'muted-p' }, text),
      size: 'sm',
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Cancel' },
        { label: confirm, kind: danger ? 'danger' : 'primary', action: () => { done = true; resolve(true); } },
      ],
    });
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
