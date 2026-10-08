# Getting rid of the "Windows protected your PC" and "unknown app" warnings

This page explains, in plain language, why Windows and Android warn people before they install the Hearth
apps, what you can buy or set up to make those warnings go away (or get smaller), what it costs, and exactly
which GitHub settings to fill in. The build (`.github/workflows/hearth-apps.yml`) already knows how to sign:
it signs automatically as soon as the secrets below exist, and builds unsigned apps (like today) when they
don't.

Prices and rules below were checked in October 2026. They change, so check the linked pages before paying.

> **Never paste a secret (password, key file, client secret, service account JSON) into a chat, an issue, a
> commit or a file in this repository.** Secrets only go into GitHub: your repository → **Settings → Secrets
> and variables → Actions**. "Secrets" are hidden; "Variables" are visible settings that aren't secret.

## Short version

| Warning | What fixes it | Cost | Effort |
|---|---|---|---|
| Windows: "Windows protected your PC", "Unknown publisher" | Sign the installer: **Azure Artifact Signing** (recommended) | about **$9.99 / month** | an evening, plus a few days for the ID check |
| Windows: SmartScreen still warns about a *signed* installer for a while | Nothing to buy; it fades as people download it (reputation) | free | wait |
| Android: "Install unknown apps", Play Protect "unrecognised app" | Install from **Google Play** (internal testing for friends) | **$25 once** | an evening, plus Google's ID check |
| Browser padlock / "Not secure" on your website | Already done: Caddy gets a real TLS certificate | free | none |

## First: the website certificate is a different thing

Your Hearth website (for example `https://kappachat.duckdns.org`) already has a real **TLS certificate**
(what people often call "SSL"). Caddy gets it from Let's Encrypt and renews it by itself. That's what makes
the padlock appear and keeps the connection private.

**Code signing** is something else: a digital signature on the *app file* (`Hearth-Setup.exe`, the Android
app) that says who made it and proves nobody changed it after. Windows and Android look at that signature,
not at your website's certificate, when they decide whether to warn. A TLS certificate can't be used to sign
apps, and a code-signing certificate doesn't help the website.

---

## Windows

### Why Windows warns

1. **Unsigned file → "Unknown publisher".** The installer isn't signed today, so Windows can't show who made it.
2. **SmartScreen → "Windows protected your PC".** Microsoft Defender SmartScreen warns about any download it
   hasn't seen many people run safely yet ("reputation"). It checks this even for signed files.

Signing fixes (1) right away: Windows shows **your name** as the publisher instead of "Unknown publisher",
and nobody can change the file without breaking the signature. For (2): SmartScreen reputation for a signed app builds up
over time as people download and run it. A small group of friends may still see "Windows protected your PC"
for the first days or weeks after you start signing; they click **More info → Run anyway** (now with your
name shown). It gets better as more people install it. You can also submit a signed installer for review at
[Microsoft Security Intelligence](https://www.microsoft.com/wdsi/filesubmission) if the warning sticks around.

Good to know:
- **EV certificates no longer skip SmartScreen.** Since 2024, "Extended Validation" certificates don't get
  instant reputation any more. They cost more and are meant for companies; they aren't worth it here.
- **Auto-updates are fine either way.** The app updates itself from your server. Once you sign, the installed
  app only accepts updates signed with the **same publisher name** (see "Keep signing once you start").

### Option A (recommended): Azure Artifact Signing, about $9.99/month

Microsoft's own signing service (it used to be called *Trusted Signing*). Microsoft checks your identity once,
keeps the signing key in their vault, and the GitHub build asks it to sign each release. Nothing to plug in,
nothing to lose.

**Cost:** the **Basic** plan is **$9.99 per month** and includes 5,000 signatures (each build uses a handful);
more cost $0.005 each. It needs a **paid** Azure subscription (pay-as-you-go with a card; the free trial
doesn't work). Cancel by deleting the signing account; you're billed while it exists.

**Who can get it:** individual developers in the **USA or Canada**, or organisations in the USA, Canada, the
EU, the UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel (Microsoft's
list as of May 2026). For an individual, your Azure billing account must be of type **Individual**, and the
legal name and address on it must match your government ID. (Microsoft paused new individual sign-ups for a
while in 2025; if the portal won't let you start an *Individual* identity validation, that's why. Option B
still works.)

**Step by step** (in the [Azure portal](https://portal.azure.com)):

1. **Create an Azure account** with a pay-as-you-go subscription. Check *Cost Management + Billing → Billing
   account → Properties*: account type *Individual*, and your legal name and address exactly as on your ID.
2. **Turn the service on:** *Subscriptions →* your subscription *→ Resource providers →* `Microsoft.CodeSigning`
   *→ Register*.
3. **Create the signing account:** search for **Artifact Signing Accounts → Create**. Pick a resource group
   (e.g. `hearth-signing`), an account name (e.g. `hearthsigning`, letters and numbers), a region (e.g.
   *East US*), and the **Basic** pricing tier. Write down the region's endpoint:

   | Region | Endpoint |
   |---|---|
   | East US | `https://eus.codesigning.azure.net` |
   | West US | `https://wus.codesigning.azure.net` |
   | West US 2 | `https://wus2.codesigning.azure.net` |
   | West US 3 | `https://wus3.codesigning.azure.net` |
   | Central US | `https://cus.codesigning.azure.net` |
   | North Central US | `https://ncus.codesigning.azure.net` |
   | South Central US | `https://scus.codesigning.azure.net` |
   | West Central US | `https://wcus.codesigning.azure.net` |
   | North Europe | `https://neu.codesigning.azure.net` |
   | West Europe | `https://weu.codesigning.azure.net` |

   (Other regions: see Microsoft's quickstart linked at the end.)
4. **Prove who you are:** in the signing account, *Access control (IAM) → Add role assignment →*
   **Artifact Signing Identity Verifier** *→* yourself. Then *Identity validations →* choose **Individual →
   New identity → Public**, pick your billing account and create it. When it says *Action Required*, open the
   link and follow it: you'll verify your ID with a partner (AU10TIX) using your phone's camera and the
   **Microsoft Authenticator** app. It usually completes within a few days. Watch your email: links expire
   after 7 days.
5. **Create a certificate profile:** *Certificate profiles → Create →* **Public Trust**, name it (e.g. `hearth`)
   and select your validated identity. The **certificate subject preview** shows `CN=…`, normally your full
   legal name. That exact text is your **publisher name**; Windows shows it to people.
6. **Make a login for GitHub:** *Microsoft Entra ID → App registrations → New registration* (name it
   `hearth-github-signing`, defaults are fine). On its overview page copy the **Application (client) ID** and
   the **Directory (tenant) ID**. Then *Certificates & secrets → New client secret* and copy the secret's
   **Value** straight into GitHub (step 8). It expires (at most 24 months): put a reminder in your calendar.
7. **Let that login sign:** back on the signing account (or just the certificate profile), *Access control
   (IAM) → Add role assignment →* **Artifact Signing Certificate Profile Signer** *→ User, group or service
   principal →* select `hearth-github-signing`. (Older portal pages call the roles "Trusted Signing …".)
8. **Fill in GitHub:** your repository → *Settings → Secrets and variables → Actions*.

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `AZURE_TENANT_ID` | Directory (tenant) ID from step 6 |
   | Secret | `AZURE_CLIENT_ID` | Application (client) ID from step 6 |
   | Secret | `AZURE_CLIENT_SECRET` | the client secret *Value* from step 6 |
   | Variable | `AZURE_SIGNING_ENDPOINT` | the endpoint from step 3, e.g. `https://eus.codesigning.azure.net` |
   | Variable | `AZURE_SIGNING_ACCOUNT` | the account name from step 3, e.g. `hearthsigning` |
   | Variable | `AZURE_SIGNING_PROFILE` | the certificate profile name from step 5, e.g. `hearth` |
   | Variable | `AZURE_SIGNING_PUBLISHER` | the publisher name from step 5, exactly, e.g. `Jane Q Doe` (without `CN=`) |

9. **Build:** *Actions → Hearth apps → Run workflow*. In the Windows job you should see a note
   **"Signing with Azure Artifact Signing"** and a **Check the signature** step that prints `Valid` and your
   name. Download the installer and check: right-click → *Properties → Digital Signatures*.
10. Once a signed version is out, set the variable **`WINDOWS_REQUIRE_SIGNING`** to `true` (see below).

### Option B: a code-signing certificate file (.pfx)

If you already have a code-signing certificate as a `.pfx` file (an older certificate, or one from a provider
that lets you export it), the build can use it:

| Kind | Name | Value |
|---|---|---|
| Secret | `WIN_CSC_LINK` | the `.pfx` file as base64 (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`, macOS/Linux: `base64 -i cert.pfx`) |
| Secret | `WIN_CSC_KEY_PASSWORD` | the `.pfx` password |
| Variable (optional) | `WIN_PUBLISHER_NAME` | only if the name to check differs from the certificate's own name |

The publisher name is read from the certificate automatically. Azure (option A) wins if both are set up.

**Buying one new mostly doesn't fit this route:** since June 2023 every new code-signing certificate's key
must live on a hardware token (a USB stick) or the seller's cloud vault, so it can't be exported as a `.pfx`
for GitHub to use. Using a cloud-vault certificate from GitHub needs that seller's own signing tool
(DigiCert KeyLocker, SSL.com eSigner, Certum SimplySign…), which this workflow doesn't set up. Rough prices for
an "OV" certificate in 2026: about $200–$450 per year (Sectigo through resellers ≈ $220/year, DigiCert ≈
$440/year, Certum's cloud certificate less), and since March 2026 a certificate is valid for at most about 15
months, so you renew yearly. For one person, option A is cheaper and simpler.

If Hearth stays open source, the [SignPath Foundation](https://signpath.org/) signs qualifying open-source
projects for free (strict rules, and it needs their own GitHub integration).

### Option C: stay unsigned

Without any of the above, the build makes an unsigned installer, as before, and prints a warning in the build
log. People click **More info → Run anyway** once.

### Keep signing once you start

When the app is signed, the installed app remembers the publisher name and only installs updates signed with
**that same name** (a protection: someone who breaks into your server can't push a fake update). So:

- **Set `WINDOWS_REQUIRE_SIGNING=true`** (a repository *variable*) after your first signed release. Then a build
  fails, instead of quietly producing an unsigned installer, if the secrets are missing or expired. An unsigned
  update would otherwise be refused by everyone's app ("not signed by the application owner") and they'd have
  to reinstall by hand.
- **Renew the Azure client secret** before it expires (step 6), and keep the Azure subscription paid.
- **Don't change the publisher name.** If it must change (you switch from your name to a company, or from
  option B to A with a different name), people need to download the new installer once from your server's
  `/download` page.
- Going from unsigned to signed is no problem: today's unsigned app accepts the first signed update.

---

## Android

### Why Android warns

When people install the APK from your server, Android asks them to allow **"Install unknown apps"** for their
browser or file manager, and **Google Play Protect** may say the app is unrecognised and offer to scan it.
Those warnings come with installing outside Google Play; signing the APK can't remove them. (The APK is
already signed, so updates install over the top; that part is fine.)

The way to avoid them: **install through Google Play.** You don't have to publish Hearth to the whole world:
Play's **internal testing** track lets you invite up to 100 people by email. They tap a link once, install
Hearth from the Play Store with no warnings, and get updates automatically.

### Google's developer verification (2026)

Google is also starting to require that apps on certified Android phones come from **verified developers**,
including apps installed outside Play. It starts with Brazil, Indonesia, Singapore and Thailand
(scheduled for 30 September 2026) and is planned to reach everywhere in 2027. What it means for Hearth:

- If you use Google Play (below), you're verified through your Play Console account. Register the package name
  `app.hearth.mobile` there too, with the APK signed by the key from the `ANDROID_KEYSTORE_*` secrets, so the
  APK from your server counts as yours.
- Without Play, you can verify for free in Google's **Android Developer Console**. There's also a free
  "limited distribution" account for students and hobbyists that allows installs on up to 20 devices.
- Phones in those countries that install an app from an unverified developer get extra steps (an "advanced"
  flow with a waiting period), and `adb install` keeps working for technical users.

Details change; see [developer.android.com/developer-verification](https://developer.android.com/developer-verification).

### Google Play internal testing: step by step

**Cost:** **$25 once** for a Google Play developer account. Google verifies your identity (government ID, and
for new personal accounts an Android phone for verification). Internal testing has **no review wait and no
"12 testers for 14 days" rule**; that rule only applies before publishing publicly (production).

1. **Use a permanent signing key** (if you haven't yet), as described in `hearth/mobile/README.md` → *Signing*:
   make `hearth.jks` and add the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. With them, every build also makes a Google Play bundle (`.aab`,
   in the run's artifacts as **hearth-android-play-bundle**). Back up `hearth.jks` somewhere safe.
2. **Create the developer account** at [play.google.com/console](https://play.google.com/console) (*personal*
   account is fine), pay the $25 and finish identity verification.
3. **Create the app:** *Create app →* name `Hearth`, *App*, *Free*. The package name is fixed by the first upload
   and must be unique on all of Google Play: it's `app.hearth.mobile`. (If Play says it's taken, the app id in
   `hearth/mobile/capacitor.config.json`, the folder in the workflow's `cp native/MainActivity.java …` line, the
   `package` line in `MainActivity.java` and `packageName` in the workflow all have to change together.)
4. **App signing:** when Play asks about *Play App Signing*, choose to **use your own key** (*"Use a key from
   Android Studio" / "Export and upload a key from Java keystore"*, which uses Google's small PEPK tool on
   `hearth.jks`). Then the Play version and the APK on your server have the same signature, and people can
   move between them without uninstalling. (If you let Google make a new key instead, your key becomes only
   the "upload key" and the two versions can't update each other.)
5. **First upload by hand:** *Test and release → Testing → Internal testing → Create new release*, upload the
   `.aab` from the latest workflow run's **hearth-android-play-bundle** artifact, and roll it out.
6. **Fill in the required forms** under *Policy → App content*: privacy policy (a URL; required because the app
   uses the microphone and camera; your server's terms/privacy page is fine), data safety, ads (none),
   content rating, target audience, and app access (give a test login, since the app needs an account).
7. **Add testers:** *Internal testing → Testers →* create an email list with your friends' Google account
   emails, save, and send them the **opt-in link**. They accept once, then install Hearth from the Play Store.
8. **Automatic uploads from GitHub:**
   1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, enable the
      **Google Play Android Developer API**, then *IAM & Admin → Service accounts → Create service account*
      (no roles needed). Open it → *Keys → Add key → JSON*: a `.json` file downloads.
   2. In Play Console → *Users and permissions → Invite new users*, enter the service account's email
      (`…@….iam.gserviceaccount.com`), and under *App permissions* add Hearth with **Release to testing tracks**.
   3. In GitHub add the secret **`PLAY_SERVICE_ACCOUNT_JSON`** with the whole contents of that `.json` file,
      then delete the file from your computer.
   4. If Play still shows the app as a *draft* (it hasn't finished step 5), add the variable
      `PLAY_RELEASE_STATUS` = `draft` until it has; then remove it.

   From then on, every `app-v*` tag, every push to the default branch that changes the apps, and every manual
   run uploads the new bundle to internal testing, and your testers' phones update by themselves.

**Version numbers:** Android and Play only accept an update with a higher *versionCode*. The workflow sets it
to `(major × 100 + minor) × 100000 + run number`, e.g. `12100457` for Hearth 1.21 in workflow run 457, so it
always goes up.

**Things Google's review might flag:** Hearth's Android app lets people trust a self-signed server certificate
after showing its fingerprint. Google Play's automated checks sometimes flag apps that can accept certificate
errors. If that happens, servers with a real domain (Caddy) don't need that feature, and it can be left out of
the Play build.

---

## Where each secret and variable goes

All in GitHub: your repository → *Settings → Secrets and variables → Actions*.

| Name | Kind | For |
|---|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Secret | Windows, option A |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_PUBLISHER` | Variable | Windows, option A |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Secret | Windows, option B |
| `WIN_PUBLISHER_NAME`, `WIN_TIMESTAMP_SERVER` | Variable (optional) | Windows, option B |
| `WINDOWS_REQUIRE_SIGNING` | Variable | `true` = fail instead of building unsigned |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Secret | Android signing key, Play bundle |
| `PLAY_SERVICE_ACCOUNT_JSON` | Secret | upload to Play internal testing |
| `PLAY_RELEASE_STATUS` | Variable (optional) | `draft` while the Play app is still a draft |

Forks and Dependabot runs don't get your secrets; their builds are simply unsigned.

## Mac

The Mac build stays unsigned (signing and notarising needs Apple's Developer Program, $99/year). Mac users
right-click the app → *Open* the first time, and download new versions from your server's `/download` page.

## Sources

- Microsoft: [Artifact Signing quickstart](https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/artifact-signing/quickstart.md),
  [FAQ](https://learn.microsoft.com/azure/artifact-signing/faq),
  [pricing](https://azure.microsoft.com/pricing/details/artifact-signing/)
- Microsoft: [SmartScreen reputation for app developers](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)
- electron-builder: [Windows code signing](https://www.electron.build/code-signing-win)
- Google: [Android developer verification](https://developer.android.com/developer-verification),
  [rollout announcement](https://android-developers.googleblog.com/2026/03/android-developer-verification-rolling-out-to-all-developers.html),
  [target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)
- Google: [Play Console internal testing](https://support.google.com/googleplay/android-developer/answer/9845334),
  [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [SignPath Foundation](https://signpath.org/) (free signing for open-source projects)
