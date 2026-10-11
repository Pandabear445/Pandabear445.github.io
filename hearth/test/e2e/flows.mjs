// The end-to-end flows, in order: each one builds on what the earlier ones set up (accounts, the server, roles…).
// Everything goes through the real UI; the only shortcuts are reading state the UI already shows.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { exact, makePng, totp, newPassword, Person } from './harness.mjs';

export function check(ok, message) { if (!ok) throw new Error(message); }
const SERVER = 'E2E Hall';

// ------------------------------------------------------------------ 1. accounts
async function accounts(t) {
  const alice = await t.open('alice');
  await alice.register('alice', t.pw.alice);
  // The first account owns the instance, so it gets the admin dashboard; nobody after it does.
  await alice.$('#rail button[aria-label="Admin"]').waitFor();
  const bob = await t.open('bob');
  await bob.register('bob', t.pw.bob);
  check(!(await bob.$('#rail button[aria-label="Admin"]').count()), 'A second account should not get the admin dashboard.');

  const logoutCalls = [];
  const onLogout = (r) => { if (r.url().endsWith('/api/auth/logout')) logoutCalls.push(r.status()); };
  alice.page.on('response', onLogout);
  await alice.logout();
  alice.page.off('response', onLogout);
  check(await alice.page.evaluate(() => !localStorage.getItem('hearth.token') && !localStorage.getItem('hearth.userId')), 'Logging out should forget the session on this device.');
  // Your own "Log out" isn't reported back to you as a sign-out from somewhere else, and runs only once.
  const why = (await alice.$('#login-form .form-error').innerText()).trim();
  check(!why, `After logging out, the sign-in screen should not say why this device was signed out (it says “${why}”).`);
  check(logoutCalls.length === 1 && logoutCalls[0] === 200, `Logging out should end the session once (got ${logoutCalls.join(', ') || 'no request'}).`);
  // A wrong password is refused with a plain message (and the form stays usable)…
  const f = alice.$('#login-form');
  await f.locator('[name=username]').fill('alice');
  await f.locator('[name=password]').fill(t.pw.alice + 'x');
  await f.locator('button[type=submit]').click();
  await f.locator('.form-error', { hasText: 'Wrong username or password' }).waitFor({ timeout: 30000 });
  // …the right one unlocks the account and its encryption key again.
  await alice.login('alice', t.pw.alice);
  await alice.$('#user-panel .me-text', { hasText: 'alice' }).waitFor();
}

// ------------------------------------------------------------------ 2. a server, an invite, a second member
async function servers(t) {
  const { alice, bob } = t.people;
  await alice.createServer(SERVER);
  await alice.channelRow('general').waitFor();
  await alice.channelRow('Lounge').waitFor();
  t.state.invite = await alice.inviteLink();
  await bob.join(t.state.invite, SERVER);
  await alice.showMembers();
  await alice.member('bob').waitFor();
  await bob.showMembers();
  await bob.member('alice').waitFor();
}

// ------------------------------------------------------------------ 3. channel messages
async function messages(t) {
  const { alice, bob } = t.people;
  await alice.openChannel('general');
  await bob.openChannel('general');
  await alice.send('Hello bob, the pineapple is ripe');
  await bob.message('the pineapple is ripe').waitFor();
  check(!(await bob.$('#messages .msg-text.undecryptable').count()), 'Bob should be able to decrypt every message in #general.');

  // Edit: the other side sees the new text, marked as edited.
  await alice.messageAction('pineapple is ripe', 'Edit message');
  const box = alice.$('#messages textarea.edit-input');
  await box.fill('Hello bob, the mango is ripe');
  await box.press('Enter');
  await bob.message('the mango is ripe').locator('.edited').waitFor();
  check(!(await bob.message('pineapple').count()), 'The old text should be gone after the edit.');

  // React.
  const onBob = bob.message('the mango is ripe').first();
  await onBob.hover();
  await onBob.locator('button[aria-label="React with thumbs up"]').click();
  await alice.message('the mango is ripe').locator('.reaction[aria-label="👍 1"]').waitFor();

  // A reply in a thread.
  await onBob.hover();
  await onBob.locator('button[aria-label="Reply in thread"]').click();
  await bob.send('A thread reply about mangoes', '.cw-thread textarea.composer-input');
  const chip = alice.message('the mango is ripe').locator('.thread-chip', { hasText: '1 reply' });
  await chip.waitFor();
  await chip.click();
  await alice.message('A thread reply about mangoes', '.thread-list').waitFor();

  // Delete: gone for both.
  await alice.send('This line will be deleted');
  await bob.message('will be deleted').waitFor();
  await alice.messageAction('will be deleted', 'Delete message');
  await alice.modal('Delete message?').locator('.modal-foot .btn.danger').click();
  await bob.message('will be deleted').waitFor({ state: 'detached' });
  await alice.message('will be deleted').waitFor({ state: 'detached' });

  // A reply quoting a message (its preview is decrypted on the other side too).
  await onBob.hover();
  await onBob.locator('button[aria-label="Reply"]').click();
  await bob.send('Quoting you: banana');
  await alice.message('Quoting you: banana').locator('.msg-reply .reply-text', { hasText: 'the mango is ripe' }).waitFor();

  // Pinning: everyone sees the pin, and the pinned list shows it decrypted.
  await alice.messageAction('the mango is ripe', 'Pin message');
  await alice.toast('Message pinned.');
  await bob.message('the mango is ripe').locator('.msg-pin').waitFor();
  await bob.$('#main-head button[aria-label="More"]').click();
  await bob.menuItem('Pinned messages').click();
  await bob.$('#members .pin-card .pin-text', { hasText: 'the mango is ripe' }).waitFor();

  // A poll: the question is encrypted like any message; votes show up for its author.
  await alice.$('.cw-main button[aria-label="Attach a file or create a poll"]').click();
  await alice.menuItem('Create a poll').click();
  const poll = await alice.dialog('Create a poll');
  await poll.locator('.field', { hasText: 'Question' }).locator('input').fill('Lunch today?');
  await poll.locator('input[placeholder="Option 1"]').fill('Soup');
  await poll.locator('input[placeholder="Option 2"]').fill('Salad');
  await poll.locator('.modal-foot .btn.primary', { hasText: 'Send poll' }).click();
  const onBobPoll = bob.$('#messages .poll', { hasText: 'Lunch today?' });
  await onBobPoll.locator('.poll-opt', { hasText: 'Salad' }).click();
  await alice.$('#messages .poll', { hasText: 'Lunch today?' }).locator('.poll-foot', { hasText: '1 vote' }).waitFor();
  await alice.$('#messages .poll', { hasText: 'Lunch today?' }).locator('.poll-opt', { hasText: 'Salad' }).locator('.poll-count', { hasText: '1 · 100%' }).waitFor();
}

// ------------------------------------------------------------------ 3b. a channel webhook (what Uptime Kuma posts)
async function webhooks(t) {
  const { alice, bob } = t.people;
  await alice.channelRow('general').click({ button: 'right' });
  await alice.menuItem('Webhooks').click();
  const settings = await alice.dialog('general — settings');
  // The tab saves as it goes, so the dialog's Save is hidden, and Enter in the name field makes the webhook only
  // (it once also pressed the dialog's Save, closing it and saving the other tabs).
  check(!(await settings.locator('.modal-foot .btn.primary', { hasText: 'Save' }).isVisible()), 'Save should be hidden on the Webhooks tab.');
  const channelSaves = [];
  const watch = (r) => { if (/\/api\/channels\/[^/]+(\/overrides)?$/.test(r.url()) && ['PATCH', 'PUT'].includes(r.method())) channelSaves.push(r.url()); };
  alice.page.on('request', watch);
  await settings.locator('input[aria-label="New webhook name"]').fill('Uptime Kuma');
  await settings.locator('input[aria-label="New webhook name"]').press('Enter');
  const shown = await alice.dialog('Webhook “Uptime Kuma” made');
  const url = await shown.locator('input[aria-label="Webhook address"]').inputValue();
  check(url.startsWith(`${t.server.base}/api/webhooks/`), `The webhook address should be on this server (got ${url}).`);
  t.state.hookUrl = url; // the threads flow posts through it again
  await shown.locator('.modal-foot .btn.primary', { hasText: 'Done' }).click();
  await settings.locator('.hook-row', { hasText: 'Uptime Kuma' }).waitFor();
  alice.page.off('request', watch);
  check(!channelSaves.length, `Enter in the webhook name field shouldn’t save the channel (sent ${channelSaves.join(', ')}).`);
  await settings.locator('.modal-x').click();
  await alice.noModals();
  // The program's side: a Discord-style post, no session.
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await post({ username: 'Uptime Kuma', embeds: [{ title: 'Your service My API went down.', color: 16711680, fields: [{ name: 'Error', value: 'timeout of 48000ms exceeded' }] }] });
  check(r.status === 204, `Posting to the webhook should answer 204 (got ${r.status}).`);
  const msg = bob.message('Your service My API went down.');
  await msg.locator('.msg-flag', { hasText: 'Webhook · not end-to-end encrypted' }).waitFor();
  await msg.locator('.msg-name', { hasText: 'Uptime Kuma' }).waitFor();
  await msg.locator('.bot-tag').waitFor();
  // Its @everyone doesn't ping anyone (webhooks may only when allowed).
  check((await post({ content: '@everyone the deploy finished' })).status === 204, 'The second post should be accepted.');
  const ping = bob.message('the deploy finished');
  await ping.waitFor();
  check(!(await ping.evaluate((el) => el.classList.contains('mentioned'))), 'A webhook’s @everyone should not ping (it wasn’t allowed to).');
}

// ------------------------------------------------------------------ 4. direct messages and blocking
async function directMessages(t) {
  const { alice, bob } = t.people;
  await alice.showMembers();
  await alice.member('bob').click();
  await alice.page.locator('.pop-profile button', { hasText: exact('Message') }).click();
  await alice.page.waitForSelector('#composer-input[placeholder="Message bob"]');
  await alice.send('Private hello to bob: kiwi');

  await bob.railButton('Direct messages');
  await bob.dmRow('alice').click();
  await bob.page.waitForSelector('#composer-input[placeholder="Message alice"]');
  await bob.message('Private hello to bob: kiwi').waitFor();
  await bob.send('Hi alice, got your kiwi');
  await alice.message('got your kiwi').waitFor();

  // Bob blocks alice: her next message is refused and never reaches him.
  await bob.$('#main-head button[aria-label="More"]').click();
  await bob.menuItem('Block').click();
  await bob.modal('Block alice?').locator('.modal-foot .btn.danger').click();
  await bob.$('#main .key-bar', { hasText: 'You blocked alice' }).waitFor();
  const refused = alice.page.waitForResponse((r) => /\/api\/dms\/\w+\/messages$/.test(r.url()) && r.request().method() === 'POST');
  await alice.$('#composer-input').fill('Are you there? papaya');
  await alice.$('#composer-input').press('Enter');
  check((await refused).status() === 403, 'A message to someone who blocked you should be refused.');
  await alice.toast('You can’t message this person.');
  check(!(await bob.message('papaya').count()), 'A blocked message should never show up.');

  // Unblocked: messages flow again.
  await bob.$('#main .key-bar button', { hasText: 'Unblock' }).click();
  await bob.$('#main .key-bar', { hasText: 'You blocked' }).waitFor({ state: 'detached' });
  await alice.send('Back again: guava');
  await bob.message('Back again: guava').waitFor();

  // Friends: a request from Friends → Add friend, accepted from Pending.
  await alice.railButton('Home');
  await alice.page.locator('#sidebar-body .nav-row', { hasText: 'Friends' }).click();
  await alice.page.locator('#main-head .tab', { hasText: 'Add friend' }).click();
  await alice.$('.add-friend input').fill('bob');
  await alice.$('.add-friend button', { hasText: 'Send request' }).click();
  await alice.$('.add-friend', { hasText: 'Friend request sent to bob.' }).waitFor();
  await bob.railButton('Home');
  await bob.page.locator('#sidebar-body .nav-row', { hasText: 'Friends' }).click();
  await bob.page.locator('#main-head .tab', { hasText: 'Pending' }).click();
  await bob.$('.friend-row', { hasText: 'alice' }).locator('button', { hasText: 'Accept' }).click();
  await alice.page.locator('#main-head .tab', { hasText: exact('All') }).click();
  await alice.$('.friend-row', { hasText: 'bob' }).waitFor();
}

// ------------------------------------------------------------------ 5. attachments
async function attachments(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  const png = makePng(64, 48);
  const bin = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) & 255));
  await alice.$('.cw-main input[type=file]').setInputFiles([
    { name: 'gradient.png', mimeType: 'image/png', buffer: png },
    { name: 'notes.bin', mimeType: 'application/octet-stream', buffer: bin },
  ]);
  await alice.send('Two files attached');
  const m = bob.message('Two files attached').first();
  await m.waitFor();
  // The picture is decrypted and shown…
  await bob.page.waitForFunction((id) => {
    const img = document.querySelector(`#messages [data-mid="${id}"] .att-img`);
    return img && img.complete && img.naturalWidth > 0;
  }, await m.getAttribute('data-mid'));
  check(Number(await m.locator('.att-img').evaluate((i) => i.naturalWidth)) === 64, 'The image preview should keep the picture’s size.');
  // …and the other file downloads byte for byte.
  const [download] = await Promise.all([bob.page.waitForEvent('download'), m.locator('.att-file button', { hasText: 'Download' }).click()]);
  check(download.suggestedFilename() === 'notes.bin', `The download should keep its name (got ${download.suggestedFilename()}).`);
  const got = fs.readFileSync(await download.path());
  check(Buffer.compare(got, bin) === 0, `The downloaded file should match what was sent (${got.length} vs ${bin.length} bytes).`);
  // Both count toward alice's storage.
  await alice.openSettings('Security');
  await alice.$('.set-content .kv', { hasText: 'Files in messages' }).locator('span', { hasText: /^2 ·/ }).waitFor();
  await alice.closeSettings();
}

// ------------------------------------------------------------------ pictures: avatar, server icon, custom emoji, GIF library
async function pictures(t) {
  const { alice, bob } = t.people;
  const png = makePng(128, 128);
  // An avatar, positioned in the cropper, then uploaded (its metadata is stripped on the server).
  await alice.openSettings('Profile');
  await alice.$('.media-row', { hasText: 'Avatar' }).locator('input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
  await (await alice.dialog('Position your avatar')).locator('.modal-foot button', { hasText: exact('Upload') }).click();
  await alice.toast('Avatar updated.');
  await alice.closeSettings();
  await bob.showMembers();
  await bob.member('alice').locator('img').waitFor();

  // A custom emoji and a server icon, from Server settings.
  await alice.serverMenu('Server settings');
  const ss = alice.$('.modal.server-settings');
  await ss.locator('.ss-tab', { hasText: 'Emoji' }).click();
  await ss.locator('input[type=file]').setInputFiles({ name: 'party_blob.png', mimeType: 'image/png', buffer: png });
  await ss.locator('button', { hasText: 'Upload 1 emoji' }).click();
  await alice.toast('Added 1 emoji.');
  await ss.locator('.emoji-admin-grid .emoji-admin input[aria-label="Emoji name"]').first().waitFor();
  await ss.locator('.ss-tab', { hasText: 'Overview' }).click();
  const [chooser] = await Promise.all([alice.page.waitForEvent('filechooser'), ss.locator('button', { hasText: 'Change icon' }).click()]);
  await chooser.setFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
  await alice.toast('Icon updated.');
  await ss.locator('.modal-x').click();
  await alice.noModals();
  await bob.$(`#rail button[aria-label="${SERVER}"] img`).waitFor();
  // The emoji in a message, picked from the :name suggestions.
  await alice.$('#composer-input').fill('Party time :party_bl');
  await alice.$('.composer-wrap .suggest:not([hidden])', { hasText: ':party_blob:' }).waitFor();
  await alice.$('#composer-input').press('Tab');
  await alice.$('#composer-input').press('Enter');
  await bob.message('Party time').locator('img.cemoji[alt=":party_blob:"]').waitFor();

  // A GIF added to this server's own library, then sent from the GIF picker.
  const gif = Buffer.from('47494638396101000100800000ffffff00000021f90400000000002c00000000010001000002024401003b', 'hex');
  await alice.$('.cw-main button[aria-label="GIFs"]').click();
  const [gifChooser] = await Promise.all([alice.page.waitForEvent('filechooser'), alice.$('.gif-picker button', { hasText: 'Add a GIF' }).first().click()]);
  await gifChooser.setFiles({ name: 'tiny-dot.gif', mimeType: 'image/gif', buffer: gif });
  await (await alice.dialog('Add to this server’s GIFs')).locator('.modal-foot .btn.primary').click();
  await alice.toast('Added. Everyone on this server can use it now.');
  await alice.$('.cw-main button[aria-label="GIFs"]').click();
  await alice.$('.gif-picker .gif-cat', { hasText: 'Most Used' }).click();
  await alice.$('.gif-picker .gif-btn').first().click();
  await bob.page.waitForFunction(() => [...document.querySelectorAll('#messages .embed-img')].some((i) => /\/uploads\/\w+\.gif$/.test(i.src) && i.complete && i.naturalWidth > 0));
}

// ------------------------------------------------------------------ 6. search (Ctrl+K)
async function search(t) {
  const { alice, bob } = t.people;
  await alice.send('A searchable zebra crossing from alice');
  await bob.send('A zebra note from bob');
  await alice.message('zebra note from bob').waitFor();
  // From a fresh page and from Home, so the server-side pages are what's searched, not just what's loaded.
  await bob.page.reload();
  await bob.waitApp();
  await bob.railButton('Home');
  await bob.page.keyboard.press('Control+k');
  const input = bob.$('.search-modal input.search-main');
  await input.waitFor();
  await input.fill('zebra');
  await bob.$('.search-modal .search-status', { hasText: 'Checked all' }).waitFor();
  await bob.page.waitForFunction(() => document.querySelectorAll('.search-modal .search-msg').length === 2);
  await input.fill('from:@alice zebra');
  await bob.$('.search-modal .search-chips', { hasText: 'From alice' }).waitFor();
  await bob.page.waitForFunction(() => {
    const hits = [...document.querySelectorAll('.search-modal .search-msg')];
    return hits.length === 1 && /zebra crossing from alice/.test(hits[0].textContent);
  });
  // Opening the result jumps to it in its channel.
  await bob.$('.search-modal .search-msg').click();
  await bob.page.waitForSelector('.search-modal', { state: 'detached' });
  await bob.page.waitForSelector('#composer-input[placeholder="Message #general"]');
  const hit = bob.message('zebra crossing from alice').first();
  await hit.waitFor();
  // (It scrolls there smoothly, so wait for it to arrive.)
  await bob.page.waitForFunction((id) => {
    const el = document.querySelector(`#messages [data-mid="${id}"]`);
    const r = el.getBoundingClientRect(); const box = document.querySelector('#messages').getBoundingClientRect();
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  }, await hit.getAttribute('data-mid'));

  // A reply inside a thread: found too, and opening it opens its thread.
  await bob.page.keyboard.press('Control+k');
  await bob.$('.search-modal input.search-main').fill('mangoes');
  const reply = bob.$('.search-modal .search-msg', { hasText: 'thread reply about mangoes' });
  await reply.locator('.search-badge', { hasText: 'In a thread' }).waitFor();
  await reply.click();
  await bob.message('A thread reply about mangoes', '.thread-list').waitFor();
}

// ------------------------------------------------------------------ 7. account settings and signed-in devices
async function settings(t) {
  const { alice, bob } = t.people;
  await alice.openSettings('Security');
  await alice.$('.set-content .kv', { hasText: 'Display name' }).locator('button', { hasText: 'Change' }).click();
  const dn = await alice.dialog('Change your display name');
  await dn.locator('input').fill('Alice Wonder');
  await dn.locator('.modal-foot .btn.primary').click();
  await alice.$('.set-content .kv', { hasText: 'Display name' }).locator('strong', { hasText: 'Alice Wonder' }).waitFor();
  await bob.showMembers();
  await bob.member('Alice Wonder').waitFor();

  // A new username needs the password.
  await alice.$('.set-content .kv', { hasText: 'Username' }).locator('button', { hasText: 'Change' }).click();
  const un = await alice.dialog('Change your username');
  await un.locator('input').fill('alice_w');
  await un.locator('.modal-foot .btn.primary').click();
  await alice.confirmPassword('Confirm it', t.pw.alice);
  await alice.$('.set-content .kv', { hasText: 'Username' }).locator('strong', { hasText: exact('alice_w') }).waitFor();
  await alice.closeSettings();

  // A second device signs in with the new name, then the first one signs it out from Signed-in devices.
  const laptop = await t.open('alice-laptop');
  await laptop.login('alice_w', t.pw.alice);
  await alice.openSettings('Security', 'Signed-in devices');
  await alice.$('.session-row', { hasText: 'This device' }).waitFor();
  const other = alice.$('.session-row:not(.ended)').filter({ hasNotText: 'This device' });
  await other.waitFor();
  check(await other.count() === 1, 'Exactly one other device should be signed in.');
  await other.locator('button', { hasText: 'Revoke' }).click();
  await alice.toast('Signed out of that device.');
  await laptop.page.waitForSelector('#login-form:not([hidden])');
  await laptop.$('#login-form .form-error', { hasText: 'This device was signed out' }).waitFor();
  await laptop.close();
  delete t.people['alice-laptop'];
  await alice.$('.session-row.ended').first().waitFor();
  await alice.closeSettings();
}

// ------------------------------------------------------------------ 8. roles, private channels, overrides
async function roles(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await bob.railButton(SERVER);
  // A channel made private is hidden from bob, messages and all.
  await alice.serverMenu('Create channel');
  const cc = await alice.dialog('Create channel');
  await cc.locator('.field', { hasText: 'Channel name' }).locator('input').fill('staff-room');
  await cc.locator('.modal-foot .btn.primary').click();
  await alice.page.waitForSelector('#composer-input[placeholder="Message #staff-room"]');
  await bob.channelRow('staff-room').waitFor();
  await alice.channelRow('staff-room').locator('.ch-main').click({ button: 'right' });
  await alice.menuItem('Make private').click();
  const perms = await alice.dialog('staff-room');
  await perms.waitFor();
  await bob.channelRow('staff-room').waitFor({ state: 'detached' });
  // The overrides editor: let bob in by name.
  const add = perms.locator('select[aria-label="Add a role or member"]');
  const bobOption = await add.locator('option', { hasText: 'bob' }).getAttribute('value');
  await add.selectOption(bobOption);
  await perms.locator('.ov-perms .ov-row', { hasText: 'View channels' }).locator('.tri-btn.allow').click();
  await perms.locator('.modal-foot .btn.primary', { hasText: 'Save' }).click();
  await alice.toast('Channel saved.');
  await alice.noModals();
  await alice.send('Staff only: kumquat');
  await bob.channelRow('staff-room').waitFor();
  await bob.openChannel('staff-room');
  await bob.message('Staff only: kumquat').waitFor();

  // A role with Manage channels, given to bob, lets him make channels.
  check(!(await bob.page.locator('#sidebar-body button[aria-label^="Create channel in"]').count()), 'Bob should not manage channels before getting the role.');
  await alice.serverMenu('Roles');
  const ss = alice.page.locator('.modal.server-settings');
  await ss.locator('button', { hasText: 'Create role' }).click();
  await ss.locator('.role-editor-head', { hasText: 'new role' }).waitFor();
  await ss.locator('.role-editor .field', { hasText: 'Role name' }).locator('input').fill('Keepers');
  await ss.locator('.perm-groups .toggle-row').filter({ has: alice.page.locator('.toggle-label', { hasText: exact('Manage channels') }) }).locator('.switch').click();
  await ss.locator('.role-actions .btn.primary', { hasText: 'Save changes' }).click();
  await alice.toast('Role saved.');
  await ss.locator('.role-list .role-name', { hasText: exact('Keepers') }).waitFor();
  const pick = ss.locator('select[aria-label="Add member to role"]');
  await pick.selectOption(await pick.locator('option', { hasText: 'bob' }).getAttribute('value'));
  await ss.locator('.role-members .chip', { hasText: 'bob' }).waitFor();
  await ss.locator('.modal-x').click();
  await alice.noModals();
  await bob.serverMenu('Create channel');
  const bc = await bob.dialog('Create channel');
  await bc.locator('.field', { hasText: 'Channel name' }).locator('input').fill('bob-made');
  await bc.locator('.modal-foot .btn.primary').click();
  await alice.channelRow('bob-made').waitFor();
}

// ------------------------------------------------------------------ 9. roles members pick themselves
// Alice marks a role "Members can pick this role themselves" (the editor won't while it has a moderator power) and
// lets it into a private channel; bob picks it from the server menu and the channel opens for him, then drops it
// from the start of a channel and the channel goes again.
async function selfRoles(t) {
  const { alice, bob } = t.people;
  // Nothing to pick yet: the start of bob's channel doesn't offer it.
  await bob.openChannel('bob-made');
  const welcomeBtn = () => bob.$('#messages .welcome button', { hasText: 'Pick your roles' });
  check(!(await welcomeBtn().count()), 'Nothing to pick yet, so the channel start should not offer it.');
  await alice.serverMenu('Roles');
  const ss = alice.page.locator('.modal.server-settings');
  await ss.locator('button', { hasText: 'Create role' }).click();
  await ss.locator('.role-editor-head', { hasText: 'new role' }).waitFor();
  await ss.locator('.role-editor .field', { hasText: 'Role name' }).locator('input').fill('game-night');
  const selfRow = () => ss.locator('.role-editor .toggle-row', { hasText: 'Members can pick this role themselves' });
  const permRow = (name) => ss.locator('.perm-groups .toggle-row').filter({ has: alice.page.locator('.toggle-label', { hasText: exact(name) }) });
  // It sits above Keepers, but Keepers only manages channels, which doesn't reach anyone: it can be offered.
  await selfRow().locator('.field-hint', { hasText: 'Pick your roles' }).waitFor();
  // Ticking a moderator power turns the option off, and says why.
  await permRow('Kick members').locator('.switch').click();
  await selfRow().locator('.field-hint', { hasText: 'moderator powers' }).waitFor();
  check(await selfRow().locator('input').isDisabled(), 'A role with Kick members should not be offered to members.');
  await permRow('Kick members').locator('.switch').click();
  await selfRow().locator('.field-hint', { hasText: 'Pick your roles' }).waitFor();
  await selfRow().locator('.switch').click();
  await ss.locator('.role-actions .btn.primary', { hasText: 'Save changes' }).click();
  await alice.toast('Role saved.');
  await ss.locator('.modal-x').click();
  await alice.noModals();
  // Bob's open channel offers it as soon as it's marked.
  await welcomeBtn().waitFor();
  // #game-night: only the role sees it.
  await alice.serverMenu('Create channel');
  const cc = await alice.dialog('Create channel');
  await cc.locator('.field', { hasText: 'Channel name' }).locator('input').fill('game-night');
  await cc.locator('.modal-foot .btn.primary').click();
  await alice.page.waitForSelector('#composer-input[placeholder="Message #game-night"]');
  await alice.channelRow('game-night').locator('.ch-main').click({ button: 'right' });
  await alice.menuItem('Make private').click();
  const perms = await alice.dialog('game-night');
  const add = perms.locator('select[aria-label="Add a role or member"]');
  await add.selectOption(await add.locator('option', { hasText: 'game-night' }).getAttribute('value'));
  await perms.locator('.ov-perms .ov-row', { hasText: 'View channels' }).locator('.tri-btn.allow').click();
  await perms.locator('.modal-foot .btn.primary', { hasText: 'Save' }).click();
  await alice.toast('Channel saved.');
  await alice.noModals();
  await alice.send('Board games on Friday: plum');
  await bob.channelRow('game-night').waitFor({ state: 'detached' });

  await bob.serverMenu('Pick your roles');
  let picker = await bob.dialog('Pick your roles');
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('.switch').click();
  await bob.channelRow('game-night').waitFor();
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('input:checked').waitFor();
  await picker.locator('.modal-x').click();
  await bob.noModals();
  await bob.openChannel('game-night');
  await bob.message('Board games on Friday: plum').waitFor();
  check(!(await bob.$('#messages .msg-text.undecryptable').count()), 'Bob should read #game-night with the server key he already has.');
  // The start of a channel offers the same window.
  await bob.$('#messages .welcome button', { hasText: 'Pick your roles' }).click();
  picker = await bob.dialog('Pick your roles');
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('.switch').click();
  await bob.channelRow('game-night').waitFor({ state: 'detached' });
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('input:not(:checked)').waitFor();
  await picker.locator('.modal-x').click();
  await bob.noModals();
}

// ------------------------------------------------------------------ 9b. a weekly event
async function events(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await bob.railButton(SERVER);
  await alice.$('#sidebar-body .ev-row').click();
  const list = await alice.dialog(`Events in ${SERVER}`);
  await list.locator('button', { hasText: 'Plan an event' }).click();
  const ed = await alice.dialog('Plan an event');
  await ed.locator('.field', { hasText: 'Name' }).locator('input').fill('Board game night');
  await ed.locator('.field', { hasText: 'Repeats' }).locator('select').selectOption('weekly');
  // The editor says what that means: same weekday and time, on this person's clock, which everyone can see.
  await ed.locator('.field-hint', { hasText: /^Every \w+day at .* time, also after the clocks change\. Everyone in the server sees this time zone/ }).waitFor();
  await ed.locator('.field', { hasText: 'Ends' }).locator('select').selectOption('count');
  await ed.locator('.field', { hasText: 'How many times' }).locator('input').fill('6');
  await ed.locator('.modal-foot .btn.primary', { hasText: 'Create event' }).click();
  await alice.toast('Event created.');
  await list.locator('.ev-card', { hasText: 'Board game night' }).locator('.ev-repeat', { hasText: 'Every week · 6 times left' }).waitFor();
  await list.locator('.modal-x').click();
  await alice.noModals();
  // Bob's sidebar shows it live, with how often it happens; he says he's going.
  const row = bob.$('#sidebar-body .ev-row', { hasText: 'Board game night' });
  await row.locator('small', { hasText: 'every week' }).waitFor();
  await row.click();
  const bl = await bob.dialog(`Events in ${SERVER}`);
  const card = bl.locator('.ev-card', { hasText: 'Board game night' });
  await card.locator('.chip', { hasText: exact('Going') }).click();
  await card.locator('.ev-count', { hasText: '2 going' }).waitFor();
  await bl.locator('.modal-x').click();
  await bob.noModals();
  // Alice stops it repeating (edits apply to this time and every later one); bob's copy updates.
  await alice.$('#sidebar-body .ev-row').click();
  const al = await alice.dialog(`Events in ${SERVER}`);
  await al.locator('.ev-card', { hasText: 'Board game night' }).locator('button[aria-label="More"]').click();
  await alice.menuItem('Edit').click();
  const edit = await alice.dialog('Edit repeating event');
  await edit.locator('.field', { hasText: 'Repeats' }).locator('select').selectOption('none');
  await edit.locator('.modal-foot .btn.primary', { hasText: 'Save' }).click();
  await alice.toast('Event updated.');
  await al.locator('.ev-card', { hasText: 'Board game night' }).locator('.ev-repeat').waitFor({ state: 'detached' });
  check(await al.locator('.ev-card', { hasText: 'Board game night' }).locator('.ev-count', { hasText: '2 going' }).count() === 1, 'Editing should keep the answers people gave.');
  await al.locator('.modal-x').click();
  await alice.noModals();
  await bob.$('#sidebar-body .ev-row', { hasText: 'Board game night' }).locator('small', { hasText: 'every week' }).waitFor({ state: 'detached' });
}

// ------------------------------------------------------------------ 10 + 11. a voice call, and watching together in it
async function voiceCall(t) {
  const { alice, bob } = t.people;
  await alice.channelRow('Lounge').locator('.ch-main').click();
  await alice.$('.voice-room .cs-tile', { hasText: 'Alice Wonder' }).waitFor();
  await bob.channelRow('Lounge').locator('.ch-main').click();
  for (const [me, them] of [[alice, 'bob'], [bob, 'Alice Wonder']]) {
    await me.$('.voice-room .cs-tile', { hasText: them }).waitFor();
    // A real connection between the two browsers (audio from the fake microphone).
    await me.page.waitForFunction(() => (window.__e2ePeers || []).some((pc) => pc.connectionState === 'connected'), null, { timeout: 30000 });
    await me.$('.voice-room .cs-tile .cs-conn').waitFor({ state: 'detached' });
    await me.$('#voice-panel .vp-status[data-call-state="connected"]').waitFor(); // the call engine's own state, not its wording
  }
}

// ------------------------------------------------------------------ moderator toolkit: server mute in and out of a call, bulk delete
async function moderatorTools(t) {
  const { alice, bob } = t.people;
  const bobInCall = () => alice.$('#sidebar-body .vc-user', { hasText: 'bob' });
  // Server mute from the voice channel's list: bob's app is told and keeps his mic off; alice sees him marked.
  await bobInCall().click({ button: 'right' });
  await alice.menuItem('Server mute').click();
  await bob.toast('A moderator muted you in this server');
  await bobInCall().locator('.server-muted').waitFor();
  await bob.$('#voice-panel button[aria-label="Unmute"]').click();
  await bob.toast('You can listen, but not talk');
  // The mute outlasts the call, and a moderator can still see and lift it from the member list once he's gone.
  await bob.$('#voice-panel button[aria-label="Leave call"]').click();
  await bobInCall().waitFor({ state: 'detached' });
  await alice.openChannel('general');
  await bob.openChannel('general');
  await alice.member('bob').click({ button: 'right' });
  await alice.menuItem('Remove server mute').click();
  await alice.toast('bob can talk again.');
  // Bulk delete: pick two messages and delete them for everyone at once.
  await alice.send('Spam number one');
  await alice.send('Spam number two');
  await bob.message('Spam number two').waitFor();
  // Esc stops picking, even with focus on the bar's own buttons.
  await alice.messageAction('Spam number one', 'Select messages to delete…');
  await alice.$('#select-bar button', { hasText: 'Cancel' }).focus();
  await alice.page.keyboard.press('Escape');
  await alice.$('#select-bar').waitFor({ state: 'hidden' });
  await alice.messageAction('Spam number one', 'Select messages to delete…');
  await alice.message('Spam number two').locator('.msg-select').check();
  await alice.$('#select-bar button', { hasText: 'Delete 2' }).click();
  await alice.modal('Delete 2 messages?').locator('.modal-foot .btn.danger').click();
  await alice.toast('Deleted 2 messages.');
  for (const p of [alice, bob]) await p.message('Spam number').first().waitFor({ state: 'detached' });
  check(!(await alice.$('#select-bar:not([hidden])').count()), 'Picking messages should end once they are deleted.');
  // Back to the call for the next flow.
  for (const p of [alice, bob]) { await p.channelRow('Lounge').locator('.ch-main').click(); await p.$('.voice-room .cs-controls').waitFor(); }
}

async function watchTogether(t) {
  const { alice, bob } = t.people;
  await alice.$('.voice-room .cs-controls button[aria-label="Watch together"]').click();
  const m = await alice.dialog('Watch together');
  await m.locator('input.input').fill(`${t.server.base}/e2e-clip.webm`);
  await m.locator('.modal-foot .btn.primary').click();
  for (const p of [alice, bob]) await p.$('.wt-title', { hasText: 'e2e-clip.webm' }).first().waitFor();
  // Pausing on one side pauses it for everyone.
  await bob.$('.wt-controls button[aria-label="Pause for everyone"]').first().click();
  await alice.$('.wt-controls button[aria-label="Play for everyone"]').first().waitFor();
  await alice.$('.wt-actions button', { hasText: 'Stop' }).first().click();
  for (const p of [alice, bob]) await p.$('.wt-title').first().waitFor({ state: 'detached' });

  // A video file on another site: each viewer is told that site will see their IP address, and it loads only
  // when they choose to (the harness refuses outside requests, so here it then fails to play, which is fine).
  const outsideHost = 'videos.outside-site.test';
  const asked = [];
  const onRequest = (r) => { if (r.url().includes(outsideHost)) asked.push(r.url()); };
  bob.page.on('request', onRequest);
  try {
    await alice.$('.voice-room .cs-controls button[aria-label="Watch together"]').click();
    const m2 = await alice.dialog('Watch together');
    await m2.locator('input.input').fill(`https://${outsideHost}/trailer.webm`);
    await m2.locator('.modal-foot .btn.primary').click();
    for (const p of [alice, bob]) await p.$('.wt-outside', { hasText: `This video comes from ${outsideHost}, which will see your IP address.` }).first().waitFor();
    check(!asked.length, `Nothing should be fetched from ${outsideHost} before Bob agrees (fetched ${asked.join(', ')}).`);
    const req = bob.page.waitForRequest((r) => r.url().includes(outsideHost));
    await bob.$('.wt-outside button', { hasText: 'Load video' }).first().click();
    await req;
    await bob.$('.wt-outside').first().waitFor({ state: 'detached' });
    check(await bob.page.evaluate(() => !!document.activeElement && document.activeElement.matches('video.wt-frame')), 'After Load video, keyboard focus should be on the player, not lost to the page.');
    check(await alice.$('.wt-outside').first().isVisible(), 'Alice\'s choice is her own: her notice stays until she clicks.');
  } finally { bob.page.off('request', onRequest); }
  await alice.$('.wt-actions button', { hasText: 'Stop' }).first().click();
  for (const p of [alice, bob]) await p.$('.wt-title').first().waitFor({ state: 'detached' });

  // Leaving: bob first (alice sees him go), then alice from the call bar.
  await bob.$('.voice-room .cs-controls button[aria-label="Leave call"]').click();
  await alice.$('.voice-room .cs-tile', { hasText: 'bob' }).waitFor({ state: 'detached' });
  await alice.$('#voice-panel button[aria-label="Leave call"]').click();
  await alice.page.waitForSelector('#voice-panel', { state: 'hidden' });
  await bob.page.waitForSelector('#voice-panel', { state: 'hidden' });
}

// ------------------------------------------------------------------ the server's own audit log and report inbox
async function auditAndReports(t) {
  const { alice, bob } = t.people;
  await alice.openChannel('general');
  await bob.openChannel('general');
  // Alice (the owner) reads what happened in her server, as sentences: the moderator toolkit's bulk delete and
  // server mute, and bob picking a role himself.
  await alice.serverMenu('Server settings');
  const ss = alice.page.locator('.modal.server-settings');
  await ss.locator('.ss-tab', { hasText: exact('Audit log') }).click();
  const row = (text) => ss.locator('.audit-row', { hasText: text });
  await row('deleted 2 messages at once in #general').waitFor();
  await row(/server-muted bob/).first().waitFor();
  await row('bob picked the role “game-night”').first().waitFor();
  // Filtered to voice, the message entries go.
  await ss.locator('select[aria-label="Show"]').selectOption({ label: 'Voice' });
  await row('deleted 2 messages').waitFor({ state: 'detached' });
  await row(/server-muted bob/).first().waitFor();
  await ss.locator('select[aria-label="Show"]').selectOption({ label: 'Everything' });
  await row('deleted 2 messages at once in #general').waitFor();
  // Filtered to one person (typed, as for someone who's no longer a member): only what they did or had done to them.
  const person = ss.locator('input[aria-label="Done by or to"]');
  await person.fill('bob');
  await person.press('Enter');
  await row('deleted 2 messages').waitFor({ state: 'detached' });
  await row(/server-muted bob/).first().waitFor();
  await person.fill('');
  await row('deleted 2 messages at once in #general').waitFor();
  // While it's open, a new entry appears by itself: bob picks the role again (and drops it, as it was).
  const picks = () => alice.page.evaluate(() => [...document.querySelectorAll('.modal.server-settings .audit-row')].filter((r) => r.textContent.includes('bob picked the role')).length);
  const before = await picks();
  await bob.serverMenu('Pick your roles');
  const picker = await bob.dialog('Pick your roles');
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('.switch').click();
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('input:checked').waitFor();
  await alice.page.waitForFunction((n) => [...document.querySelectorAll('.modal.server-settings .audit-row')].filter((r) => r.textContent.includes('bob picked the role')).length > n, before, { timeout: 15000 });
  check(await picks() === before + 1, 'The new entry should appear once.');
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('.switch').click();
  await picker.locator('.pick-role', { hasText: 'game-night' }).locator('input:not(:checked)').waitFor();
  await picker.locator('.modal-x').click();
  await bob.noModals();
  await ss.locator('.modal-x').click();
  await alice.noModals();

  // A reported message reaches the server's moderators too (here the owner), without saying who reported it.
  await bob.send('Rude remark about kumquats');
  await alice.message('Rude remark about kumquats').waitFor();
  await alice.messageAction('Rude remark about kumquats', 'Report message');
  const rep = await alice.dialog('Report message');
  await rep.locator('.radio-card', { hasText: 'Harassment or bullying' }).click();
  const share = rep.locator('.tos-check', { hasText: `Also show it to the moderators of ${SERVER}` }).locator('input');
  check(await share.isChecked(), 'Sharing with the server’s moderators should be on by default.');
  await rep.locator('.modal-foot .btn.danger', { hasText: 'Send report' }).click();
  await alice.toast(`New report in ${SERVER}`);
  // The app offers to block bob afterwards: not now.
  const block = await alice.dialog('Block bob?');
  await block.locator('.modal-foot button', { hasText: 'Cancel' }).click();
  await alice.noModals();
  await alice.serverMenu('Server settings');
  await ss.locator('.ss-tab', { hasText: exact('Reports') }).click();
  const card = ss.locator('.report-card', { hasText: 'Harassment or bullying' });
  await card.locator('.ev.reported', { hasText: 'Rude remark about kumquats' }).waitFor();
  await card.locator('button', { hasText: 'Mark handled' }).click();
  const note = await alice.dialog('Mark as handled');
  await note.locator('input').fill('Talked to bob');
  await note.locator('.modal-foot .btn.primary').click();
  await alice.toast('Marked as handled.');
  await ss.locator('.panel-empty', { hasText: 'No open reports.' }).waitFor();
  // Who handled it stays on the report (not in the audit log, where the person reported might read it).
  await ss.locator('.seg-btn', { hasText: exact('Handled') }).click();
  await ss.locator('.report-card .stat-sub', { hasText: /Note: Talked to bob — Handled by / }).waitFor();
  await ss.locator('.modal-x').click();
  await alice.noModals();
  // Alice also runs this Hearth: staff still have the report open, see what the server's moderators did, and close
  // their own copy.
  await alice.railButton('Admin');
  await alice.$('.admin-tabs .admin-tab', { hasText: 'Reports' }).click();
  const staffCard = alice.$('.admin-body .report-card', { hasText: 'Rude remark about kumquats' });
  await staffCard.locator('.stat-sub', { hasText: 'The server’s moderators have it too: handled' }).waitFor();
  await staffCard.locator('button', { hasText: exact('Resolve') }).click();
  await (await alice.dialog('Resolve report')).locator('.modal-foot .btn.primary').click();
  await alice.toast('Resolved.');
  await alice.$('.admin-body .panel-empty', { hasText: 'No open reports' }).waitFor();
  await alice.railButton(SERVER);
}

// ------------------------------------------------------------------ a 1-to-1 call from a DM: ring, accept, hang up, decline
const connected = (p) => p.page.waitForFunction(() => (window.__e2ePeers || []).some((pc) => pc.connectionState === 'connected'), null, { timeout: 30000 });
async function dmCall(t) {
  const { alice, bob } = t.people;
  const openDmWith = async (p, who) => {
    await p.railButton('Direct messages');
    await p.dmRow(who).click();
    await p.page.waitForSelector(`#composer-input[placeholder="Message ${who}"]`);
  };
  await openDmWith(alice, 'bob');
  await alice.$('#main-head button[aria-label="Start a voice call"]').click();
  await bob.$('.ring-card', { hasText: 'Alice Wonder' }).waitFor();
  await bob.$('.ring-card button[aria-label="Accept"]').click();
  for (const p of [alice, bob]) {
    await connected(p);
    await p.$('#voice-panel .vp-status[data-call-state="connected"]').waitFor(); // the call engine's own state, not its wording
  }
  // Bob hangs up: a 1-to-1 call ends for alice too.
  await bob.$('#voice-panel button[aria-label="Leave call"]').click();
  await alice.toast('Call ended.');
  await alice.page.waitForSelector('#voice-panel', { state: 'hidden' });
  // Calling again and being turned down.
  await alice.$('#main-head button[aria-label="Start a voice call"]').click();
  await bob.$('.ring-card button[aria-label="Decline"]').click();
  await alice.toast('bob declined the call.');
  await alice.page.waitForSelector('#voice-panel', { state: 'hidden' });
  await bob.$('.ring-card').waitFor({ state: 'detached' });
}

// ------------------------------------------------------------------ a group chat: create, talk, call
async function groupChat(t) {
  const { alice, bob } = t.people;
  await alice.railButton('Direct messages');
  await alice.$('#sidebar-body button[aria-label="New message or group chat"]').click();
  await alice.menuItem('New group chat').click();
  const m = await alice.dialog('New group chat');
  await m.locator('.field', { hasText: 'Group name' }).locator('input').fill('Fruit Club');
  await m.locator('.quick-row', { hasText: 'bob' }).click();
  await m.locator('.modal-foot .btn.primary', { hasText: 'Create group chat' }).click();
  await alice.page.waitForSelector('#composer-input[placeholder="Message Fruit Club"]');
  await alice.send('Group hello: cherry');
  await bob.railButton('Direct messages');
  await bob.dmRow('Fruit Club').click();
  await bob.message('Group hello: cherry').waitFor();
  check(!(await bob.$('#messages .msg-text.undecryptable').count()), 'Bob should read the group chat.');
  await bob.send('Group reply: date');
  await alice.message('Group reply: date').waitFor();
  // The group's call rings the others.
  await bob.$('#main-head button', { hasText: exact('Call') }).click();
  await alice.$('.ring-card', { hasText: 'bob' }).waitFor();
  await alice.$('.ring-card button[aria-label="Accept"]').click();
  for (const p of [alice, bob]) await connected(p);
  for (const p of [alice, bob]) {
    await p.$('#main-head button', { hasText: 'Leave call' }).click();
    await p.page.waitForSelector('#voice-panel', { state: 'hidden' });
  }
}

// ------------------------------------------------------------------ the Android app, with its native half simulated
// The page as the Hearth Android app shows it. window.HearthAndroid stands in for the app (MainActivity and the
// UnifiedPush push app): what the page sends it is recorded, and it answers the way the app does. The push
// address it hands out isn't a real push service, so /api/push/subscribe is answered here and only what the
// page sends is checked (the server's side has its own tests in test/android-push.test.js).
function fakeAndroidBridge({ invite }) {
  if (window.HearthAndroid) return;
  // Kept across reloads (signing out reloads the page).
  const log = () => JSON.parse(sessionStorage.getItem('e2e.sent') || '[]');
  Object.defineProperty(window, '__androidSent', { get: log });
  const b64u = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  let n = 0;
  let st = { type: 'pushState', state: 'none', reason: '', vapid: '', endpoint: '', distributor: '', distributorName: '', distributors: 1 };
  const bridge = {
    onmessage: null,
    postMessage(raw) {
      const m = JSON.parse(raw);
      sessionStorage.setItem('e2e.sent', JSON.stringify([...log(), m]));
      const reply = (o) => setTimeout(() => bridge.onmessage && bridge.onmessage({ data: JSON.stringify(o) }), 5);
      if (m.type === 'hello') {
        // An invite link the app was opened with, handed over once (as the app does).
        const give = invite && !sessionStorage.getItem('e2e.invited');
        if (give) sessionStorage.setItem('e2e.invited', '1');
        reply({ type: 'info', version: '1.29.0', notify: 'granted', server: location.origin, call: true, push: { ...st }, ...(give ? { invite } : {}) });
      } else if (m.type === 'pushState') reply({ ...st });
      else if (m.type === 'pushRegister' || m.type === 'pushPick') {
        st = { ...st, state: 'pending', reason: '', vapid: String(m.vapid || '').replace(/=+$/, '') };
        reply({ ...st });
        n++;
        // The push app answers a moment later with a new address and this phone's public keys.
        setTimeout(() => {
          st = { ...st, state: 'registered', endpoint: `https://ntfy.example.test/upE2e${n}${b64u(6)}?up=1`, p256dh: 'B' + b64u(66).slice(0, 86), auth: b64u(16), distributor: 'io.heckel.ntfy', distributorName: 'ntfy' };
          window.dispatchEvent(new CustomEvent('hearth-push', { detail: { ...st } }));
        }, 60);
      } else if (m.type === 'pushUnregister') {
        // Like the UnifiedPush library: unregistering the last registration forgets the push app too.
        st = { ...st, state: 'none', endpoint: '', p256dh: '', auth: '', distributor: '', distributorName: '' };
        reply({ ...st });
      }
    },
  };
  window.HearthAndroid = bridge;
}
async function androidApp(t) {
  const code = t.state.invite.split('/invite/')[1];
  const droid = await t.open('droid');
  await droid.register('droid', newPassword());
  const subs = [];
  await droid.page.route('**/api/push/subscribe', (route) => { subs.push(route.request().postDataJSON()); route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await droid.context.addInitScript(fakeAndroidBridge, { invite: code });
  await droid.page.reload();
  await droid.waitApp();
  const sent = (type) => droid.page.evaluate((ty) => window.__androidSent.filter((m) => m.type === ty), type);
  check((await sent('hello')).some((m) => m.v === 2), 'The page should tell the app it takes notification taps and invites in place.');

  // The invite link the app was opened with: the "Join a server" box, without leaving the page.
  const join = await droid.dialog('Join a server');
  await join.locator('.invite-preview strong', { hasText: 'E2E Hall' }).waitFor();
  await join.locator('.modal-foot .btn.primary').click();
  await droid.page.locator('#sidebar-head .server-head-name', { hasText: exact('E2E Hall') }).waitFor();
  await droid.noModals();

  // Offered once: notifications when Hearth is closed. The app registers with the server's key; the page
  // subscribes the address it hands back.
  const { publicKey } = await droid.page.evaluate(() => fetch('/api/push/key').then((r) => r.json()));
  await droid.$('.push-offer button', { hasText: 'Turn on' }).click();
  await droid.toast('Notifications are on, even when Hearth is closed.');
  const reg = await sent('pushRegister');
  check(reg.length === 1 && reg[0].vapid === publicKey, 'The app should be asked to register with this server\u2019s VAPID key.');
  check(subs.length === 1 && /^https:\/\/ntfy\.example\.test\/upE2e1/.test(subs[0].subscription.endpoint) && subs[0].subscription.keys.auth && !subs[0].replaces,
    `The page should subscribe the app's push address (got ${JSON.stringify(subs[0])}).`);

  // Settings: on, through ntfy; picking the push app again gives a new address, which replaces the old one.
  await droid.openSettings('Apps & devices');
  const row = droid.$('.set-content .toggle-row', { hasText: 'Notifications when Hearth is closed' });
  await row.waitFor();
  const pushIs = (on) => droid.page.waitForFunction((want) => { const r = [...document.querySelectorAll('.set-content .toggle-row')].find((x) => /when Hearth is closed/.test(x.textContent)); return r && !r.querySelector('input').disabled && r.querySelector('input').checked === want; }, on);
  const change = () => droid.$('.set-content button', { hasText: exact('Change') });
  await pushIs(true);
  await droid.$('.set-content .muted-p', { hasText: 'Push app: ntfy' }).waitFor();
  await change().click();
  await droid.toast('Notifications now come through the push app you picked.');
  check((await sent('pushPick')).length === 1, 'Change should ask the app to show the list of push apps.');
  check(subs.length === 2 && subs[1].replaces === subs[0].subscription.endpoint && subs[1].subscription.endpoint !== subs[0].subscription.endpoint,
    'The new push address should replace the old one on the server.');
  // Turning it off takes the push app row (and Change, which would turn push back on) away at once; turning it
  // on again brings them back, without reopening Settings.
  await row.locator('.switch').click();
  await droid.toast('Notifications when Hearth is closed are off.');
  await pushIs(false);
  await change().waitFor({ state: 'detached' });
  check(!(await droid.$('.set-content .muted-p', { hasText: 'Push app:' }).count()), 'With push off, no push app should be shown.');
  await row.locator('.switch').click();
  await droid.toast('Notifications are on, even when Hearth is closed.');
  await pushIs(true);
  await change().waitFor();
  check((await sent('pushPick')).length === 1 && subs.length === 3, 'Turning push on again registers once, without the list of push apps.');
  await droid.closeSettings();

  // A call starts the app's call notification (it keeps the call going with the screen off). Android shows it on
  // the lock screen too, so it says only "In a call" until the person chooses to show who and where.
  const callStarts = () => droid.page.evaluate(() => window.__androidSent.filter((m) => m.type === 'callStart'));
  await droid.channelRow('Lounge').locator('.ch-main').click();
  await droid.$('#voice-panel').waitFor();
  await droid.page.waitForFunction(() => window.__androidSent.some((m) => m.type === 'callStart' && m.title === 'In a call'));
  check(!(await callStarts()).some((m) => /Lounge/.test(m.title)), 'The call notification should not name the channel by default.');
  await droid.openSettings('Notifications');
  await droid.$('.set-content .toggle-row', { hasText: 'Show who and where on the lock screen' }).locator('.switch').click();
  await droid.toast('Push notifications now show the sender and conversation.');
  await droid.page.waitForFunction(() => window.__androidSent.some((m) => m.type === 'callStart' && /Lounge/.test(m.title)));
  await droid.closeSettings();
  // Its Hang up button leaves the call, which stops it again.
  await droid.page.evaluate(() => window.dispatchEvent(new CustomEvent('hearth-hangup', { detail: true })));
  await droid.page.waitForSelector('#voice-panel', { state: 'hidden' });
  await droid.page.waitForFunction(() => window.__androidSent.some((m) => m.type === 'callEnd'));
  // Reloading the page in a call (the "Reload now" after an update, say) ends the call, and the notification too.
  const startsBefore = (await callStarts()).length;
  const endsBefore = (await sent('callEnd')).length;
  await droid.$('.cs-controls .btn.primary', { hasText: exact('Join call') }).click(); // still looking at the Lounge
  await droid.$('#voice-panel').waitFor();
  await droid.page.waitForFunction((n) => window.__androidSent.filter((m) => m.type === 'callStart').length > n, startsBefore);
  await droid.page.reload();
  await droid.waitApp();
  check((await sent('callEnd')).length === endsBefore + 1, 'Leaving the page during a call should end the app\u2019s call notification.');

  // A #call/ link to a server's voice channel (which anyone can post) opens the server but never shows an
  // "incoming call" from whoever is sitting in it: only DM and group calls ring.
  const { alice } = t.people;
  await alice.railButton(SERVER);
  await alice.channelRow('Lounge').locator('.ch-main').click();
  await alice.$('#voice-panel').waitFor();
  await droid.railButton(SERVER);
  await droid.$('#sidebar-body .vc-user', { hasText: 'Alice Wonder' }).waitFor();
  const lounge = await droid.page.evaluate(() => fetch('/api/bootstrap', { headers: { Authorization: 'Bearer ' + localStorage.getItem('hearth.token') } })
    .then((r) => r.json()).then((b) => b.servers.flatMap((x) => x.channels).find((c) => c.type === 'voice' && c.name === 'Lounge').id));
  await droid.railButton('Direct messages');
  await droid.page.evaluate((id) => { location.hash = '#call/' + id; }, lounge);
  await droid.page.waitForSelector('#composer-input[placeholder="Message #general"]');
  await droid.page.waitForTimeout(800);
  check(!(await droid.$('.ring-card').count()), 'A #call/ link to a server voice channel must not ring.');
  await alice.$('#voice-panel button[aria-label="Leave call"]').click();
  await alice.page.waitForSelector('#voice-panel', { state: 'hidden' });

  // A tapped notification opens only places inside the app.
  await droid.page.evaluate(() => window.dispatchEvent(new CustomEvent('hearth-open', { detail: 'https://evil.example/' })));
  check(droid.page.url().startsWith(t.server.base), 'A notification must never take the app to another site.');
  await droid.page.evaluate(() => window.dispatchEvent(new CustomEvent('hearth-open', { detail: '/#d/zzzzzz' })));
  await droid.toast('That conversation isn\u2019t available.');

  // Signing out removes the phone's push registration, and push isn't "off by choice" for the next person.
  const unregBefore = (await sent('pushUnregister')).length;
  await droid.logout();
  check((await sent('pushUnregister')).length > unregBefore, 'Signing out should remove the app\u2019s push registration.');
  check(await droid.page.evaluate(() => localStorage.getItem('hearth.push') === null && localStorage.getItem('hearth.push.endpoint') === null), 'Signing out should forget push on this device.');
  await droid.close();
  delete t.people.droid;
}

// ------------------------------------------------------------------ 9. changes that need the password again
async function stepUp(t) {
  const { alice, bob } = t.people;
  // Deleting a server: the app asks for the password; a wrong one is refused in place, the right one deletes.
  await alice.createServer('Doomed Den');
  await alice.serverMenu('Server settings');
  await alice.$('.modal.server-settings .ss-tab', { hasText: 'Danger zone' }).click();
  await alice.$('.modal.server-settings .danger-zone button', { hasText: 'Delete server' }).click();
  const del = await alice.confirmPassword('Delete Doomed Den?', '');
  await del.locator('.form-error', { hasText: exact('Enter your password.') }).waitFor();
  await alice.confirmPassword('Delete Doomed Den?', t.pw.alice + 'nope');
  await del.locator('.form-error', { hasText: 'password isn’t right' }).waitFor();
  await alice.confirmPassword('Delete Doomed Den?', t.pw.alice);
  await alice.$('#rail button[aria-label="Doomed Den"]').waitFor({ state: 'detached' });
  await alice.noModals();

  // Handing the server to bob.
  await alice.railButton(SERVER);
  await alice.serverMenu('Server settings');
  await alice.$('.modal.server-settings .ss-tab', { hasText: 'Danger zone' }).click();
  const to = alice.$('.modal.server-settings .danger-zone select');
  await to.selectOption(await to.locator('option', { hasText: 'bob' }).getAttribute('value'));
  await alice.$('.modal.server-settings .danger-zone button', { hasText: exact('Transfer') }).click();
  await alice.confirmPassword('Transfer ownership?', t.pw.alice);
  await alice.toast('Ownership transferred.');
  // Alice has no say over the server any more, so its settings close instead of showing forms she can't save.
  await alice.page.waitForSelector('.modal.server-settings', { state: 'detached' });
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.showMembers();
  await bob.member('bob').locator('.role-icon[data-tip="Server owner"]').waitFor();
  await bob.serverMenu('Server settings');
  await bob.$('.modal.server-settings .ss-tab', { hasText: 'Danger zone' }).waitFor();
  await bob.$('.modal.server-settings .modal-x').click();
  await bob.noModals();

  // The instance's staff team: each change asks for the owner's password.
  await alice.railButton('Admin');
  await alice.$('.admin-tabs .admin-tab', { hasText: 'Team & roles' }).click();
  await alice.$('.admin-body input[placeholder="username"]').fill('bob');
  await alice.$('.admin-body .chips .chip', { hasText: 'Moderator' }).click();
  await alice.$('.admin-body button.btn.primary', { hasText: exact('Add') }).click();
  await alice.confirmPassword('Make bob a moderator?', t.pw.alice);
  await alice.$('.admin-body .adm-row', { hasText: '@bob' }).locator('.stat-sub', { hasText: exact('Moderator') }).waitFor();
  await bob.$('#rail button[aria-label="Admin"]').waitFor();
  await alice.$('.admin-body .adm-row', { hasText: '@bob' }).locator('button', { hasText: 'Change role' }).click();
  await alice.menuItem('Make admin').click();
  await alice.confirmPassword('Make bob an admin?', t.pw.alice);
  await alice.$('.admin-body .adm-row', { hasText: '@bob' }).locator('.stat-sub', { hasText: exact('Admin') }).waitFor();
  await bob.toast('You’re now an admin on this server.');

  // Call relay (TURN) settings, in Settings → Instance.
  await alice.openSettings('Instance');
  await alice.$('.set-content .field', { hasText: 'Relay addresses' }).locator('input').fill('turn:203.0.113.7:3478?transport=udp');
  await alice.$('.set-content .field', { hasText: 'Shared secret' }).locator('input').fill(t.pw.relay);
  await alice.$('.set-content .set-section', { hasText: 'Calls (voice' }).locator('button.btn.primary', { hasText: exact('Save') }).click();
  await alice.confirmPassword('Save relay settings', t.pw.alice);
  await alice.$('.set-content', { hasText: 'Relay set up: turn:203.0.113.7:3478' }).waitFor();
  await alice.closeSettings();

  // A region (its install command carries the relay secret).
  await alice.$('.admin-tabs .admin-tab', { hasText: 'Regions' }).click();
  await alice.$('.admin-body button', { hasText: 'Add a region' }).click();
  const reg = await alice.dialog('Add a region');
  await reg.locator('input').fill('Frankfurt');
  await reg.locator('.modal-foot .btn.primary').click();
  await alice.confirmPassword(/Confirm it.s you/, t.pw.alice);
  const cmd = alice.modal('Set up Frankfurt').locator('.cmd-box code');
  await cmd.waitFor();
  check(/\/regions\/install\/\w+\?k=[0-9a-f]+/.test(await cmd.innerText()), 'The region install command should carry its one-time link.');
  await alice.modal('Set up Frankfurt').locator('.modal-x').click();
  await alice.noModals();
  await alice.$('.admin-body .adm-row', { hasText: 'Frankfurt' }).waitFor();

  // Owner tools: a backup, its key (password), deleting it (password), and a new donation link (password).
  await alice.$('.admin-tabs .admin-tab', { hasText: 'Owner' }).click();
  await alice.$('.admin-body button', { hasText: 'Back up now' }).click();
  await alice.toast('Backup made and restore-tested.', 120000);
  await alice.$('.admin-body button', { hasText: 'Show backup key' }).click();
  await alice.confirmPassword('Show the backup key', t.pw.alice);
  const key = alice.modal('Backup key').locator('code');
  check(/^[0-9a-f]{64}$/.test((await key.innerText()).trim()), 'The backup key should be shown after the password.');
  await alice.modal('Backup key').locator('.modal-x').click();
  await alice.noModals();
  const row = alice.$('.admin-body .adm-row', { hasText: '.hbk' }).first();
  await row.locator('button', { hasText: 'Delete' }).click();
  await alice.confirmPassword('Delete this backup?', t.pw.alice);
  await alice.$('.admin-body', { hasText: 'No encrypted backups yet.' }).waitFor();
  await alice.$('.admin-body .field', { hasText: 'Donation link' }).locator('input').fill('https://ko-fi.com/e2e-hall');
  await alice.$('.admin-body .field', { hasText: 'Storage for supporters' }).locator('xpath=following-sibling::div[1]').locator('button', { hasText: exact('Save') }).click();
  await alice.confirmPassword('Confirm the donation link', t.pw.alice);
  await alice.toast('Saved.');

  // Every one of those is in the audit log, and its tamper check still passes.
  await alice.$('.admin-tabs .admin-tab', { hasText: 'Audit log' }).click();
  await alice.$('.admin-body .chain-ok', { hasText: 'Tamper check passed' }).waitFor();
  for (const what of ['server deleted', 'server transferred', 'turn settings', 'region added', 'backup key viewed', 'backup deleted']) {
    await alice.$('.admin-body .adm-row.log', { hasText: what }).first().waitFor();
  }

  // Finally the whole instance: bob becomes the owner, alice stays on as an admin.
  await alice.$('.admin-tabs .admin-tab', { hasText: 'Team & roles' }).click();
  await alice.$('.admin-body .adm-row', { hasText: '@bob' }).locator('button', { hasText: 'Change role' }).click();
  await alice.menuItem('Make owner…').click();
  const own = await alice.dialog('Make bob the owner?');
  await own.locator('input').fill('bob');
  await own.locator('.modal-foot .btn.danger').click();
  await alice.confirmPassword('Confirm handing over ownership', t.pw.alice);
  await alice.toast('bob is now the owner.');
  await bob.toast('You’re now the owner on this server.');
  await alice.$('.admin-body .adm-row', { hasText: '@alice_w' }).locator('.stat-sub', { hasText: exact('Admin') }).waitFor();
}

// ------------------------------------------------------------------ 12. deleting an account
async function deleteAccount(t) {
  const { alice, bob } = t.people;
  const carl = await t.open('carl');
  await carl.register('carl', t.pw.carl);
  await carl.join(t.state.invite, SERVER);
  await carl.openChannel('general');
  await carl.send('Carl was here: plum');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.message('Carl was here: plum').waitFor();

  await carl.openSettings('Security');
  await carl.$('.set-content button', { hasText: 'Delete my account' }).click();
  await carl.confirmPassword('Delete your account?', t.pw.carl);
  const sure = await carl.dialog('Type your username to confirm');
  await sure.locator('input').fill('carl');
  await sure.locator('.modal-foot .btn.danger').click();
  await carl.page.waitForSelector('#login-form:not([hidden])');
  // (Said by Settings, or by the server's notice if that arrives first: either way, it says so.)
  await carl.$('#login-form .form-error', { hasText: /(Your|This) account was deleted\./ }).waitFor();
  // The others see it go; what carl wrote stays, from a "Deleted user".
  await bob.showMembers();
  await bob.member('carl').waitFor({ state: 'detached' });
  await bob.message('Carl was here: plum').locator('.msg-name', { hasText: 'Deleted user' }).waitFor();
  // And the account can't sign in any more.
  await carl.$('#login-form [name=username]').fill('carl');
  await carl.$('#login-form [name=password]').fill(t.pw.carl);
  await carl.$('#login-form button[type=submit]').click();
  await carl.$('#login-form .form-error', { hasText: 'Wrong username or password' }).waitFor({ timeout: 30000 });
  void alice;
}

// ------------------------------------------------------------------ 13. recovery key, email, password change and reset
// Across the auth and crypto changes: the password-locked key, step-up, sessions, reset links and key proofs.
async function recovery(t) {
  const { alice, bob } = t.people;
  const name = 'alice_w';
  await alice.openSettings('Security');
  // A recovery key (shown once).
  await alice.$('.set-content button', { hasText: 'Create a recovery key' }).click();
  await alice.confirmPassword('Create a recovery key', t.pw.alice);
  const shown = alice.modal('recovery key for');
  const code = (await shown.locator('.secret-box code').innerText()).trim();
  check(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){7}$/.test(code), `The recovery key should look like XXXX-…-XXXX (got ${code}).`);
  await shown.locator('input[type=checkbox]').check();
  await shown.locator('button', { hasText: exact('Done') }).click();
  await alice.$('.set-content .kv', { hasText: 'Recovery key' }).locator('.rpill', { hasText: 'Saved' }).waitFor();

  // An email, confirmed with the code it gets.
  await alice.$('.set-content button', { hasText: 'Add an email' }).click();
  const add = await alice.dialog('Add an email');
  await add.locator('input[type=email]').fill('alice@example.test');
  await alice.confirmPassword('Add an email', t.pw.alice);
  const mail = await t.server.mail('alice@example.test', /confirmation code is \d{6}/);
  const verify = await alice.dialog('Check your email');
  await verify.locator('input').fill(/code is (\d{6})/.exec(mail.subject)[1]);
  await verify.locator('.modal-foot .btn.primary').click();
  await alice.toast('Email confirmed.');

  // A new password signs out her other devices.
  const phone = await t.open('alice-phone');
  await phone.login(name, t.pw.alice);
  // …but not a second tab of this browser (the same storage): the sign-in gets a new token, which every tab here
  // picks up, reconnecting with it (auth-11). Its errors count as alice's.
  const tab2 = new Person('alice-tab2', alice.context, await alice.context.newPage(), alice.base);
  tab2.pageErrors = alice.pageErrors; tab2.serverErrors = alice.serverErrors; tab2.log = alice.log; // (its log goes in alice's report)
  tab2.page.setDefaultTimeout(20000);
  await tab2.page.goto(alice.base);
  await tab2.waitApp();
  await tab2.railButton(SERVER);
  await tab2.openChannel('general');
  const oldToken = await alice.page.evaluate(() => localStorage.getItem('hearth.token'));
  const next = t.pw.alice + '-2';
  const box = alice.$('.set-content .set-section', { hasText: 'Change password' });
  await box.locator('.field', { hasText: 'Current password' }).locator('input').fill(t.pw.alice);
  await box.locator('.field', { hasText: exact('New password') }).locator('input').fill(next);
  await box.locator('.field', { hasText: 'Confirm new password' }).locator('input').fill(next);
  await box.locator('button', { hasText: exact('Change password') }).click();
  await alice.toast('Password changed. Other devices were logged out.');
  t.pw.alice = next;
  await phone.page.waitForSelector('#login-form:not([hidden])');
  await phone.$('#login-form .form-error', { hasText: 'Your password was changed' }).waitFor();
  await phone.close();
  delete t.people['alice-phone'];
  await alice.closeSettings();
  // Both tabs hold the new token and are live on it: bob's message shows up in each as it's sent, and the second
  // tab's own message reaches him.
  await alice.page.waitForFunction((old) => { const v = localStorage.getItem('hearth.token'); return v && v !== old; }, oldToken);
  check(await tab2.page.evaluate((old) => !!localStorage.getItem('hearth.token') && localStorage.getItem('hearth.token') !== old, oldToken), 'The second tab should share the new token.');
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.send('After the password change: plum');
  await alice.message('After the password change: plum').waitFor();
  await tab2.message('After the password change: plum').waitFor();
  await tab2.send('The second tab is still here: pear');
  await bob.message('The second tab is still here: pear').waitFor();
  check(!(await tab2.$('#auth:not([hidden])').count()), 'The second tab should never have been signed out.');
  // Its keys weren't wiped either: after a reload it opens straight into the app, messages readable.
  await tab2.page.reload();
  await tab2.waitApp();
  await tab2.railButton(SERVER);
  await tab2.openChannel('general');
  await tab2.message('After the password change: plum').waitFor();
  check(!(await tab2.$('#messages .msg-text.undecryptable').count()), 'After a reload, the second tab should still read the channel.');
  await tab2.page.close();

  // Forgot it: the email link plus the recovery key keep every old message readable.
  await alice.logout();
  await alice.$('#to-forgot').click();
  const forgot = await alice.dialog('Reset your password');
  await forgot.locator('input.input').fill(name);
  await forgot.locator('.modal-foot .btn.primary').click();
  await alice.toast('a reset link is on its way');
  const reset = await t.server.mail('alice@example.test', /#reset=/);
  const link = /(http\S+#reset=[\w-]+)/.exec(reset.text)[1];
  await alice.page.goto(link);
  const fresh = t.pw.alice + '-3';
  const form = await alice.dialog(`Choose a new password for ${name}`);
  await form.locator('.field', { hasText: exact('New password') }).locator('input').fill(fresh);
  await form.locator('.field', { hasText: 'Confirm new password' }).locator('input').fill(fresh);
  await form.locator('.field', { hasText: 'Recovery key' }).locator('input').fill(code);
  await form.locator('.modal-foot .btn.primary').click();
  await alice.toast('All your messages are still here.');
  t.pw.alice = fresh;
  await alice.waitApp();
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await alice.message('the mango is ripe').waitFor();
  check(!(await alice.$('#messages .msg-text.undecryptable').count()), 'After a reset with the recovery key, old channel messages should still decrypt.');
  await alice.railButton('Direct messages');
  await alice.dmRow('bob').click();
  await alice.message('Private hello to bob: kiwi').waitFor();
  // Her contacts still trust her (same keys), and she can still write to them.
  await alice.send('Still me after the reset: fig');
  await bob.railButton('Direct messages');
  await bob.dmRow('Alice Wonder').click();
  await bob.message('Still me after the reset: fig').waitFor();
}

// ------------------------------------------------------------------ 14. two-factor sign-in
async function twoFactor(t) {
  const { alice, bob } = t.people;
  await alice.openSettings('Security');
  await alice.$('.set-content button', { hasText: 'Set up two-factor sign-in' }).click();
  await alice.confirmPassword('Turn on two-factor sign-in', t.pw.alice);
  const scan = await alice.dialog('Scan this with your authenticator app');
  const secret = (await scan.locator('code.mono-sm').innerText()).replace(/\s/g, '');
  await scan.locator('input').fill(totp(secret));
  await scan.locator('.modal-foot .btn.primary').click();
  const codes = alice.modal('backup codes for');
  const backup = (await codes.locator('.secret-box code').innerText()).split(/\s+/).filter(Boolean);
  check(backup.length === 10, `Ten backup codes should be shown (got ${backup.length}).`);
  await codes.locator('input[type=checkbox]').check();
  await codes.locator('button', { hasText: exact('Done') }).click();
  await alice.toast('Two-factor sign-in is on.');
  await alice.closeSettings();

  // Signing in now asks for a code: a backup code works once.
  await alice.logout();
  const f = alice.$('#login-form');
  await f.locator('[name=username]').fill('alice_w');
  await f.locator('[name=password]').fill(t.pw.alice);
  await f.locator('button[type=submit]').click();
  await alice.$('#totp-field:not([hidden])').waitFor({ timeout: 30000 });
  await alice.$('#totp-switch').click();
  await f.locator('[name=totp]').fill(backup[0]);
  await f.locator('button[type=submit]').click();
  await alice.waitApp();

  // Even right after signing in with a code, a sensitive change asks for the password and a code, in one dialog
  // (auth-6). A new recovery key takes two requests (the locked key, then the new copy) on that one code: the
  // first answer's step-up ticket stands in for it on the second.
  const steps = [];
  const onStep = (r) => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/me/')) steps.push(`${r.method()} ${p}`); };
  alice.page.on('request', onStep);
  await alice.openSettings('Security');
  await alice.$('.set-content button', { hasText: /^(Create a recovery key|Make a new one)$/ }).click();
  const rk = await alice.dialog('Create a recovery key');
  await rk.locator('input[type=password]').fill(t.pw.alice);
  await rk.locator('input[autocomplete="one-time-code"]').fill(backup[1]);
  await rk.locator('.modal-foot .btn.primary').click();
  const rkShown = alice.modal('recovery key for');
  await rkShown.locator('.secret-box code').waitFor();
  check(!(await alice.modal('Enter your two-factor code').count()), 'One code should be enough for a new recovery key.');
  await rkShown.locator('input[type=checkbox]').check();
  await rkShown.locator('button', { hasText: exact('Done') }).click();
  alice.page.off('request', onStep);
  check(steps.includes('POST /api/me/keys/wrapped') && steps.includes('PUT /api/me/recovery'), `The locked key, then the new copy (asked for: ${steps.join(', ')}).`);
  await alice.closeSettings();

  // "Log out all other devices" asks for the password and a code too: this device then gets a new sign-in token, so
  // a copy of it taken earlier stops working (auth-11). The app carries on with the new one, live connection included.
  const tokenBefore = await alice.page.evaluate(() => localStorage.getItem('hearth.token'));
  await alice.openSettings('Security', 'Signed-in devices');
  await alice.$('.set-content button', { hasText: 'Log out all other devices' }).click();
  const others = await alice.dialog('Log out all other devices?');
  await others.locator('input[type=password]').fill(t.pw.alice);
  await others.locator('input[autocomplete="one-time-code"]').fill(backup[2]);
  await others.locator('.modal-foot .btn.danger').click();
  await alice.toast(/Signed out \d+ device|No other devices were signed in/);
  await alice.page.waitForFunction((old) => { const v = localStorage.getItem('hearth.token'); return v && v !== old; }, tokenBefore);
  await alice.closeSettings();
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.send('After alice’s new sign-in: quince');
  await alice.message('After alice’s new sign-in: quince').waitFor();
  await alice.send('Still here with the new sign-in: fig');
  await bob.message('Still here with the new sign-in: fig').waitFor();
  check(!(await alice.$('#auth:not([hidden])').count()), 'Alice should still be signed in.');

  // Turning it off takes the password and one code, in one dialog, also when the last code was a while ago (this
  // sign-in's is made 11 minutes old here). Asking for the password used to fetch the locked key first, which then
  // wanted a code of its own: that used up the one on the phone, and the code asked for next was refused.
  t.server.sql("UPDATE sessions SET mfa_at = ? WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE username = 'alice_w')", Date.now() - 11 * 60000);
  const asked = [];
  const onRequest = (r) => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/me/')) asked.push(p); };
  alice.page.on('request', onRequest);
  await alice.openSettings('Security');
  await alice.$('.set-content .set-section', { hasText: 'Two-factor sign-in' }).locator('button', { hasText: exact('Turn off') }).click();
  const off = await alice.dialog('Turn off two-factor sign-in');
  await off.locator('input[type=password]').fill(t.pw.alice);
  // The code the app shows next: the current one may have turned two-factor on, less than 30 seconds ago.
  await off.locator('input[autocomplete="one-time-code"]').fill(totp(secret, Date.now() + 30000));
  await off.locator('.modal-foot .btn.danger').click();
  await alice.toast('Two-factor sign-in is off.');
  alice.page.off('request', onRequest);
  check(!asked.includes('/api/me/keys/wrapped'), `Turning two-factor off shouldn't need the locked key (asked for: ${asked.join(', ')}).`);
  check(asked.filter((p) => p === '/api/me/2fa/disable').length === 1, `One request should turn it off (asked for: ${asked.join(', ')}).`);
  await alice.$('.set-content button', { hasText: 'Set up two-factor sign-in' }).waitFor();
  await alice.closeSettings();
}

// ------------------------------------------------------------------ 15. leaving and coming back (key rotation)
async function rejoin(t) {
  const { alice, bob } = t.people;
  // Bob (the owner now) gives alice a role and lets her into the private #staff-room by name. Leaving takes both away,
  // and bob's open app has to forget them too: it sends what it has back when he next changes her roles (the ones
  // she has plus the new one) or saves the channel's permissions.
  await alice.railButton(SERVER);
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.showMembers();
  await bob.member('Alice Wonder').click({ button: 'right' });
  await bob.menuItem('Keepers').click();
  await alice.page.locator('#sidebar-body button[aria-label^="Create channel in"]').first().waitFor();
  await bob.channelRow('staff-room').locator('.ch-main').click({ button: 'right' });
  await bob.menuItem('Permissions').click();
  const perms = await bob.dialog('staff-room');
  const add = perms.locator('select[aria-label="Add a role or member"]');
  await add.selectOption(await add.locator('option', { hasText: 'Alice Wonder' }).getAttribute('value'));
  await perms.locator('.ov-perms .ov-row', { hasText: 'View channels' }).locator('.tri-btn.allow').click();
  await perms.locator('.modal-foot .btn.primary', { hasText: 'Save' }).click();
  await bob.toast('Channel saved.');
  await bob.noModals();
  await alice.channelRow('staff-room').waitFor();

  await alice.serverMenu('Leave server');
  await alice.modal(`Leave ${SERVER}?`).locator('.modal-foot .btn.danger').click();
  await alice.$(`#rail button[aria-label="${SERVER}"]`).waitFor({ state: 'detached' });
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.send('While alice was away: lemon');
  const link = await bob.inviteLink();
  await alice.join(link, SERVER);
  await alice.openChannel('general');
  // Back in: the older history she had a key for still opens, and new messages work both ways (after the
  // server key is replaced, since she was gone).
  await alice.message('the mango is ripe').waitFor();
  await alice.send('Back after rejoining: lime');
  await bob.message('Back after rejoining: lime').waitFor();
  // Bob's app knows she came back with nothing: the role isn't ticked, and saving #staff-room's permissions as they
  // are doesn't let her back in.
  await bob.showMembers();
  await bob.member('Alice Wonder').click({ button: 'right' });
  const keepers = await bob.menuItem('Keepers').getAttribute('aria-checked');
  await bob.page.keyboard.press('Escape');
  check(keepers === 'false', 'Bob\u2019s app should know alice lost the Keepers role when she left.');
  await bob.channelRow('staff-room').locator('.ch-main').click({ button: 'right' });
  await bob.menuItem('Permissions').click();
  const again = await bob.dialog('staff-room');
  check(!(await again.locator('.ov-list .role-name', { hasText: 'Alice Wonder' }).count()), 'Bob\u2019s app should know alice\u2019s #staff-room permission went when she left.');
  await again.locator('.modal-foot .btn.primary', { hasText: 'Save' }).click();
  await bob.toast('Channel saved.');
  await bob.noModals();
  await bob.send('Welcome back: grape');
  await alice.message('Welcome back: grape').waitFor();
  // (Bob's save reached alice before this message did.)
  check(!(await alice.channelRow('staff-room').count()), 'Alice should not see #staff-room again after rejoining.');
  check(!(await bob.$('#messages .msg-text.undecryptable').count()), 'Bob should read everything in #general.');
  // What was said while she was away shows up (without a reload) as written before she joined: its key is
  // never handed to her, so "waiting for the key" would wait forever.
  await alice.$('#messages .msg-text.undecryptable', { hasText: 'Sent before you joined' }).waitFor();
  check(!(await alice.$('#messages .msg-text.undecryptable', { hasText: 'Waiting for the encryption key' }).count()), 'A message from while alice was away should not wait for a key that never comes.');
}

// ------------------------------------------------------------------ 16. the new owner runs the instance
// Taking someone off the team (password), an announcement, and maintenance mode, which disconnects everyone but
// staff and must let them back in by itself when it ends.
async function broadcastAndMaintenance(t) {
  const { alice, bob } = t.people;
  await bob.railButton('Admin');
  await bob.$('.admin-tabs .admin-tab', { hasText: 'Team & roles' }).click();
  await bob.$('.admin-body .adm-row', { hasText: '@alice_w' }).locator('button', { hasText: 'Change role' }).click();
  await bob.menuItem('Remove from staff').click();
  await bob.confirmPassword('Remove Alice Wonder from staff?', t.pw.bob);
  await alice.toast('You’re no longer on the staff team.');
  await alice.$('#rail button[aria-label="Admin"]').waitFor({ state: 'detached' });

  await bob.$('.admin-tabs .admin-tab', { hasText: 'Security' }).click();
  await bob.$('.admin-subtabs .set-subtab', { hasText: 'Broadcast' }).click();
  await bob.$('.admin-body textarea').fill('Hello from the **new** owner');
  await bob.$('.admin-body button', { hasText: 'Post announcement' }).click();
  await alice.$('#announce', { hasText: 'Hello from the new owner' }).waitFor();
  await alice.$('#announce button[aria-label="Dismiss"]').click();
  await alice.$('#announce').waitFor({ state: 'detached' });

  await bob.$('.admin-body input[placeholder^="e.g. Upgrading"]').fill('Back in a moment');
  await bob.$('.admin-body button', { hasText: exact('Turn on') }).click();
  await bob.modal('Turn on maintenance mode?').locator('.modal-foot .btn.danger').click();
  await bob.toast('Maintenance mode is on.');
  await alice.$('#update-overlay', { hasText: 'Down for maintenance' }).waitFor();
  await alice.$('#update-overlay', { hasText: 'Back in a moment' }).waitFor();
  await bob.$('.admin-body button', { hasText: exact('Turn off') }).click();
  await bob.toast('Maintenance mode is off.');
  // Alice's app reconnects on its own (it retries every few seconds) and works again.
  await alice.$('#update-overlay').waitFor({ state: 'detached', timeout: 30000 });
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await alice.send('Maintenance is over: quince');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.message('Maintenance is over: quince').waitFor();
}

// ------------------------------------------------------------------ 17. moderation: signing someone out, suspending them
// Both close the person's open app, which must say why (the server tells it before closing the connection).
async function moderation(t) {
  const { alice, bob } = t.people;
  const openAlice = async () => {
    await bob.$('.admin-tabs .admin-tab', { hasText: exact('Users') }).click();
    await bob.$('.admin-body input.search-input').fill('alice');
    await bob.$('.admin-body .adm-row .adm-user', { hasText: '@alice_w' }).click();
    return bob.dialog('Alice Wonder (@alice_w)');
  };
  await bob.railButton('Admin');
  let m = await openAlice();
  await m.locator('.modal-foot button', { hasText: 'Sign out everywhere' }).click();
  await bob.toast('Signed out of all devices.');
  await alice.page.waitForSelector('#login-form:not([hidden])');
  await alice.$('#login-form .form-error', { hasText: 'A server admin signed you out. Sign in again.' }).waitFor();
  await alice.login('alice_w', t.pw.alice);

  m = await openAlice();
  await m.locator('.modal-foot button', { hasText: 'Suspend' }).click();
  const sus = await bob.dialog('Suspend Alice Wonder?');
  await sus.locator('.chip', { hasText: exact('1 hour') }).click();
  await sus.locator('.field', { hasText: 'Reason' }).locator('input').fill('cooling off');
  await sus.locator('.modal-foot .btn.danger', { hasText: 'Suspend' }).click();
  await bob.toast('Alice Wonder is suspended.');
  await alice.page.waitForSelector('#login-form:not([hidden])');
  await alice.$('#login-form .form-error', { hasText: 'This account was suspended.' }).waitFor();
  const f = alice.$('#login-form');
  await f.locator('[name=username]').fill('alice_w');
  await f.locator('[name=password]').fill(t.pw.alice);
  await f.locator('button[type=submit]').click();
  await f.locator('.form-error', { hasText: /This account is suspended until .*: cooling off/ }).waitFor({ timeout: 30000 });

  await bob.noModals();
  m = await openAlice();
  await m.locator('.modal-foot button', { hasText: 'Unsuspend' }).click();
  await bob.toast('Unsuspended.');
  await bob.noModals();
  await alice.login('alice_w', t.pw.alice);
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await alice.message('Maintenance is over: quince').waitFor();
}

// ------------------------------------------------------------------ 18. every settings page opens cleanly
async function smoke(t) {
  const { bob } = t.people;
  const failed = [];
  const onResp = (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(t.server.base, '')}`); };
  bob.page.on('response', onResp);
  const errorsIn = async (where, sel) => {
    await bob.page.waitForFunction((s) => !document.querySelector(`${s} .spinner, ${s} .panel-loading`), sel, { timeout: 5000 }).catch(() => {});
    const errs = (await bob.$(`${sel} .form-error`).allInnerTexts()).map((x) => x.trim()).filter(Boolean);
    if (errs.length) failed.push(`${where}: ${errs.join(' / ')}`);
  };
  await bob.openSettings();
  for (const tab of await bob.$('.set-nav .set-nav-btn:not(.danger)').allInnerTexts()) {
    await bob.page.locator('.set-nav .set-nav-btn', { hasText: exact(tab) }).click();
    await errorsIn(`Settings → ${tab.trim()}`, '.set-content');
    const subs = await bob.$('.set-subtabs .set-subtab').allInnerTexts();
    for (const sub of subs.slice(1)) {
      await bob.page.locator('.set-subtabs .set-subtab', { hasText: exact(sub) }).click();
      await errorsIn(`Settings → ${tab.trim()} → ${sub.trim()}`, '.set-content');
    }
  }
  await bob.closeSettings();
  await bob.railButton('Admin');
  for (const tab of await bob.$('.admin-tabs .admin-tab').allInnerTexts()) {
    await bob.page.locator('.admin-tabs .admin-tab', { hasText: exact(tab) }).click();
    await errorsIn(`Admin → ${tab.trim()}`, '.admin-body');
    if (tab.trim() === 'Security') {
      for (const sub of ['Storage & limits', 'Broadcast']) {
        await bob.page.locator('.admin-subtabs .set-subtab', { hasText: exact(sub) }).click();
        await errorsIn(`Admin → Security → ${sub}`, '.admin-body');
      }
    }
  }
  await bob.railButton(SERVER);
  await bob.serverMenu('Server settings');
  for (const tab of await bob.$('.modal.server-settings .ss-tab').allInnerTexts()) {
    await bob.page.locator('.modal.server-settings .ss-tab', { hasText: exact(tab) }).click();
    await errorsIn(`Server settings → ${tab.trim()}`, '.modal.server-settings');
  }
  await bob.$('.modal.server-settings .modal-x').click();
  await bob.noModals();
  bob.page.off('response', onResp);
  check(!failed.length, `Pages that failed to load:\n  ${failed.join('\n  ')}`);
}

// ------------------------------------------------------------------ 19. threads: what's new in them, the Threads panel
// A ping in a thread shows on the message that starts it, on the Threads button and in the channel's badge, survives
// a reload, and goes once the thread is opened. The panel lists the thread (decrypted) and follows new replies live.
async function threads(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await alice.send('Thread starter: who brings snacks?');
  const onBob = bob.message('Thread starter: who brings snacks?').first();
  await onBob.hover();
  await onBob.locator('button[aria-label="Reply in thread"]').click();
  await bob.send('@alice_w I bring the chips', '.cw-thread textarea.composer-input');

  const chip = alice.message('Thread starter: who brings snacks?').locator('.thread-chip');
  const threadsBtn = alice.$('#main-head button.with-badge');
  await chip.locator('.thread-new.ping', { hasText: '1 new' }).waitFor();
  await threadsBtn.locator('.badge', { hasText: '1' }).waitFor();
  await alice.channelRow('general').locator('.badge', { hasText: '1' }).waitFor();
  // It's kept on the server: still there after a reload.
  await alice.page.reload();
  await alice.waitApp();
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await chip.locator('.thread-new', { hasText: '1 new' }).waitFor();

  // The Threads panel lists it, decrypted, with what's new.
  await threadsBtn.click();
  const card = alice.$('#members .thread-card', { hasText: 'who brings snacks?' });
  await card.locator('.thread-new', { hasText: '1 new' }).waitFor();
  await card.click();
  await alice.message('I bring the chips', '.thread-list').waitFor();
  await alice.$('.thread-list .new-div', { hasText: 'New replies' }).waitFor();
  // Opening it read it: the badges go.
  await threadsBtn.locator('.badge').waitFor({ state: 'detached' });
  await chip.locator('.thread-new').waitFor({ state: 'detached' });
  check(!(await alice.channelRow('general').locator('.badge').count()), 'Reading the thread should clear the channel’s badge.');

  // Back to the list from the keyboard: it lands on that thread's card. The list follows new replies live.
  await alice.$('#members button[aria-label="Back to threads"]').focus();
  await alice.page.keyboard.press('Enter');
  await card.waitFor();
  check(await card.evaluate((el) => el === document.activeElement), 'Back to threads should put the keyboard on that thread’s card.');
  check(!(await card.locator('.thread-new').count()), 'A thread just read should have nothing new.');
  await bob.send('And a bowl of dip', '.cw-thread textarea.composer-input');
  await card.locator('.thread-new', { hasText: '1 new' }).waitFor();
  await chip.locator('.thread-new', { hasText: '1 new' }).waitFor();
  // "Mark as read" on the channel takes its threads with it.
  await alice.channelRow('general').locator('.ch-main').click({ button: 'right' });
  await alice.menuItem('Mark as read').click();
  await card.locator('.thread-new').waitFor({ state: 'detached' });
  await chip.locator('.thread-new').waitFor({ state: 'detached' });

  // A thread left chosen while the member list covers it (the server menu's Members) doesn't read new replies.
  await card.click();
  await alice.message('And a bowl of dip', '.thread-list').waitFor();
  await alice.serverMenu('Members');
  await alice.$('#members .member-list').waitFor();
  await bob.send('Napkins too', '.cw-thread textarea.composer-input');
  await chip.locator('.thread-new', { hasText: '1 new' }).waitFor();

  // A ping that's deleted leaves nothing behind: not on the channel, the message or the page title.
  const title = await alice.page.title();
  await bob.send('@alice_w ping, wrong person', '.cw-thread textarea.composer-input');
  await chip.locator('.thread-new.ping', { hasText: '2 new' }).waitFor();
  await alice.channelRow('general').locator('.badge', { hasText: '1' }).waitFor();
  const wrong = bob.message('wrong person', '.thread-list').first();
  await wrong.hover();
  await wrong.locator('button[aria-label="More actions"]').click();
  await bob.menuItem('Delete message').click();
  await bob.modal('Delete message?').locator('.modal-foot .btn.danger').click();
  await alice.channelRow('general').locator('.badge').waitFor({ state: 'detached' });
  await chip.locator('.thread-new:not(.ping)', { hasText: '1 new' }).waitFor();
  await alice.page.waitForFunction((t) => document.title === t, title);
  await bob.$('#members button[aria-label="Close panel"]').click();

  // A webhook's post that starts a thread keeps its BOT tag and "not end-to-end encrypted" flag in the Threads
  // panel, even under a member's name, and links in a card's preview are plain text.
  const hook = await fetch(t.state.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', content: 'HOOKROOT the server moved, sign in again at https://evil.example' }) });
  check(hook.status === 204, `Posting to the webhook should answer 204 (got ${hook.status}).`);
  const hookMsg = bob.message('HOOKROOT').first();
  await hookMsg.hover();
  await hookMsg.locator('button[aria-label="Reply in thread"]').click();
  await bob.send('Is this really you?', '.cw-thread textarea.composer-input');
  await threadsBtn.click();
  const hookCard = alice.$('#members .thread-card', { hasText: 'HOOKROOT' });
  await hookCard.locator('.bot-tag', { hasText: 'BOT' }).waitFor();
  await hookCard.locator('.msg-flag', { hasText: 'Webhook · not end-to-end encrypted' }).waitFor();
  check(!(await hookCard.locator('a').count()), 'A link in a card’s preview should be plain text.');
  check(/webhook/.test(await hookCard.getAttribute('aria-label')), 'A webhook’s card should say so to screen readers.');
  await bob.$('#members button[aria-label="Close panel"]').click();

  // A thread started by someone you blocked is folded away in the panel, as their messages are in the channel.
  await bob.send('Bob secret root words');
  const bobRoot = bob.message('Bob secret root words').first();
  await bobRoot.hover();
  await bobRoot.locator('button[aria-label="Reply in thread"]').click();
  await bob.send('My own first reply', '.cw-thread textarea.composer-input');
  await alice.$('#members .thread-card', { hasText: 'Bob secret root words' }).waitFor();
  await alice.message('Bob secret root words').locator('.msg-name').click();
  await alice.page.locator('.pop-profile button[aria-label="More"]').click();
  await alice.menuItem('Block').click();
  await alice.modal('Block bob?').locator('.modal-foot .btn.danger').click();
  await alice.toast('bob is blocked.');
  const folded = alice.$('#members .thread-card.blocked', { hasText: 'Thread started by someone you blocked' });
  await folded.waitFor();
  check(!(await alice.$('#members .threads-list', { hasText: 'Bob secret root words' }).count()), 'A blocked person’s thread should be folded away in the Threads panel.');
  await folded.locator('button', { hasText: 'Show' }).click();
  await alice.$('#members .thread-card', { hasText: 'Bob secret root words' }).waitFor();
  // Unblocked again for whatever comes next.
  await alice.showMembers();
  await alice.member('bob').click();
  await alice.page.locator('.pop-profile button[aria-label="More"]').click();
  await alice.menuItem('Unblock').click();
  await alice.toast('bob is unblocked.');
  await bob.$('#members button[aria-label="Close panel"]').click();
}

// ------------------------------------------------------------------ 20. link previews
// The sender's app asks for a preview only when told to; the card goes inside the encrypted message, so the
// reader's app shows it without contacting the site (or asking this server about the link).
async function linkPreviews(t) {
  const { alice, bob } = t.people;
  const site = t.server.site;
  const url = `${site.base}/story`;
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  const bobAsked = [];
  const onRequest = (r) => { const u = r.url(); if (u.includes(site.host) || u.includes(`:${site.port}/`) || u.includes('/api/link-previews')) bobAsked.push(u); };
  bob.page.on('request', onRequest);
  try {
    const box = alice.$('#composer-input');
    const chip = alice.$('.cw-main .link-chip');
    // "Ask each time" (the default): the chip only offers. Nothing has been fetched yet.
    await box.fill(`Have you seen this? ${url} `);
    await chip.filter({ hasText: 'Your Hearth server fetches the page, so it sees this link.' }).waitFor();
    check(!site.hits.length, `Nothing should be fetched before Alice asks for a preview (fetched ${site.hits.join(', ')}).`);
    // No thanks: the link goes out as a plain link.
    await chip.locator('button[aria-label="No preview for this link"]').click();
    await chip.waitFor({ state: 'detached' });
    await box.press('Enter');
    await bob.message('Have you seen this?').waitFor();
    check(!(await bob.message('Have you seen this?').locator('.link-card').count()), 'A message sent without a preview should not show a card.');
    check(!site.hits.length, 'Turning the preview down should not fetch the page.');

    // Yes please: the server fetches it for Alice, her app shrinks the picture, and the card travels encrypted.
    await box.fill(`Pineapple news: ${url} `);
    await chip.locator('button', { hasText: exact('Preview') }).click();
    await alice.$('.cw-main .link-chip.ready', { hasText: 'Pineapple harvest report' }).waitFor();
    check(site.hits.includes('/story') && site.hits.includes('/cover.png'), `The server should have fetched the page and its picture (got ${site.hits.join(', ')}).`);
    await box.press('Enter');
    const card = bob.message('Pineapple news:').locator('a.link-card');
    await card.locator('.news-title', { hasText: 'Pineapple harvest report' }).waitFor();
    check((await card.getAttribute('href')) === url, 'The card should open the link from the message.');
    check((await card.locator('.news-meta').innerText()).trim() === `${site.host}:${site.port}`, 'The domain line should come from the link itself.');
    check(/^data:image\/(webp|jpeg);base64,/.test(await card.locator('img.link-img').getAttribute('src') || ''), 'The picture should come from inside the message.');
    check(!(await card.locator('.news-summary').innerText()).includes('<'), 'Text from the page is shown as text.');
    await alice.message('Pineapple news:').locator('a.link-card').waitFor();

    // Keyboard only: Enter on Preview gets the card and leaves the focus in the box, so the next Enter sends.
    await box.fill(`Keyboard pick: ${site.base}/keys `);
    await chip.locator('button', { hasText: exact('Preview') }).focus();
    await alice.page.keyboard.press('Enter');
    await alice.$('.cw-main .link-chip.ready').waitFor();
    const focused = await alice.page.evaluate(() => (document.activeElement ? document.activeElement.id || document.activeElement.tagName : ''));
    check(focused === 'composer-input', `After Preview, the focus should be back in the message box (it is on ${focused}).`);
    await alice.page.keyboard.press('Enter');
    await bob.message('Keyboard pick:').locator('a.link-card').waitFor();

    // "Always": a link is fetched once it's finished. Backspace inside "…/story-twelve please" makes a new link
    // each time; none of them is sent anywhere until the typing pauses, and then only the one in the box.
    await box.fill(`Third story: ${site.base}/story-twelve please`);
    await chip.locator('button', { hasText: exact('Always') }).click();
    await alice.$('.cw-main .link-chip.ready').waitFor();
    const asked = [];
    const onAsk = (r) => { if (r.url().endsWith('/api/link-previews')) asked.push(r.postDataJSON().url); };
    alice.page.on('request', onAsk);
    try {
      await box.press('End');
      for (let i = 0; i < ' please'.length; i++) await box.press('ArrowLeft');
      for (let i = 0; i < 3; i++) await box.press('Backspace');
      check(!asked.length, `Editing inside a link should not ask for a preview before the pause (asked for ${asked.join(', ')}).`);
      check(!(await chip.count()), 'The card for the link as it was should go as soon as the link changes.');
      await alice.$('.cw-main .link-chip.ready').waitFor();
    } finally { alice.page.off('request', onAsk); }
    check(asked.length === 1 && asked[0] === `${site.base}/story-twe`, `After the pause, only the link in the box should be previewed (asked for ${asked.join(', ')}).`);
    check(!site.hits.includes('/story-twelv') && !site.hits.includes('/story-twel'), `Half-edited links should never be fetched (the site got ${site.hits.join(', ')}).`);
    await box.fill('');
    await chip.waitFor({ state: 'detached' });
  } finally { bob.page.off('request', onRequest); }
  // Back to the default for whatever runs next.
  await alice.openSettings('Chat');
  await alice.page.locator('select[aria-label="When I send a link"]').selectOption('ask');
  await alice.closeSettings();
  check(!bobAsked.length, `Bob's app should never contact the site or ask about the link (it asked for ${bobAsked.join(', ')}).`);
}

// ------------------------------------------------------------------ outside images and the app's own fonts (xss-8)
// An image link to another site would show that site every reader's IP address, so it waits behind a placeholder
// until clicked (Settings → Privacy & safety → Outside images: Ask first, Always load, Never load). The other site
// here is answered by Bob's browser itself, counting what it's asked for.
async function outsideImages(t) {
  const { alice, bob } = t.people;
  const host = 'pics.outside-site.test';
  const png = makePng(80, 60);
  const hits = [];
  await bob.page.route(`https://${host}/**`, (route) => { hits.push(route.request().url()); route.fulfill({ status: 200, contentType: 'image/png', body: png }); });
  const choose = async (label) => {
    await bob.openSettings('Privacy & safety');
    await bob.page.locator('.chips[aria-label="Outside images"] .chip', { hasText: label }).click();
    await bob.toast('Saved.');
    await bob.closeSettings();
  };
  try {
    await alice.railButton(SERVER);
    await alice.openChannel('general');
    await bob.railButton(SERVER);
    await bob.openChannel('general');

    // Ask first (the default): the host and a Load button, and nothing fetched until the click.
    const first = `https://${host}/sunset.png`;
    await alice.send(`Sunset from the trip ${first}`);
    const msg = bob.message('Sunset from the trip');
    const ask = msg.locator('.embed-ask');
    await ask.waitFor();
    check((await ask.innerText()).includes(host), 'The placeholder should name the site the picture would load from.');
    check(!(await msg.locator('img.embed-img').count()), 'The picture should not be in the page before the click.');
    check(!hits.length, `Nothing should be fetched from ${host} before the click (fetched ${hits.join(', ')}).`);
    await ask.locator('button', { hasText: exact('Load image') }).click();
    const img = msg.locator('img.embed-img');
    await img.waitFor();
    await bob.page.waitForFunction((el) => el.complete && el.naturalWidth === 80, await img.elementHandle());
    check(hits.length === 1 && hits[0] === first, `After the click, the picture should load once (fetched ${hits.join(', ')}).`);
    check(!(await msg.locator('.embed-ask').count()), 'The placeholder should be gone once the picture shows.');

    // A message that's only the link, from the keyboard: the link text shows while it asks, then just the picture,
    // and keyboard focus moves to the message (the button it was on is gone).
    const only = `https://${host}/lighthouse.png`;
    await alice.send(only);
    const onlyMsg = bob.message(only).first();
    await onlyMsg.locator('.embed-ask button').waitFor();
    const onlyId = await onlyMsg.getAttribute('data-mid');
    const onlyEl = bob.page.locator(`#messages .msg[data-mid="${onlyId}"]`);
    await onlyEl.locator('.embed-ask button').focus();
    await bob.page.keyboard.press('Enter');
    await onlyEl.locator('img.embed-img').waitFor();
    check(!(await onlyEl.locator('.msg-text').count()), 'Once its picture shows, a message that is only an image link should show just the picture.');
    check(await bob.page.evaluate((id) => document.activeElement && document.activeElement.matches(`#messages .msg[data-mid="${id}"]`), onlyId),
      'After Load image, keyboard focus should be on the message, not lost to the page.');

    // Never load: no button, never fetched.
    await choose('Never load');
    const second = `https://${host}/harbour.png`;
    await alice.send(`The harbour at dusk ${second}`);
    const never = bob.message('The harbour at dusk').locator('.embed-ask.never');
    await never.waitFor();
    check(!(await never.locator('button').count()), 'Never load should offer no Load button.');
    check(!(await bob.message('Sunset from the trip').locator('img.embed-img').count()), 'Never load should also hide a picture loaded earlier.');
    check(!hits.includes(second), 'Never load should not fetch anything.');

    // Changed on another device (here, the API with Bob's own sign-in): the pictures on screen follow at once,
    // without throwing away an edit Bob is typing here.
    await bob.send('A note I am still fixing');
    await bob.messageAction('A note I am still fixing', 'Edit message');
    const edit = bob.page.locator('#messages textarea.edit-input');
    await edit.waitFor();
    await edit.fill('A note I am still fixing, half-written');
    const elsewhere = (mode) => bob.page.evaluate((v) => fetch('/api/me/privacy', { method: 'PATCH', headers: { Authorization: `Bearer ${localStorage.getItem('hearth.token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ outsideImages: v }) }).then((r) => r.status), mode);
    check(await elsewhere('ask') === 200, 'Changing Outside images from another device should work.');
    await bob.message('The harbour at dusk').locator('.embed-ask:not(.never) button').waitFor();
    check(await edit.inputValue() === 'A note I am still fixing, half-written', 'An edit being typed should survive Outside images changing on another device.');
    check(await edit.evaluate((el) => el === document.activeElement), 'The edit box should keep keyboard focus.');
    check(!hits.includes(second), 'Ask first again: still nothing fetched.');
    await edit.press('Escape');
    await edit.waitFor({ state: 'detached' });

    // Always load: pictures load straight away, as before.
    await choose('Always load');
    await bob.message('The harbour at dusk').locator('img.embed-img').waitFor();
    await bob.page.waitForFunction(() => [...document.querySelectorAll('#messages img.embed-img')].some((i) => i.complete && i.naturalWidth === 80 && i.src.includes('harbour')));
    check(hits.includes(second), 'Always load should fetch the picture.');

    // Even then, a link to this server's own picture proxy (with the sender's token and the sender's choice of
    // site) stays a plain link: showing it would have Hearth fetch that site for every reader.
    const proxied = [];
    const onProxy = (r) => { if (r.url().includes('/media/news')) proxied.push(r.url()); };
    bob.page.on('request', onProxy);
    try {
      const sneaky = `${t.server.base}/media/news/x.png?u=${encodeURIComponent(`https://${host}/read-receipt.png`)}&t=alices-token`;
      await alice.send(`Proxy trick ${sneaky}`);
      const trick = bob.message('Proxy trick');
      await trick.waitFor();
      await bob.page.waitForTimeout(500);
      check(!(await trick.locator('.msg-embeds, .embed-ask, img.embed-img').count()), 'A link to this server\'s picture proxy should not be shown as a picture.');
      check(await trick.locator('.msg-text a').count() === 1, 'It should stay a plain link.');
      check(!proxied.length && !hits.some((u) => u.includes('read-receipt')), `Nothing should be fetched for it (fetched ${[...proxied, ...hits.filter((u) => u.includes('read-receipt'))].join(', ')}).`);
    } finally { bob.page.off('request', onProxy); }
  } finally {
    await bob.page.unroute(`https://${host}/**`);
  }
  // Back to the default for whatever runs next.
  await choose('Ask first');

  // The app's fonts come from Hearth itself: every face loads from this server (the harness refuses everything
  // else), and the page asked no other site for a font.
  const fonts = await bob.page.evaluate(async () => {
    await document.fonts.ready;
    const families = ['Figtree', 'Bricolage Grotesque', 'Pacifico', 'Orbitron', 'Press Start 2P', 'Caveat', 'Righteous', 'Bungee', 'Space Mono', 'Playfair Display', 'Creepster', 'Comfortaa', 'Monoton'];
    const missing = [];
    for (const f of families) {
      try { const got = await document.fonts.load(`16px "${f}"`, 'Hearth'); if (!got.length || got.some((x) => x.status !== 'loaded')) missing.push(f); } catch { missing.push(f); }
    }
    const fontFiles = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.woff2(\?|$)|fonts\.(googleapis|gstatic)/.test(n));
    return { missing, body: getComputedStyle(document.body).fontFamily, fontFiles };
  });
  check(!fonts.missing.length, `These fonts didn't load from Hearth: ${fonts.missing.join(', ')}`);
  check(/^"?Figtree"?,/.test(fonts.body), `The interface font should be Figtree (it is ${fonts.body}).`);
  const elsewhere = fonts.fontFiles.filter((u) => !u.startsWith(`${t.server.base}/fonts/`));
  check(fonts.fontFiles.length && !elsewhere.length, `Fonts should only come from ${t.server.base}/fonts/ (also asked: ${elsewhere.join(', ') || 'none'}).`);
}

// ------------------------------------------------------------------ disappearing messages (a DM, 5 seconds: NODE_ENV=test)
async function disappearing(t) {
  const { alice, bob } = t.people;
  for (const [p, other] of [[alice, 'bob'], [bob, 'alice']]) {
    await p.railButton('Direct messages');
    await p.dmRow(other).click();
    await p.page.waitForSelector(`#composer-input[placeholder="Message ${other}"]`);
  }
  // Alice turns it on from the conversation's menu; turning it on asks first and says what it can't do.
  await alice.$('#main-head button[aria-label="More"]').click();
  await alice.menuItem('5 seconds').click();
  const ask = await alice.dialog('Turn on disappearing messages?');
  check(/screenshot/.test(await ask.innerText()), 'Turning on disappearing messages should say people can still screenshot what they see.');
  await ask.locator('.modal-foot .btn.primary').click();
  // Both screens get the line in the conversation, the timer in the header and the note above the box.
  await alice.$('#messages .sys-line', { hasText: 'You turned on disappearing messages: 5 seconds' }).waitFor();
  await bob.$('#messages .sys-line', { hasText: 'turned on disappearing messages: 5 seconds' }).waitFor();
  for (const p of [alice, bob]) {
    await p.$('#main-head button[aria-label="Disappearing messages: 5 seconds"]').waitFor();
    await p.$('.cw-main .dis-note', { hasText: 'New messages disappear after 5 seconds.' }).waitFor();
  }
  // A message with a picture, mentioning bob (so it lands in his inbox too).
  await alice.$('.cw-main input[type=file]').setInputFiles([{ name: 'secret.png', mimeType: 'image/png', buffer: makePng(40, 30) }]);
  const sent = alice.page.waitForRequest((r) => /\/api\/dms\/\w+\/messages$/.test(r.url()) && r.method() === 'POST');
  await alice.send('@bob this one self-destructs: plum');
  const body = (await sent).postDataJSON();
  check(body.ttl === 5 && Array.isArray(body.files) && body.files.length, 'The app should send the timer it encrypted for, with the file.');
  const onBob = bob.message('self-destructs: plum').first();
  await onBob.locator('.msg-exp').waitFor();
  await onBob.locator('img.att-img[src^="blob:"]').waitFor({ timeout: 15000 });
  const inbox = () => bob.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hearth.inbox.')).map((k) => localStorage.getItem(k)).join('').includes('plum'));
  check(await inbox(), 'The mention should be in bob’s inbox while the message is there.');
  // Five seconds later it's gone from both screens, its file stops loading, and the inbox entry goes too.
  await bob.message('self-destructs: plum').waitFor({ state: 'detached', timeout: 20000 });
  await alice.message('self-destructs: plum').waitFor({ state: 'detached', timeout: 20000 });
  // (Polled briefly: this app hides it by the server's clock, which it only knows to within a few milliseconds.)
  let status = 0;
  for (let i = 0; i < 20 && status !== 404; i++) { status = await bob.page.evaluate(async (u) => (await fetch(u)).status, body.files[0]); if (status !== 404) await bob.page.waitForTimeout(100); }
  check(status === 404, `A disappeared message’s file should no longer load (got ${status}).`);
  check(!(await inbox()), 'The inbox entry should go with the message.');
  // Bob turns it off from the header; new messages stay.
  await bob.$('#main-head button[aria-label="Disappearing messages: 5 seconds"]').click();
  await bob.menuItem('Off').click();
  await alice.$('#messages .sys-line', { hasText: 'turned off disappearing messages' }).waitFor();
  await alice.$('#main-head button[aria-label^="Disappearing messages"]').waitFor({ state: 'detached' });
  await alice.send('This one stays: fig');
  await bob.message('This one stays: fig').waitFor();
  check(!(await bob.message('This one stays: fig').locator('.msg-exp').count()), 'A message sent with the timer off should not show a timer.');
  // Drawn again from scratch (away and back): one divider per day, the timer lines included.
  await alice.railButton('Home');
  await alice.railButton('Direct messages');
  await alice.dmRow('bob').click();
  await alice.page.waitForSelector('#composer-input[placeholder="Message bob"]');
  await alice.$('#messages .sys-line', { hasText: 'turned off disappearing messages' }).waitFor();
  const days = await alice.page.$$eval('#messages .day-div', (els) => els.map((e) => e.dataset.day));
  check(days.length && new Set(days).size === days.length, `Each day should have one divider, timer lines or not (got ${days.join(' | ')}).`);
  // Turned off while bob's message is on its way: he wrote it expecting it to disappear, so it isn't sent unasked.
  await alice.$('#main-head button[aria-label="More"]').click();
  await alice.menuItem('1 hour').click();
  await (await alice.dialog('Turn on disappearing messages?')).locator('.modal-foot .btn.primary').click();
  await bob.$('.cw-main .dis-note', { hasText: 'New messages disappear after 1 hour.' }).waitFor();
  const ttls = [];
  let hold = true;
  await bob.page.route('**/api/dms/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    ttls.push(route.request().postDataJSON().ttl);
    try {
      if (hold) {
        hold = false;
        await alice.$('#main-head button[aria-label="Disappearing messages: 1 hour"]').click();
        await alice.menuItem('Off').click();
        await bob.$('.cw-main .dis-note').waitFor({ state: 'hidden' });
      }
    } finally { await route.continue(); }
  });
  const box = bob.$('#composer-input');
  await box.fill('Written while it said 1 hour: kiwi');
  await box.press('Enter');
  const offAsk = await bob.dialog('Disappearing messages turned off');
  check(/won’t disappear/.test(await offAsk.innerText()), 'Bob should be asked before his message goes out without a timer.');
  await offAsk.locator('.modal-foot .btn', { hasText: 'Cancel' }).click();
  await bob.noModals();
  await bob.toast('Not sent');
  check(await box.inputValue() === 'Written while it said 1 hour: kiwi', 'The words should be back in bob’s box.');
  check(ttls.join() === '3600', `Only the first try should have gone out (got ${ttls.join()}).`);
  check(!(await alice.message('said 1 hour: kiwi').count()), 'Alice should not have it.');
  await bob.page.unroute('**/api/dms/*/messages');
  // Sent again under the timer as it is now: no question.
  await box.press('Enter');
  await alice.message('said 1 hour: kiwi').first().waitFor();
  check(!(await bob.$('.modal').count()), 'Sending under the current timer should not ask.');
  // A server channel (alice owns the server, so she may set it): a message that arrives live goes at its time by the
  // apps' own timer, even when the server hasn't deleted it (its copy is given an hour more here, so no delete event
  // comes).
  for (const p of [alice, bob]) { await p.railButton(SERVER); await p.openChannel('general'); }
  await alice.$('#main-head button[aria-label="More"]').click();
  await alice.menuItem('5 seconds').click();
  await (await alice.dialog('Turn on disappearing messages?')).locator('.modal-foot .btn.primary').click();
  await bob.$('#main-head button[aria-label="Disappearing messages: 5 seconds"]').waitFor();
  await alice.send('Gone by the app’s own timer: quince');
  await bob.message('own timer: quince').first().waitFor();
  check(t.server.sql('UPDATE messages SET expires_at = expires_at + 3600000 WHERE expires_at > ?', Date.now()).changes === 1, 'The message should be waiting on the server.');
  await bob.message('own timer: quince').waitFor({ state: 'detached', timeout: 15000 });
  await alice.message('own timer: quince').waitFor({ state: 'detached', timeout: 15000 });
  check(t.server.sql('UPDATE messages SET expires_at = ? WHERE expires_at > ?', Date.now() - 1000, Date.now()).changes === 1, 'The server should still have had it: the apps hid it by themselves.');
  // Off again for the flows after this one.
  await alice.$('#main-head button[aria-label="Disappearing messages: 5 seconds"]').click();
  await alice.menuItem('Off').click();
  await bob.$('#main-head button[aria-label^="Disappearing messages"]').waitFor({ state: 'detached' });
}

// ------------------------------------------------------------------ 21. import a Discord server's structure
// Bob pastes the sample template (test/fixtures/discord-template.json): the preview says what comes over and what
// is skipped before anything exists, leaving a role and a channel out updates it, and Create opens the new server.
async function discordImport(t) {
  const { bob } = t.people;
  const template = fs.readFileSync(new URL('../fixtures/discord-template.json', import.meta.url), 'utf8');
  await bob.railButton('Add a server');
  await bob.page.locator('.modal .choice', { hasText: 'Import from Discord' }).click();
  const m = await bob.dialog('Import from Discord');
  // A template link only gives the address to open in the browser; Hearth doesn't fetch it.
  await m.locator('.field', { hasText: 'Template link' }).locator('input').fill('https://discord.new/hEaRtHtEsT01');
  const href = await m.locator('a.di-api-link').getAttribute('href');
  check(href === 'https://discord.com/api/v10/guilds/templates/hEaRtHtEsT01', `The template link should point at Discord's template address (got ${href}).`);
  await m.locator('textarea.di-json').fill(template);
  await m.locator('.modal-foot .btn.primary', { hasText: 'Preview' }).click();
  const p = bob.modal('Import from Discord');
  await p.locator('.di-list').first().waitFor();
  await p.locator('.muted-p', { hasText: 'Creates 6 roles, 4 categories and 11 channels' }).waitFor();
  // What doesn't come over is listed before creating.
  const skipped = p.locator('.di-section', { hasText: 'These will be skipped' });
  for (const text of ['Manage threads: Moderator', 'Category Archive: no channels left in it', 'Age-restricted (NSFW) flag: channel-8', 'Verification level']) {
    await skipped.locator('li', { hasText: text }).waitFor();
  }
  await p.locator('.warn-box li', { hasText: 'Read message history (channel-8)' }).waitFor();
  // Builder's Manage Channels also manages events in Hearth, which it couldn't in Discord: said before creating.
  await p.locator('.warn-box li', { hasText: 'Manage events (Builder)' }).waitFor();
  await p.locator('.di-row.di-chan', { hasText: 'Town Hall' }).locator('.di-sub', { hasText: 'Stage' }).waitFor();
  await p.locator('.di-row.di-chan', { hasText: 'mod-chat' }).locator('.di-lock').waitFor();
  // Leave a role and a channel out: the server works the plan out again.
  await p.locator('.di-row', { hasText: 'Muted' }).locator('input[type=checkbox]').uncheck();
  await p.locator('.di-row.di-chan', { hasText: 'trail-photos' }).locator('input[type=checkbox]').uncheck();
  await p.locator('.muted-p', { hasText: 'Creates 5 roles, 4 categories and 10 channels' }).waitFor();
  await p.locator('.field', { hasText: 'Server name' }).locator('input').fill('Pinecone Import');
  // A slow Create, pressed while a change is still being worked out: nothing turns the button back on meanwhile
  // (a second press would make a second server).
  const create = p.locator('.modal-foot .btn.primary', { hasText: 'Create server' });
  const muted = p.locator('.di-row', { hasText: 'Muted' }).locator('input[type=checkbox]');
  const held = []; // each request held back, until it has gone on
  await bob.page.route('**/api/imports/discord', (route) => { const go = new Promise((r) => setTimeout(r, 3000)).then(() => route.continue()); held.push(go); return go; });
  await muted.check();
  await muted.uncheck();
  await create.click();
  await new Promise((r) => setTimeout(r, 1200));
  check(await create.isDisabled(), 'Create should stay off while the server is being made.');
  // Let the held requests through before taking the hold away: unrouting one still waiting would fail it (and, with
  // more flows after this one, bring the run down).
  await Promise.all(held);
  await bob.page.unroute('**/api/imports/discord');
  await bob.page.locator('#sidebar-head .server-head-name', { hasText: exact('Pinecone Import') }).waitFor();
  const done = await bob.dialog('Imported Pinecone Import');
  await done.locator('li', { hasText: 'Muted: you left it out' }).waitFor();
  await done.locator('.modal-foot .btn.primary', { hasText: 'Done' }).click();
  await bob.noModals();
  // 公告 has no letters Hearth keeps, so it's named by its place: 7th, now that trail-photos stayed behind.
  for (const name of ['welcome', 'announcements', 'mod-chat', 'channel-7', 'Town Hall']) await bob.channelRow(name).waitFor();
  check(!(await bob.channelRow('trail-photos').count()), 'A channel left out should not be created.');
  await bob.openChannel('general');
  await bob.send('First message after the import: pinecone');
}

// ------------------------------------------------------------------ 22. channel order: drag and drop, and the keyboard
// Bob (who owns the server now) drags a new channel onto the Voice category's name and then the Voice category above
// Text; alice, who doesn't manage channels, sees each change at once and has nothing to drag. Then Move down from the
// channel menu, by keyboard: inside Voice, then on into the next category (collapsed: it opens), with the focus
// staying on the channel. Last, a menu left open while another of bob's devices reorders doesn't undo that.
async function channelOrder(t) {
  const { alice, bob } = t.people;
  await bob.railButton(SERVER);
  await alice.railButton(SERVER);
  await bob.serverMenu('Create channel');
  const cc = await bob.dialog('Create channel');
  await cc.locator('.field', { hasText: 'Channel name' }).locator('input').fill('drag-me');
  await cc.locator('.modal-foot .btn.primary').click();
  await bob.page.waitForSelector('#composer-input[placeholder="Message #drag-me"]');
  await alice.channelRow('drag-me').waitFor();
  const group = (p, cat) => p.$(`#sidebar-body .cat-group[data-cat="${cat}"]`);
  const namesIn = (p, cat) => group(p, cat).locator('.ch-row .ch-name').allInnerTexts();
  const categories = (p) => p.page.locator('#sidebar-body .cat-group').evaluateAll((els) => els.map((e) => e.dataset.cat));
  check(!(await alice.$('#sidebar-body [draggable="true"]').count()), 'Alice can’t manage channels, so nothing in her channel list should be draggable.');
  await alice.channelRow('drag-me').locator('.ch-main').click({ button: 'right' });
  await alice.menuItem('Copy channel link').waitFor();
  check(!(await alice.menuItem('Move up').count()) && !(await alice.menuItem('Move down').count()), 'Alice’s channel menu should not offer to move channels.');
  await alice.page.keyboard.press('Escape');

  // Onto the Voice category's name: first in Voice, for alice too.
  await bob.channelRow('drag-me').locator('.ch-main').dragTo(group(bob, 'Voice').locator('.cat-head'));
  await group(alice, 'Voice').locator('.ch-row').filter({ has: alice.page.locator('.ch-name', { hasText: exact('drag-me') }) }).waitFor();
  check((await namesIn(alice, 'Voice'))[0] === 'drag-me', `#drag-me should be first in Voice (alice sees ${(await namesIn(alice, 'Voice')).join(', ')}).`);
  check(!(await namesIn(alice, 'Text')).includes('drag-me'), '#drag-me should have left Text.');

  // The Voice category above Text, dragged by its name onto the top of Text.
  await group(bob, 'Voice').locator('.cat-toggle').dragTo(group(bob, 'Text'), { targetPosition: { x: 30, y: 3 } });
  await alice.page.waitForFunction(() => {
    const cats = [...document.querySelectorAll('#sidebar-body .cat-group')].map((e) => e.dataset.cat);
    return cats.indexOf('Voice') >= 0 && cats.indexOf('Voice') < cats.indexOf('Text');
  });
  const order = await categories(bob);
  check(order.indexOf('Voice') === order.indexOf('Text') - 1, `Voice should sit right above Text for bob (${order.join(', ')}).`);

  // The keyboard: Move down from the channel's menu, chosen with Enter. The focus stays on the channel as it moves.
  const voiceNames = await namesIn(bob, 'Voice');
  const main = bob.channelRow('drag-me').locator('.ch-main');
  await main.focus();
  await main.click({ button: 'right' });
  await bob.menuItem('Move down').press('Enter');
  await bob.toast('#drag-me moved down.');
  await alice.page.waitForFunction((n) => {
    const rows = [...document.querySelectorAll('#sidebar-body .cat-group[data-cat="Voice"] .ch-row .ch-name')].map((e) => e.textContent);
    return rows.indexOf('drag-me') === 1 && rows.length === n;
  }, voiceNames.length);
  const focusedOn = () => bob.page.evaluate(() => { const r = document.activeElement && document.activeElement.closest('.ch-row'); return r ? r.querySelector('.ch-name').textContent : null; });
  check(await focusedOn() === 'drag-me', `The focus should stay on #drag-me after moving it (it is on ${await focusedOn()}).`);
  // At the bottom of Voice, Move down goes on into the category below (Text), first in it.
  for (let i = 2; i < voiceNames.length; i++) {
    await main.click({ button: 'right' });
    await bob.menuItem('Move down').press('Enter');
    await bob.toast('#drag-me moved down.');
  }
  // With Text collapsed and another channel open, so nothing else keeps #drag-me drawn there: Text opens.
  await bob.openChannel('general');
  await group(bob, 'Text').locator('.cat-toggle').click();
  await group(bob, 'Text').locator('.cat-toggle[aria-expanded="false"]').waitFor();
  await main.focus();
  await main.click({ button: 'right' });
  const last = bob.menuItem('Move down');
  check((await last.innerText()).includes('to Text'), `At the bottom of Voice, Move down should say where it goes (it says “${(await last.innerText()).trim()}”).`);
  await last.press('Enter');
  await bob.toast('#drag-me moved to Text.');
  check(await group(bob, 'Text').locator('.cat-toggle').getAttribute('aria-expanded') === 'true', 'Moving a channel into a collapsed category from its menu should open the category.');
  check((await namesIn(bob, 'Text'))[0] === 'drag-me', `#drag-me should be first in Text for bob (${(await namesIn(bob, 'Text')).join(', ')}).`);
  check(await focusedOn() === 'drag-me', `The focus should stay on #drag-me after moving it into a collapsed category (it is on ${await focusedOn()}).`);
  await alice.page.waitForFunction(() => document.querySelector('#sidebar-body .cat-group[data-cat="Text"] .ch-row .ch-name')?.textContent === 'drag-me');

  // The menu stays open while another of bob's devices moves the last channel of Text to the top. Move down then
  // goes from the list as it is now (below the next channel), and that other move stands.
  await main.click({ button: 'right' });
  const down = bob.menuItem('Move down');
  await down.waitFor();
  const lastInText = await bob.page.evaluate(async (name) => {
    const token = localStorage.getItem('hearth.token');
    const call = async (method, path, body) => (await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
    const s = (await call('GET', '/bootstrap')).servers.find((x) => x.name === name);
    const catOf = (c) => c.category || (c.type === 'voice' ? 'Voice' : 'Text');
    const chans = [...s.channels].sort((a, b) => a.position - b.position);
    const seen = [...new Set(chans.map(catOf))];
    const cats = [...s.categoryOrder.filter((k) => seen.includes(k)), ...seen.filter((k) => !s.categoryOrder.includes(k))];
    const groups = cats.map((k) => chans.filter((c) => catOf(c) === k));
    const text = groups[cats.indexOf('Text')];
    const moved = text.pop();
    text.unshift(moved);
    await call('POST', `/servers/${s.id}/channel-order`, { ids: groups.flat().map((c) => c.id) });
    return moved.name;
  }, SERVER);
  await bob.page.waitForFunction((n) => document.querySelector('#sidebar-body .cat-group[data-cat="Text"] .ch-row .ch-name')?.textContent === n, lastInText);
  const was = await namesIn(bob, 'Text');
  check(was[1] === 'drag-me' && was.length >= 3, `Text should read ${lastInText}, drag-me, … for bob (${was.join(', ')}).`);
  await down.press('Enter');
  await bob.toast('#drag-me moved down.');
  await bob.page.waitForFunction((n) => [...document.querySelectorAll('#sidebar-body .cat-group[data-cat="Text"] .ch-row .ch-name')].map((e) => e.textContent).indexOf('drag-me') === n, 2);
  const now = await namesIn(bob, 'Text');
  check(now[0] === lastInText && now[1] === was[2], `The other device's move should stand, with #drag-me below ${was[2]} (Text reads ${now.join(', ')}).`);
  check(await focusedOn() === 'drag-me', `The focus should be on #drag-me after the move (it is on ${await focusedOn()}).`);
}

// ------------------------------------------------------------------ 23. away after inactivity, a custom status that clears itself
// Dana (new, in the server) sets "Away after" to 5 minutes. With her page's clock moved six minutes on and no input,
// Alice sees her go Away by herself, and Online again the moment she moves the mouse; Dana's own panel changes in
// place (its buttons aren't rebuilt under her pointer). Dana saves a custom status in Settings → Profile and clears
// it again in the same tab. Alice sets a status that clears after 30 minutes: Bob sees it, and when it's due the
// server clears it for both of them without a reload.
async function awayAndStatus(t) {
  const { alice, bob } = t.people;
  await bob.railButton(SERVER);
  const link = await bob.inviteLink();
  t.pw.dana = newPassword();
  const dana = await t.open('dana');
  await dana.register('dana', t.pw.dana);
  await dana.join(link, SERVER);
  await dana.openSettings('Privacy & safety');
  const after = dana.$('select[aria-label="Show me as Away after"]');
  check((await after.inputValue()) === '10', 'Away after should start at 10 minutes.');
  await after.selectOption('5');
  await dana.toast('Saved.');
  await dana.closeSettings();

  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await alice.showMembers();
  const danaRow = alice.member('dana');
  await danaRow.locator('.status-dot.st-online').waitFor();
  const gearKept = () => dana.page.evaluate(() => !!(window.e2eGear && window.e2eGear.isConnected));
  await dana.page.evaluate(() => { window.e2eGear = document.querySelector('#user-panel button[aria-label="Settings"]'); });
  // Six minutes without input (only the page's clock moves; its timers keep running).
  await dana.page.clock.setFixedTime(Date.now() + 6 * 60000);
  await danaRow.locator('.status-dot.st-idle').waitFor({ timeout: 40000 });
  await dana.$('#user-panel .me-sub', { hasText: 'Away (inactive)' }).waitFor();
  await dana.$('#user-panel .status-dot.st-idle').waitFor();
  check(await gearKept(), 'Going Away by herself should change Dana\u2019s panel in place, not rebuild its buttons.');
  // Back: moving the mouse is enough, without waiting for the next check.
  await dana.page.mouse.move(300, 300);
  await dana.page.mouse.move(340, 320);
  await danaRow.locator('.status-dot.st-online').waitFor({ timeout: 10000 });
  await dana.$('#user-panel .me-sub', { hasText: 'Online' }).waitFor();
  check(await gearKept(), 'Coming back should not rebuild Dana\u2019s panel either.');

  // Settings → Profile: a custom status saved there, then cleared again in the same tab (which reloads after each
  // save, so the second save sees the status changed).
  await dana.openSettings('Profile');
  const csText = dana.$('.settings-modal input[aria-label="Status text"]');
  await csText.fill('Lunch');
  await dana.$('.settings-modal .save-bar button', { hasText: 'Save changes' }).click();
  await dana.toast('Profile saved.');
  // (Settings covers the user panel, so these only need it to be in the page.)
  await dana.$('#user-panel .me-sub', { hasText: 'Lunch' }).waitFor({ state: 'attached' });
  check((await csText.inputValue()) === 'Lunch', 'The reloaded Profile tab should show the saved status.');
  await csText.fill('');
  await dana.$('.settings-modal .save-bar button', { hasText: 'Save changes' }).click();
  await dana.$('#user-panel .me-sub', { hasText: 'Online' }).waitFor({ state: 'attached' });
  check(!(await dana.$('#toasts .toast-error').count()), `Saving the profile should show no error (got ${JSON.stringify(await dana.$('#toasts .toast-error').allTextContents())}).`);
  await dana.closeSettings();
  await dana.close();

  // A status that clears itself after 30 minutes.
  await alice.$('#user-panel .me-btn').click();
  await alice.$('.popover .menu-item', { hasText: 'Set a custom status' }).click();
  let m = await alice.dialog('Set a custom status');
  await m.locator('input[aria-label="Status text"]').fill('Out for lunch');
  check((await m.locator('select[aria-label="Clear after"]').inputValue()) === 'never', 'A new status should stay until cleared unless told otherwise.');
  await m.locator('select[aria-label="Clear after"]').selectOption('30m');
  await m.locator('.field-hint', { hasText: /^Clears (at|tomorrow at) / }).waitFor();
  await m.locator('.modal-foot .btn.primary', { hasText: 'Save' }).click();
  await alice.noModals();
  await alice.$('#user-panel .me-sub', { hasText: 'Out for lunch' }).waitFor();
  await bob.openChannel('general');
  await bob.showMembers();
  const status = bob.member('Alice Wonder').locator('.member-status', { hasText: 'Out for lunch' });
  await status.waitFor();
  // Opening it again keeps the time it clears unless she picks another.
  await alice.$('#user-panel .me-btn').click();
  await alice.$('.popover .menu-item', { hasText: 'Set a custom status' }).click();
  m = await alice.dialog('Set a custom status');
  check((await m.locator('select[aria-label="Clear after"]').inputValue()) === 'keep', 'Reopening should offer to keep the time it clears.');
  await m.locator('.modal-x').click();
  await alice.noModals();
  // Due (as if the half hour had passed): cleared by the server, live, for both.
  const aliceId = await alice.page.evaluate(() => localStorage.getItem('hearth.userId'));
  t.server.sql('UPDATE users SET status_expires_at = ? WHERE id = ?', Date.now() - 1000, aliceId);
  await status.waitFor({ state: 'detached', timeout: 30000 });
  await alice.$('#user-panel .me-sub', { hasText: 'Out for lunch' }).waitFor({ state: 'detached', timeout: 10000 });
}

// ------------------------------------------------------------------ 24. text chat in a voice channel
// The chat opens beside the call view (from the voice channel's menu, or the header's chat button), messages go both
// ways end-to-end encrypted, and threads aren't offered there. A chat bob never opened doesn't light up for him (a
// ping still does); once he has opened it, new messages count as unread like any channel's. Pinned messages open in
// the chat's place and Jump goes back to it. "All messages" on a chat alice never opened makes it count (dot and
// sound); in a call whose chat she never opened, "New messages" goes above what was said since she joined.
async function voiceChat(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  // Alice opens the Lounge's chat from its menu: the call view with the chat beside it, without joining the call.
  await alice.channelRow('Lounge').click({ button: 'right' });
  await alice.menuItem('Open chat').click();
  await alice.$('#members[data-mode="chat"] #composer-input[placeholder="Message \u{1F50A} Lounge"]').waitFor();
  await alice.$('.voice-room .cs-controls button', { hasText: 'Join call' }).waitFor();
  await alice.send('Anyone up for a round in the Lounge?');
  // Bob never opened it: a plain message doesn't light it up for him, a ping does.
  await alice.send('@bob come join us');
  const lounge = bob.channelRow('Lounge');
  await lounge.locator('.badge', { hasText: exact('1') }).waitFor();
  check(!(await lounge.evaluate((el) => el.classList.contains('unread'))), 'A voice chat Bob never opened should show only his ping, not as unread.');
  // He opens it from the menu too: both messages, decrypted, and the ping is read.
  await lounge.click({ button: 'right' });
  await bob.menuItem('Open chat').click();
  await bob.message('Anyone up for a round in the Lounge?').waitFor();
  check(!(await bob.$('#messages .msg-text.undecryptable').count()), 'Bob should be able to decrypt the voice chat.');
  await lounge.locator('.badge').waitFor({ state: 'detached' });
  await bob.send('On my way');
  await alice.message('On my way').waitFor();
  // A picture link to another site waits for a click here too (Ask first, the default), as in any channel (xss-8).
  const picHost = 'pics.outside-site.test';
  const picHits = [];
  await bob.page.route(`https://${picHost}/**`, (route) => { picHits.push(route.request().url()); route.fulfill({ status: 200, contentType: 'image/png', body: makePng(40, 30) }); });
  try {
    await alice.send(`Lounge snapshot https://${picHost}/lounge.png`);
    const snap = bob.message('Lounge snapshot');
    await snap.locator('.embed-ask').waitFor();
    check(!(await snap.locator('img.embed-img').count()) && !picHits.length, `A picture link in a voice chat should wait for a click (fetched ${picHits.join(', ')}).`);
    await snap.locator('.embed-ask button', { hasText: exact('Load image') }).click();
    await bob.message('Lounge snapshot').locator('img.embed-img').waitFor();
    check(picHits.length === 1, `After the click, the picture should load once (fetched ${picHits.join(', ')}).`);
  } finally { await bob.page.unroute(`https://${picHost}/**`); }
  // No threads in a voice channel's chat.
  const onAlice = alice.message('On my way').first();
  await onAlice.hover();
  await onAlice.locator('button[aria-label="Add reaction"]').waitFor();
  check(!(await onAlice.locator('button[aria-label="Reply in thread"]').count()), 'A voice chat message should not offer a thread.');
  // The header's chat button hides and shows it.
  await alice.$('#main-head button[aria-label="Hide chat"]').click();
  await alice.page.waitForSelector('#members', { state: 'hidden' });
  await alice.$('#main-head button[aria-label^="Show chat"]').click();
  await alice.message('On my way').waitFor();
  // Now that Bob has opened it, a new message counts as unread for him while he's elsewhere.
  await bob.openChannel('general');
  await alice.send('Bring snacks');
  await bob.$('#sidebar-body .ch-row.unread').filter({ has: bob.$('.ch-name', { hasText: exact('Lounge') }) }).waitFor();

  // Pinned messages show in the chat's place; Jump goes back to the chat, at the message (bob owns the server since
  // the step-up flow, so he pins).
  await bob.channelRow('Lounge').click({ button: 'right' });
  await bob.menuItem('Open chat').click();
  await bob.send('pin me please zebra');
  await bob.messageAction('pin me please zebra', 'Pin message');
  await bob.toast('Message pinned.');
  await bob.$('#main-head button[aria-label="More"]').click();
  await bob.menuItem('Pinned messages').click();
  await bob.$('#members[data-mode="pins"] .pin-card', { hasText: 'pin me please zebra' }).locator('button', { hasText: 'Jump' }).click();
  await bob.$('#members[data-mode="chat"] #messages .msg.flash', { hasText: 'pin me please zebra' }).waitFor();
  check(!(await bob.$('#toasts .toast', { hasText: 'That message was deleted' }).count()), 'Jump from the pins of a voice chat should find the message.');

  // Two new voice channels whose chats alice has never opened. (Her chat button is set to hide the chat from now on.)
  await alice.$('#main-head button[aria-label="Hide chat"]').click();
  await alice.page.waitForSelector('#members', { state: 'hidden' });
  for (const name of ['Den', 'Nook']) {
    await bob.serverMenu('Create channel');
    const cc = await bob.dialog('Create channel');
    await cc.locator('.radio-card', { hasText: 'Voice' }).click();
    await cc.locator('.field', { hasText: 'Channel name' }).locator('input').fill(name);
    await cc.locator('.modal-foot .btn.primary').click();
    await bob.noModals();
    await alice.channelRow(name).waitFor();
  }
  // Alice picks "All messages" for the Den's chat: from then on it counts for her (an unread dot and the sound).
  await alice.channelRow('Den').click({ button: 'right' });
  const saved = alice.page.waitForResponse((r) => r.url().includes('/api/me/notify/') && r.request().method() === 'PUT');
  await alice.menuItem('All messages').click();
  await saved;
  await bob.channelRow('Den').click({ button: 'right' });
  await bob.menuItem('Open chat').click();
  await bob.$('#members[data-mode="chat"] #composer-input[placeholder="Message \u{1F50A} Den"]').waitFor();
  await bob.send('den news');
  const denId = await bob.message('den news').first().getAttribute('data-mid');
  await alice.$('#sidebar-body .ch-row.unread').filter({ has: alice.$('.ch-name', { hasText: exact('Den') }) }).waitFor();
  await alice.page.waitForFunction((id) => (localStorage.getItem('hearth.notified') || '').includes(id), denId);

  // Alice joins the Nook's call (its chat hidden, never opened): what's said meanwhile counts, and opening the chat
  // puts "New messages" right above it, not above everything said before she came.
  await bob.channelRow('Nook').click({ button: 'right' });
  await bob.menuItem('Open chat').click();
  await bob.$('#members[data-mode="chat"] #composer-input[placeholder="Message \u{1F50A} Nook"]').waitFor();
  await bob.send('before the call 1');
  await bob.send('before the call 2');
  await alice.channelRow('Nook').locator('.ch-main').click();
  await alice.$('#sidebar-body .vc-user', { hasText: 'Alice Wonder' }).waitFor();
  await alice.$('#main-head button[aria-label="Show chat"]').waitFor();
  check(!(await alice.$('#main-head button[aria-label="Show chat"][aria-pressed]').count()), 'The chat button names what it does; it has no pressed state too.');
  await bob.send('during the call');
  await alice.$('#main-head button[aria-label="Show chat \u00b7 new messages"]').click();
  await alice.message('during the call').waitFor();
  await alice.$('#unread-bar', { hasText: '1 new message since' }).waitFor();
  check(await alice.page.evaluate(() => { const d = document.querySelector('#new-div'); return !!(d && d.nextElementSibling && d.nextElementSibling.textContent.includes('during the call')); }),
    '"New messages" should sit right above the message said during the call.');

  // Back to a text channel for whatever runs next (the chat stays closed next time).
  await alice.$('#main-head button[aria-label="Hide chat"]').click();
  await alice.page.waitForSelector('#members', { state: 'hidden' });
  await alice.$('#voice-panel button[aria-label="Leave call"]').click();
  await alice.$('#sidebar-body .vc-user', { hasText: 'Alice Wonder' }).waitFor({ state: 'detached' });
  await alice.openChannel('general');
  await bob.openChannel('general');
}

// ------------------------------------------------------------------ 25. send later (scheduled messages)
async function sendLater(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  const box = alice.$('#composer-input');
  // A right-click on the send button offers the same choices as the clock next to it.
  await box.fill('Scheduled: the pineapple party starts at noon');
  await alice.$('.cw-main .send-btn').click({ button: 'right' });
  await alice.menuItem('Tomorrow morning').waitFor();
  await alice.page.keyboard.press('Escape');
  // The clock: pick "In 1 hour". The box empties and a bar above it says what's waiting.
  await alice.$('.cw-main button[aria-label="Send later"]').click();
  await alice.menuItem('In 1 hour').click();
  await alice.toast('Scheduled for');
  check(!(await box.inputValue()), 'The box should be empty once the message is scheduled.');
  const bar = alice.$('.cw-main .sched-bar');
  await bar.filter({ hasText: '1 message scheduled here' }).waitFor();
  check(!(await bob.message('pineapple party').count()), 'Bob should not see a scheduled message before its time.');

  // The list decrypts it on Alice's device. Edit the words, pick another time, then send it now.
  await bar.locator('button', { hasText: exact('View') }).click();
  const dlg = await alice.dialog('Scheduled messages');
  const item = dlg.locator('.sched-item');
  await item.locator('.sched-text', { hasText: 'the pineapple party starts at noon' }).waitFor();
  check((await item.locator('.sched-when').innerText()).startsWith('Sends '), 'The list should say when it goes out.');
  await item.locator('button', { hasText: exact('Edit') }).click();
  const ed = dlg.locator('textarea.sched-edit');
  await ed.fill('Scheduled: the pineapple party starts at one');
  await ed.press('Enter');
  await item.locator('.sched-text', { hasText: 'starts at one' }).waitFor();
  await item.locator('button', { hasText: exact('Reschedule') }).click();
  await alice.menuItem('Pick a date and time…').click();
  const pick = await alice.dialog('Reschedule');
  const d = new Date(Date.now() + 2 * 86400000);
  d.setHours(15, 30, 0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await pick.locator('input[type="datetime-local"]').fill(local);
  await pick.locator('.modal-foot .btn.primary').click();
  await alice.toast('Rescheduled for');
  await item.locator('.sched-when', { hasText: /3:30/ }).waitFor();
  check(!(await bob.message('pineapple party').count()), 'Editing and rescheduling should not send anything.');
  await item.locator('button', { hasText: exact('Send now') }).click();
  await bob.message('the pineapple party starts at one').waitFor(); // decrypted on bob's device
  check(!(await bob.message('starts at noon').count()), 'Bob should only ever get the edited words.');
  await dlg.locator('.sched-list .panel-empty').waitFor();
  await dlg.locator('.modal-x').click();
  await bar.waitFor({ state: 'detached' });

  // In a DM: schedule, find it from the conversation's ⋯ menu, cancel it. Bob never gets it.
  await alice.railButton('Direct messages');
  await alice.dmRow('bob').click();
  await alice.page.waitForSelector('#composer-input[placeholder="Message bob"]');
  await box.fill('A DM for later that never goes out');
  await alice.$('.cw-main button[aria-label="Send later"]').click();
  await alice.menuItem('In 3 hours').click();
  await alice.toast('Scheduled for');
  await alice.$('#main-head button[aria-label="More"]').click();
  await alice.menuItem('Scheduled messages').click();
  const dm = await alice.dialog('Scheduled messages');
  await dm.locator('.sched-text', { hasText: 'never goes out' }).waitFor();
  await dm.locator('.sched-item button', { hasText: exact('Cancel') }).click();
  const sure = await alice.dialog('Cancel this scheduled message?');
  await sure.locator('.modal-foot .btn.danger').click();
  await dm.locator('.sched-list .panel-empty').waitFor();
  await dm.locator('.modal-x').click();
  await alice.$('.cw-main .sched-bar').waitFor({ state: 'detached' });

  // The key changes while one waits: alice leaves and comes back. Bob's open app re-encrypts his scheduled message
  // with each new key by itself (the server never posts it with the old one), and it still goes out readable.
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.$('#composer-input').fill('Scheduled before the key changed: kiwi');
  await bob.$('.cw-main button[aria-label="Send later"]').click();
  await bob.menuItem('In 3 hours').click();
  await bob.toast('Scheduled for');
  const held = () => t.server.rows("SELECT epoch, status FROM scheduled_messages WHERE status != 'failed' ORDER BY created_at DESC LIMIT 1")[0];
  const first = held();
  check(first && first.status === 'pending', 'The scheduled message should be waiting on the server.');
  await alice.railButton(SERVER);
  await alice.serverMenu('Leave server');
  await alice.modal(`Leave ${SERVER}?`).locator('.modal-foot .btn.danger').click();
  await alice.$(`#rail button[aria-label="${SERVER}"]`).waitFor({ state: 'detached' });
  await alice.join(await bob.inviteLink(), SERVER);
  const keyNow = () => t.server.rows('SELECT key_epoch, needs_rotation FROM servers WHERE name = ?', SERVER)[0];
  for (const until = Date.now() + 30000; ; await new Promise((r) => setTimeout(r, 200))) {
    const row = held(); const k = keyNow();
    if (row && row.status === 'pending' && !k.needs_rotation && row.epoch === k.key_epoch && row.epoch > first.epoch) break;
    check(Date.now() < until, `Bob's app should re-encrypt the held message with the new key (it has epoch ${row && row.epoch}, ${row && row.status}; the server is at ${k.key_epoch}).`);
  }
  await bob.$('.cw-main .sched-bar button', { hasText: exact('View') }).click();
  const kl = await bob.dialog('Scheduled messages');
  await kl.locator('.sched-item .sched-text', { hasText: 'kiwi' }).waitFor();
  await kl.locator('.sched-item button', { hasText: exact('Send now') }).click();
  await kl.locator('.sched-list .panel-empty').waitFor();
  await kl.locator('.modal-x').click();
  // Decrypted on alice's device, with the key made after she came back (older messages from while she was away stay
  // closed to her, as they should).
  await alice.openChannel('general');
  await alice.message('Scheduled before the key changed: kiwi').waitFor();

  // The server (or someone with Bob's session token) slips "held" messages into Bob's list: one of his own old
  // messages from an earlier key, and the same with a made-up copy. His app must never re-encrypt and re-sign them
  // (that would hand the old words to people who joined since, under his name): it re-encrypts only from his own
  // copy, which nobody without his keys can make. They show as unconfirmed, with Cancel only.
  const bobId = await bob.page.evaluate(() => localStorage.getItem('hearth.userId'));
  const hall = t.server.rows('SELECT id, key_epoch FROM servers WHERE name = ?', SERVER)[0];
  const general = t.server.rows("SELECT id FROM channels WHERE server_id = ? AND name = 'general'", hall.id)[0];
  const old = t.server.rows('SELECT ciphertext, epoch FROM messages WHERE author_id = ? AND channel_id = ? AND thread_id IS NULL AND epoch < ? ORDER BY created_at DESC LIMIT 1', bobId, general.id, hall.key_epoch)[0];
  check(old, 'Bob should have an older message in #general from before the key changed.');
  const keys = t.server.rows('SELECT public_key, sign_public_key FROM users WHERE id = ?', bobId)[0];
  const ownKey = crypto.createHash('sha256').update(['c', keys.public_key, keys.sign_public_key].join('|')).digest('base64').slice(0, 24);
  const plant = (id, draft) => t.server.sql(`INSERT INTO scheduled_messages (id, user_id, server_id, channel_id, ciphertext, epoch, ref, draft, own_key, send_at, status, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', 'key', ?, ?)`, id, bobId, hall.id, general.id, old.ciphertext, old.epoch, crypto.randomBytes(12).toString('hex'), draft, ownKey, Date.now() + 2 * 3600000, Date.now(), Date.now());
  plant('plantedold' + crypto.randomBytes(4).toString('hex'), null);
  plant('plantedfake' + crypto.randomBytes(4).toString('hex'), 'x1:' + crypto.randomBytes(120).toString('base64'));
  const patches = [];
  bob.page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/scheduled-messages/')) patches.push(r.url()); });
  await bob.page.reload();
  await bob.waitApp();
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await bob.$('.cw-main .sched-bar', { hasText: '2 messages scheduled here' }).waitFor();
  await bob.$('.cw-main .sched-bar button', { hasText: exact('View') }).click();
  const fake = await bob.dialog('Scheduled messages');
  await fake.locator('.sched-item .sched-text', { hasText: 'can’t confirm you wrote this one' }).nth(1).waitFor();
  for (const card of await fake.locator('.sched-item').all()) {
    const labels = (await card.locator('.sched-actions button').allInnerTexts()).map((x) => x.trim());
    check(labels.join() === 'Cancel', `An unconfirmed scheduled message should only offer Cancel (it offers ${labels.join(', ')}).`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  const planted = t.server.rows("SELECT status, ciphertext, epoch FROM scheduled_messages WHERE id LIKE 'planted%'");
  check(planted.length === 2 && planted.every((x) => x.status === 'held' && x.ciphertext === old.ciphertext && x.epoch === old.epoch),
    'Bob’s app should leave scheduled messages it can’t confirm exactly as they were.');
  check(!patches.length, `Bob’s app should never re-encrypt a scheduled message it can’t confirm (it sent ${patches.length} PATCH requests).`);
  for (const left of [1, 0]) {
    await fake.locator('.sched-item button', { hasText: exact('Cancel') }).first().click();
    await (await bob.dialog('Cancel this scheduled message?')).locator('.modal-foot .btn.danger').click();
    await fake.locator('.sched-item').nth(left).waitFor({ state: 'detached' });
  }
  await fake.locator('.sched-list .panel-empty').waitFor();
  await fake.locator('.modal-x').click();

  // One scheduled from a session that has been signed out since waits for its owner, and one whose time has passed
  // isn't sent by saving an edit without asking. (The server holds it when the session ends; here that's done in
  // the database, along with moving its time three hours back.)
  await alice.$('#composer-input').fill('Scheduled from a laptop: tamarind');
  await alice.$('.cw-main button[aria-label="Send later"]').click();
  await alice.menuItem('In 3 hours').click();
  await alice.toast('Scheduled for');
  const aliceId = await alice.page.evaluate(() => localStorage.getItem('hearth.userId'));
  const tama = t.server.rows("SELECT id FROM scheduled_messages WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", aliceId)[0];
  t.server.sql("UPDATE scheduled_messages SET status = 'held', reason = 'session_ended', send_at = ? WHERE id = ?", Date.now() - 3 * 3600000, tama.id);
  const alicePatches = [];
  alice.page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/scheduled-messages/')) alicePatches.push(r.url()); });
  await alice.page.reload();
  await alice.waitApp();
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  const abar = alice.$('.cw-main .sched-bar', { hasText: '1 scheduled message is waiting for you' });
  await abar.waitFor();
  await abar.locator('button', { hasText: exact('View') }).click();
  const ad = await alice.dialog('Scheduled messages');
  const mcard = ad.locator('.sched-item');
  await mcard.locator('.sched-text', { hasText: 'tamarind' }).waitFor();
  const mwhen = await mcard.locator('.sched-when').innerText();
  check(/^Waiting · was due (today|yesterday) at /.test(mwhen), `The card should say when it was due, mid-sentence (it says “${mwhen}”).`);
  check(!alicePatches.length, 'Alice’s app should not confirm a message from a signed-out session by itself.');
  await mcard.locator('button', { hasText: exact('Edit') }).click();
  const med = ad.locator('textarea.sched-edit');
  await med.fill('Scheduled from a laptop: tamarind and lime');
  await med.press('Enter');
  const late = await alice.dialog('Its time has passed');
  await late.locator('.modal-foot .btn', { hasText: exact('Cancel') }).click();
  await new Promise((r) => setTimeout(r, 500));
  check(t.server.rows('SELECT status FROM scheduled_messages WHERE id = ?', tama.id)[0].status === 'held', 'Saving an edit of an overdue message should ask before sending it.');
  check(!(await bob.message('from a laptop: tamarind').count()), 'Bob should not get it before Alice says so.');
  await med.press('Escape');
  await mcard.locator('button', { hasText: exact('Keep') }).click();
  await (await alice.dialog('Its time has passed')).locator('.modal-foot .btn.primary', { hasText: exact('Send now') }).click();
  await alice.toast('Sent.');
  await bob.message('Scheduled from a laptop: tamarind').waitFor();
  await ad.locator('.sched-list .panel-empty').waitFor();
  await ad.locator('.modal-x').click();
}

// ------------------------------------------------------------------ 26. nicknames
// Alice picks a nickname in the server: bob sees it in the member list, on her messages and in @mention suggestions
// (picking it still writes her username), while her profile card keeps her display name and says what she's called
// here. Bob (the owner) changes it for her from the member menu, then removes it; her own app follows each time,
// and the audit log has all three.
async function nicknames(t) {
  const { alice, bob } = t.people;
  await alice.railButton(SERVER);
  await alice.openChannel('general');
  await bob.railButton(SERVER);
  await bob.openChannel('general');
  await alice.serverMenu('Change nickname');
  const mine = await alice.dialog('Change your nickname');
  await mine.locator('input').fill('Hall Alice');
  await mine.locator('.modal-foot .btn.primary').click();
  await alice.toast('Your nickname in E2E Hall is now Hall Alice.');
  await bob.showMembers();
  await bob.member('Hall Alice').waitFor();
  check(!(await bob.member('Alice Wonder').count()), 'Bob’s member list should show Alice’s nickname instead of her display name.');
  // Bob speaks first, so her message starts a new group and shows her name.
  await bob.send('Anyone here? pear');
  await alice.message('Anyone here? pear').waitFor();
  await alice.send('Nickname check: quince');
  await bob.message('Nickname check: quince').locator('.msg-name', { hasText: 'Hall Alice' }).waitFor();

  // Her profile card leads with her display name, and says what she goes by here.
  await bob.member('Hall Alice').click();
  const pop = bob.page.locator('.pop-profile');
  await pop.locator('.pc-name', { hasText: 'Alice Wonder' }).waitFor();
  await pop.locator('.pc-nick', { hasText: 'Hall Alice' }).waitFor();
  await bob.page.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached' });

  // @mention suggestions find her by the nickname and show it; picking her writes her username.
  const box = bob.$('#composer-input');
  await box.fill('@hall');
  const suggestion = bob.page.locator('.suggest-item', { hasText: 'Hall Alice' });
  await suggestion.waitFor();
  await suggestion.click();
  const written = await box.inputValue();
  check(/^@alice\w* $/.test(written), `Picking the suggestion should write her username, not the nickname (wrote “${written}”).`);
  await box.fill('');

  // Bob is above her: he changes it from the member menu, and her own app follows.
  await bob.member('Hall Alice').click({ button: 'right' });
  await bob.menuItem('Change nickname…').click();
  let theirs = await bob.dialog('Change Alice Wonder');
  await theirs.locator('input').fill('Quince Queen');
  await theirs.locator('.modal-foot .btn.primary').click();
  await bob.noModals();
  await alice.showMembers();
  await alice.member('Quince Queen').waitFor();
  // Removing it: back to her display name in the server, on her messages too.
  await bob.member('Quince Queen').click({ button: 'right' });
  await bob.menuItem('Change nickname…').click();
  theirs = await bob.dialog('Change Alice Wonder');
  await theirs.locator('.modal-foot .btn', { hasText: 'Remove nickname' }).click();
  await bob.noModals();
  await alice.member('Alice Wonder').waitFor();
  await bob.message('Nickname check: quince').locator('.msg-name', { hasText: 'Alice Wonder' }).waitFor();

  // The server's audit log has each change, the first marked as her own.
  await bob.serverMenu('Server settings');
  const ss = bob.page.locator('.modal.server-settings');
  await ss.locator('.ss-tab', { hasText: exact('Audit log') }).click();
  await ss.locator('.audit-row', { hasText: 'Alice Wonder set their nickname to “Hall Alice”' }).waitFor();
  await ss.locator('.audit-row', { hasText: 'bob changed the nickname of Alice Wonder from “Hall Alice” to “Quince Queen”' }).waitFor();
  await ss.locator('.audit-row', { hasText: 'bob removed the nickname of Alice Wonder (“Quince Queen”)' }).waitFor();
  await ss.locator('.modal-x').click();
  await bob.noModals();
}

export const FLOWS = [
  ['accounts: register two people, sign out and back in', accounts],
  ['servers: create a server, invite, join', servers],
  ['messages: send, decrypt, edit, react, thread, delete, reply, pin, poll', messages],
  ['webhooks: make one in channel settings, post like Uptime Kuma, no pings', webhooks],
  ['direct messages: both ways, block and unblock, friends', directMessages],
  ['disappearing messages: turn on in a DM, a picture vanishes on both screens with its file and inbox entry, turn off, day dividers, asked before sending under a weaker timer; a channel message goes by the apps’ own timer', disappearing],
  ['attachments: image preview, byte-exact download, storage', attachments],
  ['pictures: avatar, custom emoji, server icon, GIF library', pictures],
  ['search: Ctrl+K words, from:, jump to the message', search],
  ['settings: display name, username, signed-in devices', settings],
  ['roles: private channel, overrides, Manage channels role', roles],
  ['self-assign roles: marked in the role editor, picked by a member, opens a private channel', selfRoles],
  ['events: a weekly event, RSVP, stop it repeating', events],
  ['voice: two people connected in a call', voiceCall],
  ['moderator toolkit: server mute in and out of a call, bulk delete', moderatorTools],
  ['watch together: start, pause for everyone, stop; a video file from another site says so before it loads; leave the call', watchTogether],
  ['audit log and reports: moderation as sentences, filters, live entries; a report reaches the server’s moderators', auditAndReports],
  ['dm call: ring, accept, hang up, decline', dmCall],
  ['group chat: create, talk both ways, call rings', groupChat],
  ['android app: push through a push app, call notification and hang up, invite link (native side simulated)', androidApp],
  ['step-up: delete and hand over a server, staff, relay, region, backups, owner', stepUp],
  ['account deletion: a throwaway account deletes itself', deleteAccount],
  ['recovery: recovery key, email, password change, reset by email keeps messages', recovery],
  ['two-factor: turn on, sign in with a backup code, turn off with one code', twoFactor],
  ['rejoin: leave and come back without the old role or channel access, messages still flow both ways', rejoin],
  ['instance: new owner removes staff, announces, maintenance on and off', broadcastAndMaintenance],
  ['moderation: staff sign-out and suspension say why; unsuspend', moderation],
  ['smoke: every settings, admin and server settings page loads', smoke],
  ['threads: new replies and pings on the message and the Threads button, the Threads panel, read when opened', threads],
  ['link previews: ask, turn down, preview, send; the reader sees the card and never contacts the site; keyboard; editing a link in Always mode', linkPreviews],
  ['outside images: a picture link waits for a click and loads after it; Never and Always load; fonts come from Hearth', outsideImages],
  ['discord import: paste a template, see what is skipped, leave some out, create', discordImport],
  ['channel order: drag a channel into a category and a category above another, live for everyone; Move down by keyboard keeps focus (into a collapsed category too); a menu left open doesn’t undo another move', channelOrder],
  ['away and status: Away after inactivity and back on input; a custom status that clears itself, live', awayAndStatus],
  ['voice chat: open beside the call, both ways, a picture link from another site waits for a click, no threads, unread only once opened, pings always, pins, All messages, in a call', voiceChat],
  ['send later: schedule from the send button, edit, reschedule and send now from the list; cancel one in a DM; re-encrypted by itself when the key changes, never from a copy it can’t confirm; a signed-out session’s message waits for Keep; overdue ones ask first', sendLater],
  ['nicknames: set your own, seen in the member list, messages and @mention suggestions; a moderator changes and removes it; audit log', nicknames],
];
