# Hearth for Android

A small app that opens your Hearth server, like the desktop app does. Everything in Hearth works in it
(chats, calls, video, voice messages, polls, events, profiles, watch together…) because it *is* your
server's app, and it updates whenever you update the server.

What the app adds on top of the web page (in `native/MainActivity.java`):

* **Self-signed certificates:** if your server uses one (an IP address like `https://1.2.3.4:3000`), the app
  shows the certificate's fingerprint and asks once, then remembers that exact certificate — and warns
  loudly if it ever changes. Same as the desktop app.
* **Notifications** about new messages while the app is open or in the background, and **after you swipe it
  away** through a push app (see below).
* **Calls keep going** with the screen locked or the app in the background, with an "In a call" notification
  that has *Hang up*.
* **Invite links open in the app:** `hearth://invite/CODE`, and `https://your-server/invite/CODE` for an app
  built for your server (see *Invite links* below).
* **Saving files** (attachments, exports) to *Downloads/Hearth*.
* **Links to other sites** open in your browser; only your server loads inside the app.
* **Back button** goes back; on the first screen it sends the app to the background (so messages keep
  arriving) instead of closing it.
* **Switch server:** Settings → Apps & devices → *Switch server*.
* **Status bar and keyboard:** the page sits between Android's status bar and navigation bar and above the
  keyboard on every Android version (Android 15+ would otherwise draw it underneath them).

## Get the APK

It's built by GitHub Actions (`.github/workflows/hearth-apps.yml` at the top of the repository): open the
repository's **Actions** tab → *Hearth apps* → the latest run → *Artifacts* → `hearth-android` (a zip with the
`.apk` inside). Push a tag like `app-v1.17.0` to get it attached to a GitHub release instead.

Install it: open the `.apk` on the phone and allow "Install unknown apps" for your browser or file manager.
Those warnings (and Play Protect's "unrecognised app") come with installing outside Google Play; to avoid them,
offer the app through Google Play's internal testing track, see [`../docs/SIGNING.md`](../docs/SIGNING.md).
To offer it to everyone, put the `.apk` in your server's `data/downloads/` folder — the `/download` page shows
it to Android visitors.

**Server address:** people type it on first launch (e.g. `chat.example.com` or `1.2.3.4:3000`). To build an
app for your server only, set the repository variable `HEARTH_SERVER` (Settings → Secrets and variables →
Actions → Variables), e.g. `https://chat.example.com`, or type it when running the workflow by hand. Set
`"lockServer": true` in `www/config.json` to stop people changing it.

## Signing (so updates install over the top)

Android only installs signed apps, and only installs an update if it's signed with the same key as the
installed app. The workflow signs with **your own key** only, from the secrets below; it never makes a key or
keeps one anywhere. Without the secrets the APK is built **unsigned** (`Hearth-<version>-UNSIGNED.apk`, artifact
`hearth-android-UNSIGNED`): it only shows that the build works, Android won't install it, and it is never
attached to a release or copied to your server.

Make your key once (needs Java), with a strong password of its own:

```bash
keytool -genkeypair -v -keystore hearth.jks -alias hearth -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 hearth.jks > hearth.jks.txt      # macOS: base64 -i hearth.jks -o hearth.jks.txt
```

…and add the repository secrets `ANDROID_KEYSTORE_BASE64` (contents of `hearth.jks.txt`, which you then
delete), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`hearth`) and `ANDROID_KEY_PASSWORD`. Keep
`hearth.jks` safe and offline: lose it and you can never update the app again without everyone reinstalling.

**Moving off the old built-in key.** Older versions of this workflow, when these secrets were missing, made a
key themselves, kept it in the Actions cache (`hearth-android-key-v1`) and protected it with a password written in
the workflow. A cache entry outlives the workflow change, and pull request runs, even from forks, can restore it:
treat that key as exposed, since whoever has it can sign an update that Android installs over Hearth. If your APKs
came from such builds:

1. Delete the cache entry: repository → *Actions → Caches* → every `hearth-android-key-v1` (or
   `gh cache delete hearth-android-key-v1`).
2. Delete or update old branches that still have the old `.github/workflows/hearth-apps.yml`: a push to one, or a
   manual run of it, makes or restores the cached key again.
3. Make your own key and add the secrets (above).
4. Remove the APKs signed with the old key from your server's `data/downloads/` and from old GitHub releases.
5. Set `ANDROID_CERT_SHA256` on the server to the new key's fingerprint (invite links, see
   [`../docs/SIGNING.md`](../docs/SIGNING.md)).
6. Tell people to **uninstall the app and install the new APK once**: Android refuses an update signed with a
   different key, so it can't install over the old one.

With these secrets the workflow also builds a Google Play bundle (`.aab`, artifact
`hearth-android-play-bundle`), and with a `PLAY_SERVICE_ACCOUNT_JSON` secret (in the `production` environment)
it uploads it to Google Play's internal testing track. Step by step: [`../docs/SIGNING.md`](../docs/SIGNING.md).

The app's *versionCode* (which must go up with every update) is `(major × 100 + minor) × 100000 + the
workflow's run number`.

## Notifications when the app is closed

Android's web view has no push service of its own, so the app uses [UnifiedPush](https://unifiedpush.org/): a
*push app* on the phone keeps one connection open for all apps that use it and wakes Hearth when something
happens. The usual one is **ntfy** (free on F-Droid and Google Play). No Google account or Firebase project is
involved.

1. Install ntfy on the phone (once).
2. In Hearth: Settings → Apps & devices → **Notifications when Hearth is closed** (the app also offers this once
   after you sign in). If you have several push apps and none is the phone's default, Android asks which to use.
   While it's on, *Change* lists every push app on the phone (whatever the default is) and moves Hearth to the one
   you pick; backing out keeps the one you had.
3. For notifications without delay, let ntfy run without battery limits (Android Settings → Apps → ntfy →
   Battery → Unrestricted).

How it stays private: the UnifiedPush library in the app makes this phone's encryption keys, and the server
encrypts every notification to them (RFC 8291, the same as for browsers). ntfy only ever carries ciphertext, and
notifications it can't decrypt with this phone's keys are thrown away. Notifications never contain what a message
says (the server doesn't know): by default they say your server's name and "New message" or "Incoming call", and
the "In a call" notification says just that. With *Show who and where on the lock screen* (Settings →
Notifications) they say who and where, and Android shows that on the lock screen too, unless Android itself is set
to hide sensitive notification content (Android Settings → Notifications → Notifications on lock screen): only
then does the lock screen show the generic text. A call that arrives more than two minutes late shows as a missed
call instead of ringing; opening Hearth while a call rings stops the ringtone and goes to that call. Signing out,
or switching server, removes the phone's push registration.

**What ntfy's operator learns** with the public ntfy.sh: that this phone gets notifications from your server, and
when (not what). To avoid that, run your own ntfy next to Hearth and set `PUSH_NTFY_URL`; Settings then tells
people to point the ntfy app at it. Recipe: [`../docs/OPERATIONS.md`](../docs/OPERATIONS.md#7-self-hosted-ntfy-for-android-notifications).
The free ntfy.sh has daily limits (when it says "too many", the server waits as long as it asks without giving up
on the phone); a busy server should run its own.

## Calls with the screen off

While you're in a call the app runs an Android *foreground service* (`CallService`) of type `microphone`, with an
"In a call" notification (tap it to go back; *Hang up* leaves the call). Without it Android may freeze or close a
backgrounded app, and since Android 11 it cuts the microphone off for apps that aren't visible. Android's rules,
which the build follows:

* `FOREGROUND_SERVICE` (Android 9+) and, for apps targeting Android 14+, a declared service type plus the matching
  `FOREGROUND_SERVICE_MICROPHONE` permission:
  [service types](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone),
  [Android 14 change](https://developer.android.com/about/versions/14/changes/fgs-types-required).
* The microphone permission must already be granted, and the service must start while the app is visible
  ([restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start),
  [while-in-use access](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions)).
  Joining a call does both. A listen-only call (no microphone permission) doesn't get the service.
* Android describes `microphone` as the type to "continue microphone capture from the background, such as voice
  recorders or communication apps". `phoneCall` is for apps that are the phone's dialer or use Android's calling
  API (ConnectionService, `MANAGE_OWN_CALLS`); Hearth doesn't, so it uses `microphone`
  ([phoneCall](https://developer.android.com/develop/background-work/services/fgs/service-types#phone-call)).
  Google Play asks apps to explain each foreground service type when they're submitted.

The service keeps the microphone, not the camera: video may pause while the screen is off; the call's audio
carries on. Anything that loads a new page (*Reload now* after a server update, switching server, a connection
error) ends the call, and the notification goes with it.

## Invite links

* `hearth://invite/CODE` opens in the app on any build (the same links the desktop app takes). The join box opens
  on the server the app is set up for; a call in progress keeps going.
* `https://your-server/invite/CODE` opens in the app when it's built for your server (repository variable
  `HEARTH_SERVER`) and Android has verified the app for that address: set `ANDROID_CERT_SHA256` on the server to
  the SHA-256 fingerprint of the app's signing key (several, comma-separated: your key and, for Play, Google's app
  signing key; see [`../docs/SIGNING.md`](../docs/SIGNING.md)). The server then serves
  `/.well-known/assetlinks.json`. Without that, people can still allow it by hand (Android Settings → Apps → Hearth
  → Open by default).
* An https invite for a different server than the app's isn't opened (the app says to switch server first).

## Not yet tested on a device

CI proves that everything compiles against the pinned UnifiedPush library (3.3.5), that the app's own rules pass
their unit tests (`./gradlew testReleaseUnitTest`, also run with plain `javac` by `npm test`), and that the APK's
merged manifest has the push service, the library's receiver, the call service with its type and permissions, and
the invite link filter. The server side is tested against a fake push service that decrypts like the phone. These
still need a real phone (checklist: `docs/design/ANDROID-PUSH.md` §17) before an `app-v*` release:

* the round trip through ntfy: registering, a notification arriving with the app swiped away, tapping it, and
  the push address changing;
* choosing a push app: with several and no default (Android's list; backing out of it asks nothing more), with a
  default or "Always" picked (no question), with none installed, and *Change* (Hearth's list of every push app,
  including one Android's list can't show; backing out keeps the current one);
* the call notification: the call carrying on with the screen locked for several minutes, *Hang up*, Android 14+
  accepting the `microphone` service, and the notification going away after *Reload now* or switching server;
* the ringing channel for calls (sound, 45-second timeout), the missed-call case, and opening Hearth from the
  launcher while a call rings (the ringtone stops and the call's conversation opens);
* the lock screen with Android's default ("show all notification content"): only "<server>" / "New message" and
  "In a call" while *Show who and where* is off; names with it on; and with "hide sensitive content", the generic
  text even with it on;
* invite links: `hearth://` from a browser, and App Link verification for a build with `HEARTH_SERVER`;
* Doze (an idle phone) with ntfy's battery exemption.

## Not in the Android app (yet)

* **Screen sharing** — Android's web view can't capture the screen. Camera, mic and watch together work.
* **A full-screen incoming call screen** (like the phone app's) — calls ring as a notification.
* **Google's push service built in** (for people without a push app) — planned as an optional build flag.

## Building it yourself

Needs Node 22, JDK 21 and the Android SDK (Android Studio Otter 2025.2.1 or newer): the app uses Capacitor 8
and targets Android 16 (API 36), which Google Play requires for new apps and updates. The workflow's *Create
the Android project* step shows exactly what it does: `npm ci` (exactly what `package-lock.json` lists; use it
locally too), `npx cap add android`, copy `native/*.java` in, add the microphone/camera/notification permissions
and the `androidx.webkit` dependency, then `node scripts/patch-android.js android`, which adds:

* the UnifiedPush library at an exact version (`org.unifiedpush.android:connector:3.3.5`, from Maven Central);
* `HearthPushService` (unexported, reachable only by the library) and `CallService` (a `microphone` foreground
  service) with the `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MICROPHONE` permissions;
* the invite link filters (`SERVER` set: also the verified https one);
* the status bar icon (`native/res`) and the unit tests (`native/test`).

It refuses to patch a manifest that doesn't look like Capacitor's template, so a template change fails the build
instead of shipping an app without push. Then `./gradlew assembleRelease testReleaseUnitTest` (and
`bundleRelease` for Google Play), and `node scripts/patch-android.js --check-merged <merged manifest>`.

**Updating the push library:** change the version in `scripts/patch-android.js` by hand after reading its
release notes ([codeberg.org/UnifiedPush/android-connector](https://codeberg.org/UnifiedPush/android-connector)),
and let the *android* job prove it still compiles. It brings `kotlin-stdlib` and Google's Tink (for decryption)
with it; Hearth's own code writes no cryptography.

The native code: `MainActivity.java` (the web view and the page bridge), `BridgePolicy.java` (which page may ask
for what), `HearthPush.java` / `HearthPushService.java` (UnifiedPush), `HearthNotifications.java` (channels and
notifications), `CallService.java`, and the plain-Java rules `PushPolicy.java`, `PushPayload.java` and
`InviteLinks.java`.
