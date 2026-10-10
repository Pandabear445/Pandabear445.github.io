# Hearth for Android

A small app that opens your Hearth server, like the desktop app does. Everything in Hearth works in it
(chats, calls, video, voice messages, polls, events, profiles, watch together…) because it *is* your
server's app, and it updates whenever you update the server.

What the app adds on top of the web page (in `native/MainActivity.java`):

* **Self-signed certificates:** if your server uses one (an IP address like `https://1.2.3.4:3000`), the app
  shows the certificate's fingerprint and asks once, then remembers that exact certificate — and warns
  loudly if it ever changes. Same as the desktop app.
* **Notifications** about new messages while the app is open or in the background.
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

Android only installs an update if it's signed with the same key as the installed app. The workflow makes a
key on its first run and keeps it in the GitHub Actions cache. GitHub drops caches that aren't used for 7
days; if that happens the next build gets a new key and people have to uninstall the old app once.

To use a key that never changes, make one (needs Java):

```bash
keytool -genkeypair -v -keystore hearth.jks -alias hearth -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 hearth.jks > hearth.jks.txt      # macOS: base64 -i hearth.jks -o hearth.jks.txt
```

…and add the repository secrets `ANDROID_KEYSTORE_BASE64` (contents of `hearth.jks.txt`),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`hearth`) and `ANDROID_KEY_PASSWORD`. Keep `hearth.jks` safe:
lose it and you can never update the app again without everyone reinstalling.

With these secrets the workflow also builds a Google Play bundle (`.aab`, artifact
`hearth-android-play-bundle`), and with a `PLAY_SERVICE_ACCOUNT_JSON` secret it uploads it to Google Play's
internal testing track. Step by step: [`../docs/SIGNING.md`](../docs/SIGNING.md).

The app's *versionCode* (which must go up with every update) is `(major × 100 + minor) × 100000 + the
workflow's run number`.

## Not in the Android app (yet)

* **Screen sharing** — Android's web view can't capture the screen. Camera, mic and watch together work.
* **Notifications after the app is swiped away** — that needs Google's Firebase push service.

## Building it yourself

Needs Node 22, JDK 21 and the Android SDK (Android Studio Otter 2025.2.1 or newer): the app uses Capacitor 8
and targets Android 16 (API 36), which Google Play requires for new apps and updates. The workflow's *Create
the Android project* step shows exactly what it does: `npm ci` (exactly what `package-lock.json` lists; use it
locally too), `npx cap add android`, copy `native/*.java` in (`MainActivity.java` and `BridgePolicy.java`), add the microphone/camera/notification permissions and the `androidx.webkit`
dependency, then `./gradlew assembleRelease` (and `bundleRelease` for Google Play).
