// Download page logic (kept out of the HTML so the strict security policy can block inline scripts).
const ua = navigator.userAgent;
const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios'
  : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac OS X/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'other';
const label = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', ios: 'iPhone & iPad', other: 'your device' };
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(0) + ' MB' : Math.round(n / 1024) + ' KB');
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => (k === 'class' ? (e.className = v) : k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v))); e.append(...kids.flat().filter((x) => x != null)); return e; };
let prompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; render(); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
let cfg = { name: 'Hearth', downloads: [] };
try { cfg = await (await fetch('/api/config')).json(); } catch {}
document.title = `Get ${cfg.name}`;
document.querySelectorAll('[data-name]').forEach((n) => { n.textContent = cfg.name; });
const files = cfg.downloads || [];
const mine = files.filter((f) => f.platform === os);
const installBtn = () => prompt ? el('button', { class: 'btn primary', onclick: async () => { prompt.prompt(); await prompt.userChoice; prompt = null; render(); } }, 'Install the app') : null;
const steps = {
  ios: ['Open this page in Safari', 'Tap the Share button', 'Choose "Add to Home Screen"', 'Open Hearth from your Home Screen and log in'],
  android: ['Open this page in Chrome', 'Tap the menu (⋮)', 'Choose "Install app"', 'Open Hearth from your home screen'],
};
function render() {
  const p = document.getElementById('primary');
  p.replaceChildren();
  p.append(el('h2', {}, `Get ${cfg.name} for ${label[os]}`));
  if ((os === 'windows' || os === 'mac' || os === 'linux') && (mine.length || cfg.desktopUrl)) {
    p.append(el('div', { class: 'row-btns' },
      ...mine.slice(0, 2).map((f) => el('a', { class: 'btn primary', href: f.url }, `Download ${f.name.split('.').pop().toUpperCase()} (${size(f.size)})`)),
      !mine.length && cfg.desktopUrl ? el('a', { class: 'btn primary', href: cfg.desktopUrl }, 'Download the desktop app') : null,
      installBtn()));
    if (os === 'mac') p.append(el('p', { class: 'dl-note' }, 'If macOS says the app can’t be opened, right-click it in Applications and choose Open the first time.'));
    if (os === 'windows') p.append(el('p', { class: 'dl-note' }, 'If Windows SmartScreen appears, choose “More info” → “Run anyway”.'));
  } else if (os === 'android' && mine.length) {
    p.append(el('div', { class: 'row-btns' },
      el('a', { class: 'btn primary', href: mine[0].url }, `Download the Android app (${size(mine[0].size)})`), installBtn()));
    p.append(el('p', { class: 'dl-note' }, 'Open the downloaded file and allow “Install unknown apps” for your browser when asked. Or skip the download: browser menu (⋮) → “Install app”.'));
  } else if (steps[os]) {
    p.append(installBtn() || '', el('ol', {}, steps[os].map((s) => el('li', {}, s))));
  } else {
    p.append(el('p', { class: 'dl-note' }, prompt ? 'Install it as an app from your browser:' : 'Install it from your browser menu (Chrome/Edge: “Install Hearth”), or just use it in the browser.'), installBtn() || '');
  }
  const all = document.getElementById('all');
  all.replaceChildren();
  const card = (title, kids) => el('div', { class: 'dl-card' }, el('h3', {}, title), ...kids);
  const fileList = (plat) => { const f = files.filter((x) => x.platform === plat); return f.length ? el('div', { class: 'dl-files' }, f.map((x) => el('a', { href: x.url }, x.name, el('span', {}, size(x.size))))) : el('p', {}, cfg.desktopUrl ? '' : 'Not published yet. Use the browser app meanwhile.'); };
  all.append(
    card('Windows', [fileList('windows')]), card('macOS', [fileList('mac')]), card('Linux', [fileList('linux')]),
    card('iPhone & iPad', [el('ol', {}, steps.ios.map((s) => el('li', {}, s)))]),
    card('Android', [files.some((x) => x.platform === 'android') ? fileList('android') : el('ol', {}, steps.android.map((s) => el('li', {}, s)))]),
  );
  if (cfg.desktopUrl) all.append(card('All desktop downloads', [el('a', { class: 'btn ghost', href: cfg.desktopUrl }, 'View releases')]));
}
render();
