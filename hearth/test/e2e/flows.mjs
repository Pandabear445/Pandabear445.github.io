// The end-to-end flows, in order: each one builds on what the earlier ones set up (accounts, the server, roles…).
// Everything goes through the real UI; the only shortcuts are reading state the UI already shows.
import fs from 'node:fs';
import { exact, makePng, totp } from './harness.mjs';

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

  // Leaving: bob first (alice sees him go), then alice from the call bar.
  await bob.$('.voice-room .cs-controls button[aria-label="Leave call"]').click();
  await alice.$('.voice-room .cs-tile', { hasText: 'bob' }).waitFor({ state: 'detached' });
  await alice.$('#voice-panel button[aria-label="Leave call"]').click();
  await alice.page.waitForSelector('#voice-panel', { state: 'hidden' });
  await bob.page.waitForSelector('#voice-panel', { state: 'hidden' });
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
  const { alice } = t.people;
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

export const FLOWS = [
  ['accounts: register two people, sign out and back in', accounts],
  ['servers: create a server, invite, join', servers],
  ['messages: send, decrypt, edit, react, thread, delete, reply, pin, poll', messages],
  ['direct messages: both ways, block and unblock, friends', directMessages],
  ['attachments: image preview, byte-exact download, storage', attachments],
  ['pictures: avatar, custom emoji, server icon, GIF library', pictures],
  ['search: Ctrl+K words, from:, jump to the message', search],
  ['settings: display name, username, signed-in devices', settings],
  ['roles: private channel, overrides, Manage channels role', roles],
  ['voice: two people connected in a call', voiceCall],
  ['watch together: start, pause for everyone, stop; leave the call', watchTogether],
  ['dm call: ring, accept, hang up, decline', dmCall],
  ['group chat: create, talk both ways, call rings', groupChat],
  ['step-up: delete and hand over a server, staff, relay, region, backups, owner', stepUp],
  ['account deletion: a throwaway account deletes itself', deleteAccount],
  ['recovery: recovery key, email, password change, reset by email keeps messages', recovery],
  ['two-factor: turn on, sign in with a backup code, turn off with one code', twoFactor],
  ['rejoin: leave and come back without the old role or channel access, messages still flow both ways', rejoin],
  ['instance: new owner removes staff, announces, maintenance on and off', broadcastAndMaintenance],
  ['moderation: staff sign-out and suspension say why; unsuspend', moderation],
  ['smoke: every settings, admin and server settings page loads', smoke],
];
