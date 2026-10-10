// WCAG 2.x contrast ratios for the theme tokens in public/css/app.css. The browser resolves each token
// (var(), "R G B" triplets, color-mix) and paints it onto a canvas, so the numbers are the real sRGB
// pixels, translucent colours included. The ratio maths is the WCAG formula, done here by hand.

export const THEMES = ['dark', 'midnight', 'dim', 'ember', 'light'];

// [foreground, background, minimum ratio, what it's used for]. Backgrounds that are triplets are wrapped
// in rgb(). 4.5:1 for body text; 3:1 for non-text UI (status dots, the focus ring).
export const PAIRS = [
  ['var(--text)', 'rgb(var(--bg))', 4.5, 'text on the page background'],
  ['var(--text)', 'rgb(var(--s1))', 4.5, 'text on panels'],
  ['var(--text)', 'rgb(var(--s2))', 4.5, 'text on the chat area'],
  ['var(--text-2)', 'rgb(var(--s1))', 4.5, 'secondary text on panels'],
  ['var(--text-2)', 'rgb(var(--s2))', 4.5, 'secondary text on the chat area'],
  ['var(--msg-text)', 'rgb(var(--s2))', 4.5, 'message text'],
  ['var(--muted)', 'rgb(var(--s1))', 4.5, 'muted text (timestamps, hints) on panels'],
  ['var(--muted)', 'rgb(var(--s2))', 4.5, 'muted text on the chat area'],
  ['var(--muted)', 'rgb(var(--elev))', 4.5, 'muted text in menus and dialogs'],
  ['var(--accent-ink)', 'rgb(var(--s2))', 4.5, 'links on the chat area'],
  ['var(--accent-ink)', 'rgb(var(--elev))', 4.5, 'links in dialogs'],
  ['var(--on-accent)', 'var(--accent)', 4.5, 'text on primary buttons'],
  ['#fff', 'var(--danger-fill)', 4.5, 'text on danger buttons and badges'],
  ['var(--focus)', 'rgb(var(--s2))', 3, 'focus ring on the chat area'],
  ['var(--focus)', 'rgb(var(--s1))', 3, 'focus ring on panels'],
  ['var(--ok)', 'rgb(var(--s1))', 3, 'online dot'],
  ['var(--idle)', 'rgb(var(--s1))', 3, 'idle dot'],
  ['var(--dnd)', 'rgb(var(--s1))', 3, 'do-not-disturb dot'],
  ['var(--offline)', 'rgb(var(--s1))', 3, 'offline dot'],
];

// Runs in the page: returns [{ theme, fg, bg, rgbFg, rgbBg }] with the painted pixel colours.
export function paintTokens([themes, pairs]) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
  document.body.append(probe);
  // Reads one CSS colour expression in a theme and paints it over `under` (for translucent colours).
  const pixel = (theme, expr, under) => {
    probe.setAttribute('data-theme', theme);
    probe.style.color = '';
    probe.style.color = expr;
    const c = getComputedStyle(probe).color;
    ctx.clearRect(0, 0, 1, 1);
    if (under) { ctx.fillStyle = `rgb(${under.join(' ')})`; ctx.fillRect(0, 0, 1, 1); }
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const out = [];
  for (const theme of themes) {
    for (const [fg, bg] of pairs) {
      const rgbBg = pixel(theme, bg, [0, 0, 0]);
      out.push({ theme, fg, bg, rgbBg, rgbFg: pixel(theme, fg, rgbBg) });
    }
  }
  probe.remove();
  return out;
}

export function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Paints every pair in every theme on `page` and returns rows with the ratio and pass/fail.
export async function checkContrast(page) {
  const painted = await page.evaluate(paintTokens, [THEMES, PAIRS]);
  return painted.map((p) => {
    const [, , min, use] = PAIRS.find(([fg, bg]) => fg === p.fg && bg === p.bg);
    const r = ratio(p.rgbFg, p.rgbBg);
    return { theme: p.theme, fg: p.fg, bg: p.bg, use, min, ratio: Math.round(r * 100) / 100, ok: r >= min };
  });
}
