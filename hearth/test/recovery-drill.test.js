// The recovery drill (scripts/recovery-drill.js), step by step: password change, resets with and without a recovery
// key, a lost authenticator, a revoked device, removal and key rotation, new devices, and a full encrypted backup
// restored with the CLI onto a new server. Real client crypto throughout. Each step builds on the one before.
const { test, before, after } = require('node:test');
const { createDrill } = require('../scripts/recovery-drill');

const drill = createDrill();
before(() => drill.setup());
after(() => drill.teardown());
for (const s of drill.steps) test(`drill: ${s.title}`, async (t) => { for (const f of (await s.run()) || []) t.diagnostic(f); });
