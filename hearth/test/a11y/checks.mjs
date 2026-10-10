// Accessibility checks that run inside the page (passed to page.evaluate). Hand-written instead of a
// library so the suite needs nothing installed: accessible names, image alt text, form labels, tabindex
// and dialog semantics. Colour contrast is checked separately (contrast.mjs) from the theme tokens.

// Returns a list of { rule, el, detail } for the visible part of the page.
export function auditDom() {
  const issues = [];
  const hiddenUp = (el) => !!el.closest('[hidden], [aria-hidden="true"], [inert]');
  const visible = (el) => {
    if (hiddenUp(el)) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const describe = (el) => {
    const bits = [el.tagName.toLowerCase()];
    if (el.id) bits.push('#' + el.id);
    if (typeof el.className === 'string' && el.className.trim()) bits.push('.' + el.className.trim().split(/\s+/).slice(0, 3).join('.'));
    if (el.type && el.tagName === 'INPUT') bits.push(`[type=${el.type}]`);
    if (el.value && /^(INPUT|TEXTAREA)$/.test(el.tagName)) bits.push(`[value="${String(el.value).slice(0, 24)}"]`);
    const p = el.parentElement;
    const where = p ? ` in ${p.tagName.toLowerCase()}${p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/)[0] : ''}` : '';
    // The nearest heading above it, to find it on the page.
    let hd = null;
    for (const x of document.querySelectorAll('h1, h2, h3, h4')) if (x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) hd = x;
    return bits.join('') + where + (hd ? ` (under "${hd.textContent.trim().slice(0, 30)}")` : '');
  };
  // A simplified version of the accessible-name computation: enough to tell "has a name" from "doesn't".
  const textName = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
    if (node.getAttribute('aria-label')) return node.getAttribute('aria-label');
    if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
    if (node.tagName === 'svg') { const t = node.querySelector('title'); return t ? t.textContent : ''; }
    return [...node.childNodes].map(textName).join(' ');
  };
  const accName = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ').trim();
      if (t) return t;
    }
    if ((el.getAttribute('aria-label') || '').trim()) return el.getAttribute('aria-label').trim();
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => textName(l)).join(' ').trim();
      if (t) return t;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return el.value || el.type;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return (el.getAttribute('title') || '').trim();
    const t = textName(el).replace(/\s+/g, ' ').trim();
    if (t) return t;
    return (el.getAttribute('title') || '').trim();
  };

  const interactive = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=checkbox], [role=switch], [role=option], [role=slider], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(interactive)) {
    if (!visible(el)) continue;
    // A checkbox or radio styled as a switch is often visually hidden; its label still counts.
    if (!accName(el)) issues.push({ rule: 'name', el: describe(el), detail: 'interactive element has no accessible name' });
  }
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), select, textarea')) {
    if (hiddenUp(el) || el.type === 'file') continue;
    const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.labels && el.labels.length) || el.getAttribute('title');
    if (!labelled) issues.push({ rule: 'label', el: describe(el), detail: el.placeholder ? `only a placeholder ("${el.placeholder}")` : 'no label' });
  }
  for (const el of document.querySelectorAll('img')) {
    if (!el.hasAttribute('alt')) issues.push({ rule: 'alt', el: describe(el), detail: 'img without alt' });
  }
  for (const el of document.querySelectorAll('[tabindex]')) {
    if (parseInt(el.getAttribute('tabindex'), 10) > 0) issues.push({ rule: 'tabindex', el: describe(el), detail: 'positive tabindex' });
  }
  for (const el of document.querySelectorAll('[role=dialog], [role=alertdialog]')) {
    if (!visible(el)) continue;
    if (!accName(el) || (el.getAttribute('aria-labelledby') == null && el.getAttribute('aria-label') == null)) issues.push({ rule: 'dialog-name', el: describe(el), detail: 'dialog has no label' });
    if (el.classList.contains('modal') && el.getAttribute('aria-modal') !== 'true') issues.push({ rule: 'dialog-modal', el: describe(el), detail: 'modal without aria-modal' });
  }
  // Tabs say which one is selected.
  for (const el of document.querySelectorAll('[role=tab]')) {
    if (visible(el) && !['true', 'false'].includes(el.getAttribute('aria-selected'))) issues.push({ rule: 'tab-selected', el: describe(el), detail: 'tab without aria-selected' });
  }
  // Popup buttons say whether their popup is open.
  for (const el of document.querySelectorAll('[aria-haspopup]')) {
    if (visible(el) && !el.hasAttribute('aria-expanded')) issues.push({ rule: 'expanded', el: describe(el), detail: 'popup button without aria-expanded' });
  }
  // Form errors are tied to their inputs.
  for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!ids.some((id) => { const d = document.getElementById(id); return d && d.textContent.trim(); })) issues.push({ rule: 'error-link', el: describe(el), detail: 'invalid input not described by an error message' });
  }
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) issues.push({ rule: 'dup-id', el: '#' + id, detail: `${n} elements share this id` });
  return issues;
}

// Does anything stick out sideways? Returns the page's horizontal overflow and the widest offenders.
export function overflowDom() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // Things inside a scroll box that scrolls sideways on purpose (chip rows, tab bars) are fine.
    let p = el.parentElement; let scrolls = false;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p.getBoundingClientRect().right <= vw + 1) { scrolls = true; break; }
      p = p.parentElement;
    }
    if (scrolls) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (getComputedStyle(el).position === 'fixed' && (r.right <= 0 || r.left >= vw)) continue; // parked off screen on purpose (closed drawers)
      out.push({ el: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''), left: Math.round(r.left), right: Math.round(r.right) });
    }
  }
  return { scrollWidth: doc.scrollWidth, bodyScroll: document.body.scrollWidth, clientWidth: vw, offenders: out.slice(0, 15) };
}
