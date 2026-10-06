// Picture editor: drag to move, zoom to crop. Works for avatars, banners and profile backgrounds.
// The result is { x, y, z }: offset as % of the frame and a zoom factor. It's applied with a CSS
// transform at display time, so nothing is re-encoded and animated GIFs keep animating.
import { h, icon } from './util.js';
import { modal } from './ui.js';

const FRAMES = {
  avatar: { w: 280, h: 280, label: 'Profile picture' },
  banner: { w: 400, h: 141, label: 'Banner' }, // same shape as the profile card banner
  background: { w: 280, h: 440, label: 'Profile background' },
};
const MAX_Z = 5;

export function openCropper({ src, kind = 'avatar', shape = 'circle', crop, title, saveLabel = 'Save', onSave }) {
  const F = FRAMES[kind] || FRAMES.avatar;
  let c = { x: 0, y: 0, z: 1, ...(crop || {}) };
  let nat = { w: 1, h: 1 };

  const img = h('img', { class: 'cropped crop-img', src, alt: '', draggable: 'false' });
  const stage = h('div', {
    class: `crop-stage crop-${kind} mask-${shape}`, tabindex: '0', role: 'application',
    'aria-label': 'Drag to move the picture. Arrow keys move it, plus and minus zoom.',
    style: { width: F.w + 'px', height: F.h + 'px' },
  }, img, h('div', { class: 'crop-mask', 'aria-hidden': 'true' }), h('div', { class: 'crop-grid', 'aria-hidden': 'true' }));
  const zoom = h('input', { type: 'range', class: 'range', min: '1', max: String(MAX_Z), step: '0.01', value: String(c.z), 'aria-label': 'Zoom' });
  const previews = h('div', { class: 'crop-previews' });

  // How much bigger than the frame the picture is once it "covers" it, in frame units.
  const cover = () => {
    const fa = F.w / F.h;
    const ia = nat.w / nat.h;
    return ia > fa ? { w: ia / fa, h: 1 } : { w: 1, h: fa / ia };
  };
  const clamp = () => {
    const cv = cover();
    const mx = ((cv.w * c.z - 1) / 2) * 100;
    const my = ((cv.h * c.z - 1) / 2) * 100;
    c.x = Math.max(-mx, Math.min(mx, c.x));
    c.y = Math.max(-my, Math.min(my, c.y));
    c.z = Math.max(1, Math.min(MAX_Z, c.z));
  };
  const apply = () => {
    clamp();
    const vars = { '--tx': c.x.toFixed(2) + '%', '--ty': c.y.toFixed(2) + '%', '--z': c.z.toFixed(3) };
    for (const el of [img, ...previews.querySelectorAll('img')]) Object.entries(vars).forEach(([k, v]) => el.style.setProperty(k, v));
    zoom.value = String(c.z);
  };
  const zoomBy = (f) => { c.z *= f; apply(); };

  // Drag to move. Movement is converted to % of the frame, so it matches how it's displayed.
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    c.x = drag.cx + ((e.clientX - drag.x) / (stage.clientWidth || F.w)) * 100;
    c.y = drag.cy + ((e.clientY - drag.y) / (stage.clientHeight || F.h)) * 100;
    apply();
  });
  const end = () => { drag = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.06 : 1 / 1.06); }, { passive: false });
  stage.addEventListener('dblclick', () => { c = { x: 0, y: 0, z: c.z > 1 ? 1 : 2 }; apply(); });
  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) { e.preventDefault(); c.x += moves[e.key][0]; c.y += moves[e.key][1]; apply(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.1); }
    if (e.key === '-') { e.preventDefault(); zoomBy(1 / 1.1); }
  });
  zoom.addEventListener('input', () => { c.z = +zoom.value; apply(); });

  // Live previews at the sizes people will actually see.
  const pv = (w, hgt, cls) => h('div', { class: `crop-pv ${cls}`, style: { width: w + 'px', height: hgt + 'px' } }, h('img', { class: 'cropped', src, alt: '' }));
  if (kind === 'avatar') previews.append(pv(80, 80, `mask-${shape}`), pv(40, 40, `mask-${shape}`), pv(24, 24, `mask-${shape}`));
  else if (kind === 'banner') previews.append(pv(272, 96, 'rounded'));
  else previews.append(pv(120, 188, 'rounded'));

  img.addEventListener('load', () => { nat = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 }; apply(); });

  const m = modal({
    title: title || `Adjust ${F.label.toLowerCase()}`,
    size: 'md',
    className: 'crop-modal',
    body: h('div', { class: 'crop' },
      h('p', { class: 'muted-p' }, 'Drag to move. Zoom to crop. Double-click to reset.'),
      h('div', { class: 'crop-main' }, stage, h('div', { class: 'crop-side' }, h('span', { class: 'field-label' }, 'Preview'), previews)),
      h('div', { class: 'crop-zoom' },
        h('button', { class: 'icon-btn', 'aria-label': 'Zoom out', 'data-tip': 'Zoom out', onclick: () => zoomBy(1 / 1.15) }, icon('zoomOut')),
        zoom,
        h('button', { class: 'icon-btn', 'aria-label': 'Zoom in', 'data-tip': 'Zoom in', onclick: () => zoomBy(1.15) }, icon('zoomIn')),
        h('button', { class: 'btn ghost sm', onclick: () => { c = { x: 0, y: 0, z: 1 }; apply(); } }, 'Reset'))),
    actions: [
      { label: 'Cancel' },
      { label: saveLabel, kind: 'primary', action: async () => { clamp(); await onSave({ x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(3) }); } },
    ],
  });
  setTimeout(() => stage.focus(), 50);
  return m;
}
