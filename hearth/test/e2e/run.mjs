#!/usr/bin/env node
// Hearth end-to-end suite: drives the real web app in Chromium as several people at once, against a fresh
// server, and checks what they actually see (decrypted messages, files, calls, admin changes…).
//
//   npm run test:e2e                 headless; prints where the failure report went if something breaks
//   node test/e2e/run.mjs --headed   watch it (needs a display)
//   node test/e2e/run.mjs --keep     keep the server's data folder afterwards, with server.log and each browser's
//                                    console log (<name>.console.log) in it
//   node test/e2e/run.mjs --slow=250 slow every browser action down (ms)
//   node test/e2e/run.mjs --until=search   stop after the first flow whose name contains "search"
//
// The flows run in order and share state (the accounts, the server, the roles…), so the first failure stops
// the run. Its report (a screenshot, the page and the console log of every open browser, and the server log)
// lands in a new folder under the system's temp folder, whose path is printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Person, launchBrowser, newPassword, startServer } from './harness.mjs';
import { FLOWS, check } from './flows.mjs';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const headed = !!opt('headed');
const keep = !!opt('keep');
const slowMo = Number((opt('slow') || '').split('=')[1]) || 0;
const until = (opt('until') || '').split('=').slice(1).join('=');
// One flow may take this long before it counts as stuck (registration hashes passwords on purpose: it's slow).
const FLOW_TIMEOUT = Number(process.env.E2E_FLOW_TIMEOUT) || 240000;

const started = Date.now();
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// Later flows build on earlier ones, so --until runs everything up to (and including) the one named.
const last = until ? FLOWS.findIndex(([name]) => name.includes(until)) : FLOWS.length - 1;
const flows = FLOWS.slice(0, last + 1);

async function main() {
  if (last < 0) throw new Error(`No flow matches --until=${until}`);
  const server = await startServer();
  const browser = await launchBrowser({ headed, slowMo });
  const t = {
    server, browser, people: {}, state: {},
    // Fresh passwords every run (none are kept in the repository).
    pw: { alice: newPassword(), bob: newPassword(), carl: newPassword(), relay: newPassword() },
    async open(name) { const p = await Person.open(browser, server.base, name); t.people[name] = p; return p; },
  };
  console.log(`Hearth e2e: server ${server.base} (data ${server.dir})`);
  let failure = null;
  let passed = 0;
  for (const [name, fn] of flows) {
    const t0 = Date.now();
    try {
      let timer;
      await Promise.race([fn(t), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${secs(FLOW_TIMEOUT)}`)), FLOW_TIMEOUT); })])
        .finally(() => clearTimeout(timer));
      passed++;
      console.log(`  ok   ${name} (${secs(Date.now() - t0)})`);
    } catch (e) {
      console.log(`  FAIL ${name} (${secs(Date.now() - t0)})`);
      failure = { name, error: e };
      break;
    }
  }
  // After the flows: nothing in any page threw an uncaught error, and the server never answered with a 5xx.
  if (!failure) {
    try {
      const people = Object.values(t.people);
      const thrown = people.flatMap((p) => p.pageErrors.map((m) => `${p.name}: ${m}`));
      check(!thrown.length, `Uncaught errors in the app:\n  ${thrown.join('\n  ')}`);
      const broken = people.flatMap((p) => p.serverErrors.map((m) => `${p.name}: ${m}`));
      check(!broken.length, `Server errors (5xx):\n  ${broken.join('\n  ')}`);
      console.log('  ok   no uncaught page errors, no server errors');
    } catch (e) { failure = { name: 'page and server errors', error: e }; }
  }

  if (failure) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-e2e-failure-'));
    const err = failure.error;
    fs.writeFileSync(path.join(dir, 'error.txt'), `${failure.name}\n\n${err && err.stack ? err.stack : err}\n`);
    for (const p of Object.values(t.people)) await p.capture(dir).catch(() => {});
    fs.writeFileSync(path.join(dir, 'server.log'), server.log);
    console.log(`\n${failure.name}:\n${String(err && err.message ? err.message : err).split('\n').map((l) => `  ${l}`).join('\n')}`);
    console.log(`\nFailure report (screenshots, pages, console logs, server log): ${dir}`);
  }
  await browser.close().catch(() => {});
  await server.stop({ keep });
  if (keep) {
    fs.writeFileSync(path.join(server.dir, 'server.log'), server.log);
    for (const p of Object.values(t.people)) fs.writeFileSync(path.join(server.dir, `${p.name.replace(/\W+/g, '_')}.console.log`), p.log.join('\n') + '\n');
    console.log(`Data and logs kept in ${server.dir}`);
  }
  console.log(`\n${passed}/${flows.length} flows passed in ${secs(Date.now() - started)}${failure ? '' : ', all good'}.`);
  process.exitCode = failure ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
