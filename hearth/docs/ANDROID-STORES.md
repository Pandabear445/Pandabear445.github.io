# Putting Hearth for Android in app stores

This page takes you, step by step, from "the APK is on GitHub" to Hearth in **IzzyOnDroid** and in **Google
Play internal testing** (invite only, up to 100 testers). Public Google Play and F-Droid come later; the end of
this page says what they need. It's written for Windows: where you type a command, open PowerShell (in File
Explorer, go to the folder, click the address bar, type `powershell` and press Enter).

The plan, in order:

1. [Test on your own phone first](#1-test-on-your-own-phone-first), and record a short video of a call.
2. [Back up the signing key](#2-back-up-the-signing-key).
3. [Ask IzzyOnDroid to list Hearth](#3-izzyondroid).
4. [Google Play internal testing](#4-google-play-internal-testing): account, app, signing, first upload, testers,
   the *App content* forms.
5. [Optional: automatic uploads to Play](#5-optional-automatic-uploads-to-google-play).
6. [Later: public Google Play](#6-later-public-google-play).
7. [Later: F-Droid](#7-later-f-droid-not-before-about-january-2027).

What's already done in this repository:

- **The store listing**, in the layout IzzyOnDroid and F-Droid read (and that you copy into Play):
  [`../mobile/fastlane/metadata/android/en-US/`](../mobile/fastlane/metadata/android/en-US/) has the name
  (`title.txt`), the short and full descriptions, the changelog (`changelogs/default.txt`), the icon, the feature
  graphic and phone screenshots.
- **An APK IzzyOnDroid accepts.** From `app-v1.29.1` on, the APK no longer carries Google's "dependency
  information" block (an encrypted list of the app's libraries that only Google can read). IzzyOnDroid's scanner
  flags that block. The Play bundle (`.aab`) still has it, for Play Console's library checks.
- **No Android backup.** From `app-v1.29.1` on, Android doesn't back the app's data up or move it to a new phone
  (the session and the unlocked keys stay on the phone; the privacy policy says so).
- **No way to pay in the app**, once kappachat runs Hearth 1.29.1 (step 4.4). The app itself also refuses to open
  Stripe and Ko-fi payment pages.

**Marked *(unverified)*:** a rule or label taken from Google's or a store's help pages that couldn't be opened
while writing this. Check it on the real page when you get there. Store rules change; this was written in
October 2026.

**The contact email** isn't decided yet. Wherever this page says `{{CONTACT_EMAIL}}`, use the address you pick
for Hearth (a separate free address is a good idea: Google Play shows it publicly). The privacy policy, the account
deletion page and the child safety page on the website have the same placeholder: step 4.6 says how to replace it
there before Google gets their addresses.

---

## 1. Test on your own phone first

CI proves the app builds and passes its unit tests. It can't prove that a notification arrives or that a call
survives a locked screen. Those have never been tried on a real phone (the list is in
[`../mobile/README.md`](../mobile/README.md#not-yet-tested-on-a-device)). Try them before any store, because a
store review uses the same features.

You need your Android phone and a second account or a friend (to send you messages and call you).

1. On the phone, install **ntfy** (free, from Google Play or F-Droid). It delivers Hearth's notifications while
   Hearth is closed.
2. On the phone, open <https://github.com/Pandabear445/Hearth-chat/releases/latest> and tap
   `Hearth-<version>.apk`. When Android asks, allow your browser to install unknown apps.
3. Open Hearth. It connects to the community server **kappachat.duckdns.org** by itself. Sign in.
4. Go through this list. Write down anything that doesn't work.
   - **Notifications with the app closed:** *Settings → Apps & devices → Notifications when Hearth is closed*,
     turn it on and pick ntfy. Swipe Hearth away from your recent apps. Have someone send you a direct message.
     A notification should arrive, and tapping it should open the conversation.
   - **Battery:** *Android Settings → Apps → ntfy → Battery → Unrestricted*. Then leave the phone untouched for half
     an hour and have someone message you again.
   - **A call with the screen locked:** join a voice channel with someone, lock the screen and keep talking for a
     few minutes. An "In a call" notification should show. Tap *Hang up* in it: you should leave the call.
   - **Ringing:** with Hearth closed, have someone call you in a direct message. It should ring for about 45
     seconds, then show a missed call. Call again and open Hearth from its icon while it rings: the ringing stops
     and the call's conversation opens.
   - **Lock screen:** by default a notification there says only your server's name and "New message".
   - **Invite links:** make an invite (server menu → *Invite people*). Send yourself `hearth://invite/` followed
     by the code, somewhere it shows as a link you can tap (an email, say), and tap it. Hearth should open with
     the invite.
5. If something on the list fails, fix it (or have it fixed) before going further, and remove any claim about
   it from `full_description.txt`.
6. **Record the call video.** Google Play wants a short video of the feature that uses the foreground service
   (step 4.7). Use test accounts, not real people's names.
   1. Pull down the quick settings twice and tap **Screen record** (if it isn't there, tap the pencil and drag it
      in). Start recording.
   2. Open Hearth and join a voice channel.
   3. Press Home. Pull down the notifications and show the "In a call" notification.
   4. Lock the screen for a few seconds, unlock it, and show the notification is still there and the call is still
      on (the recording may be black while the screen is locked; that's fine).
   5. Tap *Hang up* in the notification. Show the notification is gone. Stop recording.
   6. Upload the video to YouTube as **Unlisted** and keep the link.
7. **Take screenshots** while you're at it (Power + Volume down), 4 to 8, with the test accounts. Real ones from
   the phone are better than the ones in the repository: put them in
   [`../mobile/fastlane/metadata/android/en-US/images/phoneScreenshots/`](../mobile/fastlane/metadata/android/en-US/images/phoneScreenshots/)
   as `1.png`, `2.png`… in the order the stores should show them, and delete the old ones. Use PNG (`.png`; Play
   also takes JPEG), each side 320 to 3840 pixels, the long side at most twice the short side *(unverified)*.
   Phone screenshots are usually a bit taller than that: crop the status bar or the bottom off. A test checks
   these sizes (`test/infra-hardening.test.js`).

The screenshots there now: `1.png` is the phone picture from the website (widened a little with plain background
to fit the 2:1 limit). `2.png` to `4.png` are the real web client at a phone size, with made-up people. The
Android app shows that same page, so they're accurate, but they come from a browser, not a phone.

## 2. Back up the signing key

`hearth.jks` is the key every Hearth APK is signed with. Android only installs an update signed with the same key.
**If you lose it, or its passwords, nobody can ever update the app again**: not on GitHub, not on IzzyOnDroid, not
on Google Play. Everyone would have to uninstall and lose what the app keeps on the phone.

1. Copy `hearth.jks` to **two offline places**, for example a USB stick you keep at home and a second one somewhere
   else.
2. Write down, in a password manager and on paper kept with one USB stick: the keystore password, the key alias
   (`hearth`), and the key password (often the same as the keystore password).
3. Never put the key or its passwords in an email, a chat, an issue or a file in this repository.

**Print its fingerprint** (you need it for IzzyOnDroid and to check Play later). `keytool` comes with Java. If
PowerShell says it doesn't know `keytool`, install the free **Eclipse Temurin JDK 21** from
<https://adoptium.net> (keep *Add to PATH* on in the installer), then open a new PowerShell window. In the folder
with `hearth.jks`:

```powershell
keytool -list -v -keystore hearth.jks -alias hearth
```

Type the keystore password. Under *Certificate fingerprints*, the `SHA256:` line should be:

```
5F:65:14:3B:86:38:1F:11:A5:52:AF:6E:24:DB:D0:DD:DB:3F:65:2C:9E:B8:04:7B:B5:7E:3A:FC:03:13:8D:8F
```

That's the certificate inside the released `Hearth-1.29.0.apk`. If yours is different, stop: the file you have
isn't the key the releases were signed with. Find the right one before you go on.

Good to know: the certificate is valid until 2054 (Google Play wants beyond 22 October 2033). Its "owner" line
(`CN=Kappa, OU=Annon, O=Hearth, L=Reno, ST=Nevada, C=US`) is inside every APK for anyone to read, and can't
change without a new key, which would break updates.

## 3. IzzyOnDroid

IzzyOnDroid is a free app repository that F-Droid apps (F-Droid, Droid-ify, Neo Store and others) can add. It takes
the APK straight from GitHub releases, so people get your exact APK, signed with your key, and updates arrive by
themselves. There's no fee, and unlike F-Droid no minimum project age *(unverified)*.

### 3.1 Make the release first

IzzyOnDroid needs a release with the fixed APK (from this repository's change) and the store listing files. So the
`app-v1.29.1` release must exist. If it doesn't yet, after the changes are merged into `main`, run this in the
repository folder (it needs Git for Windows):

```powershell
git switch main
git pull
git tag app-v1.29.1
git push origin app-v1.29.1
```

GitHub Actions builds everything and makes the release (follow it in the repository's *Actions* tab). Check
<https://github.com/Pandabear445/Hearth-chat/releases>: the release should have `Hearth-1.29.1.apk` and
`Hearth.apk` (the same file under a fixed name, for the website's download button).

**Before every release**, update `changelogs/default.txt` (at most 500 characters): it's the "what's new" text
IzzyOnDroid (and later F-Droid) shows. Google Play's release notes are typed in Play Console instead (step 4.4).
F-Droid's tools use `default.txt` when there's no changelog for that exact build; IzzyOnDroid runs on the same tools
*(unverified)*. A changelog for one build is named after its **versionCode**: the workflow sets it to
`(major × 100 + minor) × 100000 + the workflow's run number`, so you only learn it once the build ran (the
*Version* step's log says `Hearth 1.29.1, Android versionCode 12900042`, and the Play bundle is named
`Hearth-1.29.1-12900042.aab`). That's why `default.txt` is the practical choice for now. To add one for a build
that's already out, save it as `changelogs/12900042.txt` (with that build's number).

### 3.2 Ask for inclusion

1. Make a free account at <https://codeberg.org>.
2. Open <https://codeberg.org/IzzyOnDroid/repo/issues> → **New issue**, and pick the app inclusion request template.
   (Other projects report it's called "App Inclusion Request" *(unverified)*. Requests used to go to GitLab; the
   Codeberg tracker is the current one.)
3. Fill in the template. Everything it's likely to ask, ready to paste:

```
App: Hearth (package app.hearth.mobile)
Source code: https://github.com/Pandabear445/Hearth-chat
License: MIT
Releases: GitHub releases, tags app-v*, https://github.com/Pandabear445/Hearth-chat/releases
APK file name pattern: ^Hearth-[0-9.]+\.apk$
  Each release also has the same APK named Hearth.apk (for direct download links); please ignore that one.
  Pre-releases are named like Hearth-1.30.0-beta.1.apk and are marked as pre-releases on GitHub.
Signing certificate SHA-256: 5f65143b86381f11a552af6e24dbd0dddb3f652c9eb8047bb57e3afc03138d8f
Fastlane metadata: hearth/mobile/fastlane/metadata/android/en-US/
The APK has no Google Play Services, no Firebase and no trackers. Notifications while the app is closed use
UnifiedPush (a distributor such as ntfy).
Network: by default the app opens the free community server kappachat.duckdns.org; people can switch to any
Hearth server (it's self-hostable, MIT). Watch together can embed YouTube, Vimeo and Twitch players, and calls
use the server's STUN servers (Google's by default).
Contact: {{CONTACT_EMAIL}}
```

4. Answer questions in the issue. Expect to be asked about "anti-features": the YouTube/Vimeo/Twitch players and
   Google's STUN servers may earn a *NonFreeNet* label. That's a label on the listing, not a refusal.
5. Once listed, new GitHub releases are picked up by themselves *(unverified: within about a day)*. Keep the APK's
   name pattern, keep signing with `hearth.jks`, and keep the repository public: IzzyOnDroid (and GitHub
   downloads) stop working if it goes private. So do the privacy policy, account deletion and child safety pages
   you give Google Play (section 4): they're part of the website, which GitHub Pages publishes from this repository, and on
   a free GitHub plan Pages only publishes public repositories *(unverified)*. If the repository has to go private
   while Hearth is on Play, first put copies of the three pages somewhere public (kappachat, say), give Play
   Console those addresses, and set `PRIVACY_URL` on kappachat (step 4.4) to the new privacy policy address.

## 4. Google Play internal testing

Internal testing lets up to 100 people you invite by email install Hearth from the Play Store, with no "unknown
app" warnings, and get updates automatically. It isn't public: nobody else can find it.

### 4.1 Open a developer account ($25 once)

1. Go to <https://play.google.com/console> and sign in with the Google account that will own Hearth on Play.
2. Choose a **Personal** account.
3. Pay the **$25** with a credit or debit card in your name (prepaid cards are refused *(unverified)*).
4. Verify your identity: your legal name and address, and a photo of a government ID if asked.
5. Fill in the developer details. **Play shows the developer name, and for a personal account also your legal name
   and country, publicly** on Hearth's page, plus the developer email. Use `{{CONTACT_EMAIL}}`.
   For the **developer name**, use `Pandabear445`. The privacy policy, the deletion page and the child safety page
   name the developer that way, and Google wants the privacy policy and the deletion page to name the developer or
   app the way the listing does *(unverified)*. If you pick another name, change it in those three pages too (search
   `privacy.html`, `delete-account.html` and `child-safety.html` for `Pandabear445`), so they match.
6. **Device verification:** install the **Play Console** app on your Android phone (Android 10 or newer, not
   rooted), sign in, and follow what it asks (it may show a code to scan). Then verify your phone number.
7. Keep an eye on email from Play Console and answer it. Google closes personal accounts that haven't published an
   app or sent one for review within about a year *(unverified)*. Whether an internal testing release counts isn't
   clear; a closed test (step 6) does.

### 4.2 Create the app

*Home → Create app*:

| Field | Answer |
|---|---|
| App name | `Hearth: private group chat` (same as `title.txt`; up to 30 characters) |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free (a free app can't become paid later) |
| Declarations | tick both (Developer Program Policies, US export laws) |

The package name, `app.hearth.mobile`, is fixed by the first upload. If Play says it's taken, the app id has to
change in several files together: see [SIGNING.md](SIGNING.md#google-play-internal-testing-step-by-step), step 3.

Then *Store settings*: **App category: Communication**, contact email `{{CONTACT_EMAIL}}`, website
`https://pandabear445.github.io/Hearth-chat/`.

And *Main store listing*: copy in `title.txt`, `short_description.txt` and `full_description.txt`, and upload
`images/icon.png`, `images/featureGraphic.png` and the phone screenshots, all from
[`../mobile/fastlane/metadata/android/en-US/`](../mobile/fastlane/metadata/android/en-US/).

### 4.3 Play App Signing with your own key (can't be undone)

Google Play re-signs every app it installs. You choose once which key it uses:

- **Your own key (do this).** You hand Google an encrypted copy of `hearth.jks`. The Play version and the GitHub and
  IzzyOnDroid APK then have the same signature, so people can move between them without uninstalling. Uninstalling
  erases what Hearth keeps on the phone, so this matters.
- A key Google makes. Then your key is only the "upload key", and the Play version and the APK can't update each
  other.

**Once Google has your key, it stays.** You can't switch to the other option later.

How (the labels may differ a little *(unverified)*):

1. *Test and release → App integrity → Play app signing* (or, when you create your first release, the signing
   choice it shows). Choose to use your own key, and **Export and upload a key from Java keystore**.
2. Play shows three things: a download link for `pepk.jar`, a public key file (`encryption_public_key.pem`), and a
   command. Download both files into the folder with `hearth.jks`.
3. In PowerShell in that folder, run **the command Play shows**, with your file names. It looks like this:

   ```powershell
   java -jar pepk.jar --keystore=hearth.jks --alias=hearth --output=hearth-play-key.zip --include-cert --rsa-aes-encryption --encryption-key-path=encryption_public_key.pem
   ```

   Type the keystore and key passwords when asked. (Java: see section 2.)
4. Upload `hearth-play-key.zip` where Play asks, and save. Then delete the zip. If Play offers to register a
   separate upload key, skip it: the workflow signs the bundle with `hearth.jks`, so that stays the upload key
   too *(unverified label)*.
5. Check: *App integrity* now shows an **App signing key certificate** whose SHA-256 is the one from section 2
   (`5F:65:14:3B:…:8D:8F`).

### 4.4 Update kappachat, then the first upload

**Update kappachat.duckdns.org first.** The Android app shows the pages kappachat sends, so a Play reviewer sees
what kappachat runs, not only what's in the APK. Two things Play checks come from the server:

- **No way to pay.** From Hearth 1.29.1 the Android app shows no *Support* window, funding card or memberships. A
  server on an older version still shows them, with links to Stripe and Ko-fi. (The 1.29.1 app also refuses to
  open Stripe and Ko-fi pages, but the buttons would still be there.)
- **A privacy policy link in the app.** The app opens the saved server, or kappachat, straight away, so the connect
  screen and its privacy policy link only show when a connection fails or someone taps *Switch server*. The links
  people do see, at sign-up and in *Settings → Security* and *Settings → Apps & devices*, show only when the server
  has `PRIVACY_URL` set.

So, before the first upload and before any review:

1. Update kappachat to Hearth 1.29.1 or newer, the way you always do (see
   [the README](../README.md#upgrading-a-server-that-already-has-users)).
2. In kappachat's `.env` file (in the Hearth folder on the server), add this line:

   ```
   PRIVACY_URL=https://pandabear445.github.io/Hearth-chat/privacy.html
   ```

   Then restart Hearth: `docker compose up -d --force-recreate` in the Hearth folder if it runs in Docker, or
   `sudo systemctl restart hearth` if it doesn't. The address must start with `https://`; anything else is ignored
   (the server's log then says `privacy_url_ignored`).
3. Check on your phone, in the Android app signed in to kappachat: *Settings → Security* (at the bottom, in the
   *Delete account* part) and *Settings → Apps & devices* show a **Privacy policy** link that opens the policy;
   Home has no funding card; the menu on your name has no *Support* item.

Then the first upload. Play takes the first bundle only by hand.

1. Get the bundle: GitHub → *Actions → Hearth apps* → the run for the `app-v1.29.1` tag (or the newest run on `main`)
   → *Artifacts* → **hearth-android-play-bundle**. It downloads as a zip; inside is `Hearth-1.29.1-<versionCode>.aab`.
   (The artifact is only there when the `ANDROID_KEYSTORE_*` secrets are set.)
2. Play Console → *Test and release → Testing → Internal testing → Create new release*.
3. Upload the `.aab`. For the release notes, paste this (Play shows the lines between `<en-US>` and `</en-US>`):

   ```
   <en-US>
   The connect screen links to Hearth's privacy policy.
   Android's backup of the app is off, so your sign-in and keys stay on this phone.
   </en-US>
   ```

   Don't paste `changelogs/default.txt`: that's for IzzyOnDroid, and it names other app stores and the APK, which
   Play's listing rules don't want *(unverified)*. For later releases, write a line or two about what changed in
   the app, without naming other stores, download pages or ways to pay.
4. *Next → Save and publish* (or *Start rollout to Internal testing*).

If the rollout button is greyed out, Play wants parts of *App content* (step 4.6) first. Fill those in and come
back *(unverified for internal testing)*.

### 4.5 Add testers

1. *Internal testing → Testers → Create email list*. Name it (for example "Friends") and add the Google account
   emails your friends use on the Play Store (up to 100). Save, tick the list, save again.
2. Copy the **opt-in link** (*Join on the web*) and send it to them.
3. Each tester opens it on their phone, accepts, and then installs Hearth from the Play Store.

### 4.6 App content: the forms, with answers

Play Console → your app → *App content* (in the left menu; Google moves it around now and then). Fill in every
item before the first rollout.

**First, put your contact email in the three pages.** The privacy policy, the account deletion page and the child
safety page (`privacy.html`, `delete-account.html` and `child-safety.html` at the top of this repository) still
say `{{CONTACT_EMAIL}}` where the address goes. Google wants a working contact on them, and the deletion page's
*Can't sign in?* steps depend on it.

1. In each of the three files, replace every `{{CONTACT_EMAIL}}` with your address. In the links it comes right
   after `mailto:`; keep that.
2. Check nothing's left. In PowerShell in the repository folder, this should print nothing:

   ```powershell
   Select-String -Path privacy.html, delete-account.html, child-safety.html -Pattern 'CONTACT_EMAIL'
   ```

3. Commit, and merge the change into `main`. GitHub Pages publishes it within a few minutes.
4. Open the three pages (their addresses are in this step and in 4.8) and click the email links: they should open your mail app
   with your address.

**Privacy policy:** `https://pandabear445.github.io/Hearth-chat/privacy.html` (open it first to check it loads).

**App access:** *All or some functionality is restricted*, then add a reviewer login. Make the account first:

1. On a computer, open <https://kappachat.duckdns.org> and sign up as `playreview` with a long random password
   (keep it in your password manager). Leave **two-factor sign-in off**: reviewers can't type a code.
2. As `playreview`, create a server called "Play review". It comes with `#general` and the `Lounge` voice channel.
   Post a few messages. Add a second test account to it, so there's someone to message. No real names.
3. If kappachat's sign-up is closed or needs a code (*Admin → Registration & Terms*), open it for a moment or use a
   code. Reviewers only sign in, so they don't need one.
4. Don't change this account's password or turn on two-factor sign-in while a review might be running.

Instructions to paste (with the username and password in Play's own fields):

```
1. Open Hearth. It connects to the community server kappachat.duckdns.org by itself.
2. Sign in with the username and password above. No two-factor code is needed.
3. Tap the menu button (top left) and open the "Play review" server to read and send messages.
4. To try a call, open the "Lounge" voice channel (being alone in it is fine) and allow the microphone. An
   "In a call" notification appears and keeps the call going while the screen is locked; "Hang up" in it ends
   the call.
```

**Ads:** No, the app doesn't contain ads.

**Advertising ID:** No. (The APK has no advertising ID permission and no ad or analytics libraries.)

**Content rating:** start the questionnaire, email `{{CONTACT_EMAIL}}`. Pick the category for social or
communication apps if it's offered *(unverified)*. Answer for what the app itself contains: no violence, sexual
content, bad language, drugs or gambling of its own. But say **yes, users can interact and communicate** with each
other and **yes, they can share content** (pictures, videos, files, voice). The app doesn't share people's
location. Expect a teen-or-older rating with a "Users interact" note *(unverified)*. Answer again whenever the app
changes in a way that changes these answers.

**Target audience and content:** **13–15, 16–17 and 18 and over.** Not any group under 13: that would put Hearth
under Google's Families policy, which a chat app with strangers can't meet. Choosing 13–17 tells Google that
teenagers use Hearth. The app and its listing then have to be suitable for them, and laws about minors' use of apps
apply (see [6.2](#62-age-checks-for-under-18s)). If asked whether the listing could appeal to children, answer No.
Hearth's terms (on kappachat: *Admin → Registration & Terms*) should say the same minimum age, 13.

**News app:** No. **Health apps:** no health features. **Financial features:** none. **Government app:** No.

**Data safety:** see [4.8](#48-data-safety-answers).

**Foreground service permissions:** see [4.7](#47-foreground-service-declaration).

**Child safety standards:** Google's help says this applies to apps in the Social and Dating categories
*(unverified)*; Hearth is in Communication. If Play Console asks for it anyway, give it
`https://pandabear445.github.io/Hearth-chat/child-safety.html` (your standards against child abuse, with the
contact `{{CONTACT_EMAIL}}`). People can already report a message or a person in the app under a child safety
category.

### 4.7 Foreground service declaration

What the app has (from `../mobile/scripts/patch-android.js` and `../mobile/native/CallService.java`): **one**
foreground service, `CallService`, of type **microphone**, with the permissions `FOREGROUND_SERVICE` and
`FOREGROUND_SERVICE_MICROPHONE`. It starts only when the person joins a call (and only when they've already allowed
the microphone), shows an "In a call" notification with *Hang up*, and stops when the call ends. Hearth's push
service (`HearthPushService`) is not a foreground service. The push library adds a `RaiseToForegroundService`
with no foreground service type, so it has nothing to declare *(unverified)*. There's no camera, phone call, media
playback, screen capture or data sync service, and no full-screen incoming call screen.

In the form, declare only **Microphone**. If it asks you to pick a use case, choose the one for voice or video
calls *(unverified label)*. Then paste:

Description:

```
Hearth is a chat app with voice and video calls. When the user joins a call, the app starts a foreground
service of type microphone with an ongoing "In a call" notification. It keeps the call's audio going while the
screen is locked or the user is in another app, so the other people in the call can still hear them. It runs
only during a call the user joined themselves, and stops when the call ends or when the user taps Hang up in
the notification.
```

What happens to the user if it's stopped or delayed:

```
The call goes silent or drops as soon as the screen locks or the user leaves the app, because Android cuts
off microphone access for apps in the background.
```

Video: the YouTube link from step 1.6.

### 4.8 Data safety answers

These are for **kappachat.duckdns.org**, the server the app opens by default. Anyone can point the app at their
own Hearth server; that server's owner then holds the data, not you. They come from the code and from
[`../SECURITY.md`](../SECURITY.md) (section 1 says what each piece of data is and how it's protected).

**End-to-end encrypted content isn't declared.** Messages, attachments (pictures, videos, files), voice messages
and calls are encrypted on the sender's phone and only the people in the conversation can read them; the server
can't. Google's Data safety help says data sent this way doesn't count as collected *(unverified: read from search
excerpts of support.google.com/googleplay/android-developer/answer/10787469; recheck the help text next to the
form)*.

First page:

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes. The app only talks to servers over HTTPS (it refuses `http://` except for addresses on your own network), and push notifications are encrypted to the phone. True only while kappachat stays on HTTPS. |
| Which account creation methods? | Username and password |
| Delete account URL | `https://pandabear445.github.io/Hearth-chat/delete-account.html` (open it first to check it loads) |
| If asked: can people delete some data without deleting the account? | Yes: in the app they can delete their own messages, remove their profile pictures and remove their email address. |

Data types to tick. For each: **collected yes**, **shared no** (but see the two things to decide below), and
processed on the server (not only on the phone):

| Play's data type | What it is in Hearth | Required or optional | Purposes |
|---|---|---|---|
| Personal info → Name | display name and nicknames | optional | App functionality |
| Personal info → Email address | for password reset and security notices; shown only to the account itself | optional | Account management |
| Personal info → User IDs | username and account id | required | App functionality, Account management |
| Photos and videos → Photos | profile pictures, banners and backgrounds, server icons, custom emoji, GIFs uploaded to the server's library (public on purpose, not encrypted) | optional | App functionality |
| Audio → Music files | profile songs (public on purpose) | optional | App functionality |
| Messages → Other in-app messages | the messages someone chooses to include when they report a message or a person (their app sends them readable, for the moderators); and what someone types after a bot's slash command, if a server on kappachat has a bot with commands (it goes to the bot unencrypted, after a warning) | optional | App functionality, Fraud prevention, security, and compliance |
| App activity → App interactions | who is in which server, who messages whom and when, reactions, poll votes, read markers, online status, the game or music someone chooses to show, GIF picks | required | App functionality |
| App activity → In-app search history | GIF search words: the server sends them to KLIPY or GIPHY (whichever kappachat uses) without saying who searched. The server keeps them only in memory (never on disk), until newer searches push them out or it restarts. Message search runs on the phone and isn't included | optional | App functionality |
| App activity → Other user-generated content | profile text and profile page, server, channel and category names, events, server folders and tracked feeds; links someone presses *Preview* on (fetched by the server and kept in memory for a few minutes) | optional | App functionality |
| Device or other IDs | the push address of the phone's push app, the browser or app name (user agent) of each signed-in session, IP addresses (with sign-ins, sessions and reports; never turned into a location) | required | App functionality, Fraud prevention, security, and compliance, Account management |
| Financial info → Purchase history | **not needed while kappachat runs Hearth 1.29.1 or newer:** the Android app then shows no way to pay (`noPayments` in `../public/js/android.js`, which the server sends). The APK doesn't decide this, the server does: tick it if kappachat is ever on an older version, where the app still offers supporter payments or memberships (Stripe, Ko-fi): what was paid, when, by whom | optional | App functionality |

Play's form has no separate item for IP addresses. Listing them under *Device or other IDs* is our reading
*(unverified)*.

**Processed ephemerally:** Play asks this once per data type. Answer **No** for every type above: each one holds
something the server stores (the link previews kept only in memory share their type with profile text, events and
feeds, which are stored). GIF searches are only in memory, but they stay there after the search is answered, so No
is the careful answer there too.

Not collected: location, contacts, calendar, health, web browsing history, message search terms (message search runs
on the phone), crash logs and diagnostics (the app sends none), and the camera and microphone (they go only into
calls, encrypted between the people in them).

**Shared: no** for every type, with two things to decide first. The server does pass things to other services, but
in ways Google's form doesn't count as sharing *(our reading, unverified)*: notifications go through the push app the
phone picked (ntfy.sh by default) encrypted so only the phone can read them; emails go out through the server's mail
provider; payment pages, videos and outside pictures are opened by the person themselves; reports of child abuse go
to the authorities as the law requires. The two to decide:

- **GIF searches.** KLIPY or GIPHY get the search words from the server, not tied to an account or an IP address,
  but under their own terms. Whether that's a service working for you or sharing is your call. The careful answer
  is **shared: yes** for *In-app search history*, purpose App functionality.
- **Bots.** A bot is run by whoever made it, and it gets events from the servers that add it: who joins and leaves,
  who posted or reacted and when (never what messages say), and what people type after its commands. Keep
  *Admin → Owner → Features → Who can make bots* on **Admins** (the default), and make bots only yourself. Then no
  one else runs a bot on kappachat, and "shared: no" holds. If you let other people make bots, tick **shared** for
  *Messages → Other in-app messages* and *App activity → App interactions*, purpose App functionality. (The
  privacy policy already lists bots under who else gets data.)

What deleting an account erases and keeps, in short (the deletion page,
`https://pandabear445.github.io/Hearth-chat/delete-account.html`, has the full list): erased at once are the
account's private keys, email, two-factor, recovery key, profile and pictures (and the comments on its profile
page), friends, blocks, push addresses, IP address history, saved messages, read positions and settings. Its
sign-ins end at once; their records (with the IP address and device name) are deleted 30 days later. Kept, among
other things: messages the person sent (still end-to-end encrypted, shown as "Deleted user"), their public keys
(others need them for old messages), bots they made (turned off), reports made by or about them, payment records,
and an entry in the audit log. Encrypted backups keep deleted data until they rotate out. Someone who owns a server
has to hand it over or delete it first. (Code: `eraseAccount` in `../server/index.js`, run by `DELETE /api/me` and
by staff's `DELETE /api/admin/users/:id`, and the `sessions.purge` job.)

**When someone asks by email to delete their account** (the deletion page's *Can't sign in?*), or you learn an
account belongs to a child under 13 (the privacy policy and the child safety page promise to delete those):

1. For a request, make sure it's really theirs, as the deletion page says: it comes from the account's email
   address, or they tell you things only they would know.
2. If it's a child under 13, suspend the account at once (*Admin → Users* → the account → *Suspend…*).
3. If the account owns servers, delete them or give them to someone else in *Admin → Servers*.
4. *Admin → Users* → the account → **Delete account…**. Type its username and a reason ("asked by email", "under
   13"), press *Delete forever*, and enter your password (and two-factor code). It erases exactly what deleting the
   account in the app does, and goes in the audit log with your name and the reason. Only admins and the owner can
   do it.
5. Write back to say it's done.

## 5. Optional: automatic uploads to Google Play

Once the first bundle is in by hand, GitHub can upload every new build to internal testing by itself: every
`app-v*` tag and every push to `main` that changes the apps. Your testers' phones then update by themselves. The
steps (a Google Cloud service account, its JSON key as the `PLAY_SERVICE_ACCOUNT_JSON` secret in the `production`
environment, and `PLAY_RELEASE_STATUS` = `draft` while the app is still a draft) are in
[SIGNING.md](SIGNING.md#google-play-internal-testing-step-by-step), step 8. Give the service account only
**Release to testing tracks**.

## 6. Later: public Google Play

### 6.1 The closed test: 12 testers for 14 days

A personal developer account made after 13 November 2023 can only publish to everyone after a **closed test**:
at least **12 testers** opted in for **14 days in a row** (someone who leaves and rejoins starts their 14 days
again). It has to be the **Closed testing** track; internal testing doesn't count *(unverified, but that's how
Google's wording reads)*. Then you apply for production from the Dashboard (a form about the test, the app and
what you changed); Google says the review usually takes 7 days or less, and the first production release is
reviewed too *(unverified)*.

The workflow only uploads to internal testing. To fill the closed track, use *Promote release* on an internal
release, or upload the `.aab` there by hand. Recruit 15 to 20 real people so 12 stay. Don't pay "tester" services.

### 6.2 Age checks for under-18s

Hearth's minimum age is 13. New laws make app stores and apps check or respect users' ages: **Texas SB2420** and
**Brazil's Digital ECA** (its law on children and teenagers online). Google offers a *Play Age Signals* API for
them; its page names Brazil from 17 March 2026 and Texas accounts made after 28 May 2026 *(unverified)*. What
exactly a developer of a 13+ chat app has to do under each law is **unverified** here, and court challenges may
change it. **Check this before going public.** The choices: set the target audience (and kappachat's terms) to 18+,
or keep 13+ and do what the laws ask, or leave those regions out under *Countries / regions*. Adding Google's age
library would mean a separate Play-only build, so the IzzyOnDroid and F-Droid builds stay free of Google code.

## 7. Later: F-Droid (not before about January 2027)

F-Droid's main repository builds apps from source itself and wants a project that's been developed for at least
three months. Hearth's code arrived in this repository on 6 October 2026, so about **January 2027** at the
earliest. By then Hearth needs:

- a versionCode that's written in the repository instead of taken from the workflow's run number (F-Droid reads
  it from the tagged source), always higher than every code already shipped or uploaded to Play;
- the launcher icons committed, and the build's extra steps (in `hearth-apps.yml`) moved into
  `../mobile/scripts/patch-android.js`, so F-Droid's build server can run the same steps;
- ideally a **reproducible build**: F-Droid then ships your own signed APK. Otherwise F-Droid signs Hearth with its
  own key, and people can't switch between the F-Droid version and the GitHub, IzzyOnDroid or Play version without
  uninstalling (they should save their recovery key first).

The request is a merge request to *fdroiddata* on GitLab. The store listing in
[`../mobile/fastlane/`](../mobile/fastlane/) is already in the layout F-Droid reads.
