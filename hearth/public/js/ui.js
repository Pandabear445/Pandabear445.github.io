// Modals, popovers and menus.
import { h, icon } from './util.js';

const layer = () => document.getElementById('layer');
let openPop = null;

export function closePopover() {
  if (openPop) { openPop.remove(); openPop = null; }
}

document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.contains(e.target) && !e.target.closest('[data-pop-anchor]')) closePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openPop) { closePopover(); e.stopPropagation(); return; }
  const modals = document.querySelectorAll('.modal-backdrop');
  const top = modals[modals.length - 1];
  if (top && top._close) top._close();
});

// Position `content` next to `anchor`. side: 'right' | 'left' | 'top' | 'bottom'
export function popover(anchor, content, { side = 'right', align = 'start', className = '' } = {}) {
  closePopover();
  const pop = h('div', { class: `popover ${className}`, role: 'dialog' }, content);
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
  return pop;
}

// Menu items: { label, icon, hint, danger, action } | '-' (separator) | { header: 'Text' }
function menuEl(items) {
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => {
    if (it === '-') return h('div', { class: 'menu-sep', role: 'separator' });
    if (it.header) return h('div', { class: 'menu-header' }, it.header);
    return h('button', {
      class: `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`,
      role: it.checked !== undefined ? 'menuitemradio' : 'menuitem',
      'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
      onclick: () => { closePopover(); it.action(); },
    }, it.icon ? icon(it.icon, 'ic menu-ic') : null, h('span', { class: 'menu-label' }, it.label),
    it.checked ? icon('check', 'ic menu-check') : it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
  }));
  // Arrow-key navigation inside menus.
  el.addEventListener('keydown', (e) => {
    const btns = [...el.querySelectorAll('.menu-item')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
  });
  return el;
}

export function menu(anchor, items, opts = {}) {
  const pop = popover(anchor, menuEl(items), { side: 'bottom', ...opts });
  const first = pop.querySelector('.menu-item');
  if (first && opts.focus !== false) requestAnimationFrame(() => first.focus({ preventScroll: true }));
  return pop;
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

export function modal({ title, body, actions = [], size = 'md', onClose, className = '', dismissable = true }) {
  closePopover();
  const close = () => {
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 140);
    if (onClose) onClose();
  };
  const box = h('div', { class: `modal modal-${size} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title ? h('div', { class: 'modal-head' }, h('h2', null, title),
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
  backdrop.dataset.locked = dismissable ? '' : '1';
  layer().append(backdrop);
  const first = box.querySelector('input:not([type=file]), textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  // enter submits primary
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT') {
      const primary = box.querySelector('.modal-foot .btn.primary, .modal-foot .btn.danger');
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });
  return { close, box };
}

export function showError(box, message) {
  let err = box.querySelector('.form-error');
  if (!err) {
    err = h('div', { class: 'form-error', role: 'alert' });
    (box.querySelector('.modal-body') || box).append(err);
  }
  err.textContent = message;
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
