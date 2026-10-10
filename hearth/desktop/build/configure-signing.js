// Picks how the Windows installer gets signed, from the GitHub secrets / variables that exist
// (see hearth/docs/SIGNING.md). Run by .github/workflows/hearth-apps.yml before electron-builder; it edits
// package.json's "build" section in the CI checkout only. Never prints a secret.
//
//   1. Azure Artifact Signing (formerly Trusted Signing), when AZURE_TENANT_ID, AZURE_CLIENT_ID,
//      AZURE_CLIENT_SECRET, AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE and
//      AZURE_SIGNING_PUBLISHER are set.
//   2. A code-signing certificate file (.pfx), when WIN_CSC_LINK (+ WIN_CSC_KEY_PASSWORD) is set.
//   3. SignPath (free for open-source projects, through the SignPath Foundation), when SIGNPATH_API_TOKEN,
//      SIGNPATH_ORGANIZATION_ID and SIGNPATH_PROJECT_SLUG are set. Only release builds are signed this way
//      (tags, the default branch and manual runs: SIGN_THIS_BUILD=true), because each signing request waits
//      for your approval on signpath.io. The workflow does the signing after electron-builder; here we only
//      record the publisher name the installed app will expect on updates.
//   4. Otherwise unsigned, with a warning in the build log. WINDOWS_REQUIRE_SIGNING=true turns that warning
//      into a failed build (use it once you sign: installed signed apps refuse unsigned updates).
//
// Writes "method=azure|pfx|signpath|none" to $GITHUB_OUTPUT when it exists.
const fs = require('fs');
const path = require('path');

const env = (k) => String(process.env[k] || '').trim();
const has = (...keys) => keys.every((k) => env(k) !== '');
const pkgFile = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const win = (pkg.build.win = { ...(pkg.build.win || {}) });
delete win.azureSignOptions;
delete win.signtoolOptions;

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice title=Windows signing::${msg}` : msg);
const warn = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning title=Windows signing::${msg}` : `WARNING: ${msg}`);
const fail = (msg) => { console.log(process.env.GITHUB_ACTIONS ? `::error title=Windows signing::${msg}` : `ERROR: ${msg}`); process.exit(1); };

let method = 'none';
const azureSome = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'AZURE_SIGNING_PUBLISHER'];
if (has(...azureSome)) {
  const endpoint = env('AZURE_SIGNING_ENDPOINT');
  if (!/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/i.test(endpoint)) fail(`AZURE_SIGNING_ENDPOINT should look like https://eus.codesigning.azure.net (got "${endpoint}").`);
  win.azureSignOptions = {
    // Exactly the CN on the certificate (your validated legal name or company name, as shown on the certificate
    // profile in Azure). The installed app keeps it and only accepts updates signed with that same name.
    publisherName: env('AZURE_SIGNING_PUBLISHER'),
    endpoint: endpoint.replace(/\/$/, ''),
    codeSigningAccountName: env('AZURE_SIGNING_ACCOUNT'),
    certificateProfileName: env('AZURE_SIGNING_PROFILE'),
  };
  method = 'azure';
  notice(`Signing with Azure Artifact Signing (account ${env('AZURE_SIGNING_ACCOUNT')}, profile ${env('AZURE_SIGNING_PROFILE')}).`);
} else if (has('WIN_CSC_LINK')) {
  // electron-builder reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD itself; the publisher name comes from the certificate.
  win.signtoolOptions = { signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: env('WIN_TIMESTAMP_SERVER') || 'http://timestamp.digicert.com' };
  if (env('WIN_PUBLISHER_NAME')) win.signtoolOptions.publisherName = env('WIN_PUBLISHER_NAME');
  method = 'pfx';
  notice('Signing with the certificate in WIN_CSC_LINK.');
} else if (has('SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG') && /^true$/i.test(env('SIGN_THIS_BUILD'))) {
  // The certificate belongs to the SignPath Foundation, so that's the publisher Windows shows and the name the
  // installed app checks on every update.
  win.signtoolOptions = { publisherName: [env('SIGNPATH_PUBLISHER') || 'SignPath Foundation'] };
  method = 'signpath';
  notice(`Signing with SignPath (project ${env('SIGNPATH_PROJECT_SLUG')}). Approve the signing requests on signpath.io when they appear.`);
} else if (has('SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG')) {
  notice('SignPath signs release builds only (app-v* tags, the default branch and manual runs). This build is NOT signed: don\'t hand it out.');
} else {
  const partial = azureSome.filter((k) => env(k) !== '');
  if (partial.length) warn(`Some Azure signing settings are set (${partial.join(', ')}) but not all of them, so the build is NOT signed. See hearth/docs/SIGNING.md.`);
  if (/^(1|true|yes)$/i.test(env('WINDOWS_REQUIRE_SIGNING'))) fail('WINDOWS_REQUIRE_SIGNING is on but no signing secrets are available (forks and Dependabot runs don\'t get secrets).');
  warn('The Windows installer is NOT signed: Windows shows "Windows protected your PC / Unknown publisher". To sign it, see hearth/docs/SIGNING.md.');
}

fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `method=${method}\n`);
