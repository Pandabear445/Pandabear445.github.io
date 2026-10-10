// Settings → Apps & devices → "Desktop app": the Hearth desktop app's own settings (start with the computer,
// tray, spelling, zoom, graphics, updates, server). Only shown inside the desktop app (window.hearthDesktop).
// The app keeps these itself (settings.json on the computer, see desktop/main.js), not the server.
//
// Usage: desktopSettingsSection({ h, section, toggle, field, toast }) → a DOM node, or null outside the app.

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const nearestStep = (z) => ZOOM_STEPS.reduce((best, s, i) => (Math.abs(s - z) < Math.abs(ZOOM_STEPS[best] - z) ? i : best), 0);
const pct = (z) => `${Math.round(z * 100)}%`;
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };

export function desktopSettingsSection({ h, section, toggle, field, toast }) {
  const D = window.hearthDesktop;
  if (!D) return null;
  if (typeof D.getDesktopSettings !== 'function') {
    // An older desktop app (it updates itself): nothing to change here yet.
    return section('Desktop app', h('p', { class: 'muted-p' }, `You\u2019re using version ${D.version || '?'} of the desktop app. After its next update you can choose here whether it starts with your computer, its zoom, and more.`));
  }

  const isMac = D.platform === 'darwin';
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Loading…'));
  const root = section('Desktop app', body);
  let s = null;
  let restartNeeded = false;
  let update = null; // last answer from "Check for updates"

  const empty = (el) => { while (el.firstChild) el.firstChild.remove(); };
  const set = async (key, value) => {
    let r = null;
    try { r = await D.setDesktopSetting(key, value); } catch { /* handled below */ }
    if (!r || !r.ok) { toast((r && r.error) || 'Couldn’t change that setting.', 'error'); draw(); return null; }
    s = r.settings;
    if (key === 'hardwareAcceleration') restartNeeded = !!r.restartNeeded;
    draw();
    return r;
  };

  function updateText() {
    if (s.updateReady) return `Version ${s.updateReady} is ready to install.`;
    if (!update) return '';
    switch (update.state) {
      case 'checking': return 'Checking…';
      case 'none': return 'You have the latest version.';
      case 'downloading': return `Downloading version ${update.version || 'update'}${update.percent ? ` (${update.percent}%)` : ''}… Hearth asks to restart when it’s ready.`;
      case 'ready': return `Version ${update.version} is ready to install.`;
      default: return update.message || 'Couldn’t check for updates right now.';
    }
  }

  // Redrawing replaces the controls: keep keyboard focus on the same one.
  const idOf = (el) => el.getAttribute('aria-label') || (el.closest('label') || el).textContent;
  const focusKey = () => {
    const a = document.activeElement;
    if (!a || !body.contains(a)) return null;
    return { text: idOf(a), tag: a.tagName, type: a.type || '' };
  };
  const refocus = (k) => {
    if (!k) return;
    for (const el of body.querySelectorAll('input, button')) {
      if (el.tagName === k.tag && (el.type || '') === k.type && idOf(el) === k.text) { el.focus(); return; }
    }
  };

  function draw() {
    if (!s) return;
    const fk = focusKey();
    try { render(); } finally { refocus(fk); }
  }
  function render() {
    empty(body);
    const sup = s.supports || {};

    // Starting and closing
    if (sup.startAtLogin) {
      body.append(toggle('Start Hearth when I log in', s.startAtLogin, (v) => set('startAtLogin', v),
        'Hearth opens with your computer so you don’t miss messages.'));
      if (s.startAtLogin) {
        body.append(toggle('Start minimised in the tray', s.startHidden, (v) => set('startHidden', v),
          'When it starts with your computer, Hearth waits in the tray instead of opening its window.'));
      }
    }
    if (sup.closeToTray) {
      body.append(toggle('Keep running in the tray when closed', s.closeToTray, (v) => set('closeToTray', v),
        'Closing the window keeps Hearth running, so messages and calls still reach you. Quit from the tray icon.'));
    }
    body.append(toggle('Check spelling', s.spellcheck, (v) => set('spellcheck', v),
      'Underlines misspelled words; right-click one for suggestions.'));

    // Zoom: a slider over the same steps as Ctrl+= / Ctrl+-
    const label = h('span', null, `Zoom: ${pct(s.zoom)}`);
    const range = h('input', { type: 'range', class: 'range', min: '0', max: String(ZOOM_STEPS.length - 1), step: '1', value: String(nearestStep(s.zoom)), 'aria-label': 'Zoom', 'aria-valuetext': pct(s.zoom) });
    range.addEventListener('input', () => { const z = ZOOM_STEPS[+range.value]; label.textContent = `Zoom: ${pct(z)}`; range.setAttribute('aria-valuetext', pct(z)); });
    range.addEventListener('change', () => set('zoom', ZOOM_STEPS[+range.value]));
    body.append(field(label, range, `Makes everything bigger or smaller. Also ${mod} + / ${mod} −, ${mod} + mouse wheel, and ${mod} + 0 to reset.`));
    if (Math.abs(s.zoom - 1) > 0.001) body.append(h('div', null, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => set('zoom', 1) }, 'Reset zoom to 100%')));

    // Graphics
    body.append(toggle('Hardware acceleration', s.hardwareAcceleration, (v) => set('hardwareAcceleration', v),
      'Uses your graphics card to draw Hearth smoothly. Turn it off only if the window flickers, stays black or video looks broken. Takes effect after a restart.'));
    if (restartNeeded || s.hardwareAcceleration !== s.hardwareAccelerationActive) {
      body.append(h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
        h('span', { class: 'muted-p' }, 'Restart Hearth to apply this.'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => D.restart() }, 'Restart now')));
    }

    // Version and updates
    const status = h('span', { class: 'field-hint', role: 'status', 'aria-live': 'polite' }, updateText());
    const ready = s.updateReady || (update && update.state === 'ready' && update.version);
    const buttons = h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } });
    if (ready) {
      buttons.append(h('button', { class: 'btn sm primary', type: 'button', onclick: () => D.installUpdate() }, `Restart to update to ${ready}`));
    } else if (sup.updates) {
      const busy = update && (update.state === 'checking' || update.state === 'downloading');
      buttons.append(h('button', {
        class: 'btn sm', type: 'button', disabled: !!busy,
        onclick: async () => {
          update = { state: 'checking' }; draw();
          try { update = await D.checkForUpdates(); } catch { update = { state: 'error' }; }
          draw();
        },
      }, 'Check for updates'));
    }
    body.append(h('div', { class: 'stack tight' },
      h('span', { class: 'toggle-label' }, `Hearth for ${isMac ? 'Mac' : D.platform === 'win32' ? 'Windows' : 'Linux'} · version ${s.version}`),
      sup.updates || ready ? null : h('span', { class: 'field-hint' }, isMac ? 'Get new versions from your server’s download page.' : 'Updates install automatically in the installed app.'),
      // Newer apps say whether they check the publisher's signature on updates (older ones don't report it).
      sup.updates && 'updatesSigned' in s ? h('span', { class: 'field-hint' }, s.updatesSigned
        ? 'Hearth only installs updates signed by its publisher, and asks you first.'
        : 'This copy of Hearth can’t verify who made an update, so it asks you before installing one.') : null,
      buttons.childNodes.length ? buttons : null,
      status.textContent ? status : null));

    // Server
    body.append(h('div', { class: 'stack tight' },
      h('span', { class: 'toggle-label' }, 'Server'),
      h('span', { class: 'field-hint' }, s.serverLocked ? `This app is set up for ${hostOf(s.server)}.` : `Connected to ${hostOf(s.server)}. Switch to another Hearth server (you can come back any time).`),
      s.serverLocked ? null : h('div', null, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => D.changeServer() }, 'Change server…'))));
  }

  // Changes from elsewhere (the tray menu, Ctrl+= / Ctrl+-, another window) keep this in step.
  const offSettings = D.onDesktopSettings ? D.onDesktopSettings((next) => {
    if (!root.isConnected) { if (offSettings) offSettings(); return; }
    s = next; draw();
  }) : null;
  const offUpdates = D.onUpdateState ? D.onUpdateState((u) => {
    if (!root.isConnected) { if (offUpdates) offUpdates(); return; }
    update = u; draw();
  }) : null;

  D.getDesktopSettings().then((next) => { s = next; draw(); }).catch(() => {
    empty(body);
    body.append(h('p', { class: 'muted-p' }, 'Update the Hearth desktop app to change its settings here.'));
  });
  return root;
}
