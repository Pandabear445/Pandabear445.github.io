package app.hearth.mobile;

import android.Manifest;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Hearth for Android: a web view showing your Hearth server, plus the few things a web view can't do alone:
 *  - self-signed certificates: asks once, shows the fingerprint, remembers that exact certificate
 *  - notifications while the app is open or in the background, and saving files to Downloads
 *  - notifications while the app is closed, through a UnifiedPush push app (HearthPush, HearthPushService)
 *  - calls that keep going with the screen locked (CallService)
 *  - invite links (hearth://invite/... and, for an app built for one server, https://that-server/invite/...)
 *  - links to other sites open in the browser; only your server (and the connect screen) load in the app
 * The page talks to this code through window.HearthAndroid, which exists only on your server's own pages
 * and the connect screen; BridgePolicy decides which of them may send what (only the connect screen may
 * change the server; only the server's page may manage push and calls).
 */
public class MainActivity extends BridgeActivity {
    private static final String PREFS = "hearth";
    private static final String CHANNEL = HearthNotifications.MESSAGES;
    private static final int NOTIFY_PERMISSION = 7101;

    // Whether Hearth is on screen (a push that arrives then is left to the open app), and the running activity
    // (for the push and call services, which outlive it).
    private static volatile boolean foreground;
    private static WeakReference<MainActivity> live = new WeakReference<>(null);
    // Waiting for the server's page to be ready: where a tapped notification should open, and an invite link
    // ({ origin or "", code }). pageApi: what the page's android.js understands (1 = from before these existed).
    private String pendingOpen;
    private String[] pendingInvite;
    private boolean pageReady;
    private int pageApi = 1;

    private SharedPreferences prefs;
    private final List<SslErrorHandler> pendingSsl = new ArrayList<>();
    private AlertDialog sslDialog;
    private final Map<String, OutputStream> saving = new HashMap<>();
    private final Map<String, String> savingNames = new HashMap<>();
    private final Map<String, Uri> savingUris = new HashMap<>();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        Bridge bridge = getBridge();
        WebView web = bridge.getWebView();
        fitBetweenSystemBars(web);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        bridge.setWebViewClient(new HearthClient(bridge));
        listen();
        live = new WeakReference<>(this);
        HearthNotifications.ensureChannels(this);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView w = getBridge().getWebView();
                if (w.canGoBack()) w.goBack();
                else moveTaskToBack(true); // keep running so messages keep arriving
            }
        });
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
        // A call rang while Hearth was closed, and Hearth was opened some other way than its notification (the
        // launcher, Recents): the ringtone stops, and the app goes to the call as a tap on the notification would
        // (the page shows its own ring card if the call is still on).
        String call = HearthNotifications.stopRinging(this);
        if (call != null) openPath(call);
    }

    @Override
    public void onPause() {
        super.onPause();
        foreground = false;
    }

    @Override
    public void onDestroy() {
        // The web view, and any call in it, ends with this activity: so does the call notification.
        if (live.get() == this) { live = new WeakReference<>(null); CallService.stop(this); }
        foreground = false;
        super.onDestroy();
    }

    static boolean isForeground() { return foreground; }

    // ------------------------------------------------------------------ status bar, navigation bar, keyboard
    // Android 15+ draws every app edge to edge (behind the status and navigation bars) and no longer shrinks
    // the window for the keyboard. Hearth's pages expect a normal window, so the web view's container is padded
    // by the bars, the camera cutout and the keyboard, on every Android version alike, with light bar icons
    // over Hearth's dark background. (Capacitor's own SystemBars handling is off in capacitor.config.json.)
    private void fitBetweenSystemBars(WebView web) {
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        View box = (View) web.getParent();
        box.setBackgroundColor(0xFF100E16);
        ViewCompat.setOnApplyWindowInsetsListener(box, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(box);
    }

    // ------------------------------------------------------------------ which pages may load in the app
    private String serverOrigin() { return prefs.getString("server", ""); }

    // The one place the saved server changes. Leaving a server removes this phone's push registration for it
    // (the old server would otherwise keep a working address for this phone), and ends a call there.
    private void setServerOrigin(String o) {
        String old = serverOrigin();
        if (!o.equals(old)) {
            HearthPush.unregister(this, PushPolicy.instanceFor(old));
            CallService.stop(this);
        }
        prefs.edit().putString("server", o).apply();
        listen();
    }

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return "";
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) { return ""; }
    }

    private String localOrigin() { return originOf(getBridge().getLocalUrl()); }

    private boolean isOurs(String url) {
        String o = originOf(url);
        return !o.isEmpty() && (o.equals(localOrigin()) || o.equals(serverOrigin()));
    }

    private void listen() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebView web = getBridge().getWebView();
        try { WebViewCompat.removeWebMessageListener(web, "HearthAndroid"); } catch (Exception ignored) { }
        Set<String> rules = new HashSet<>();
        rules.add(localOrigin());
        if (!serverOrigin().isEmpty()) rules.add(serverOrigin());
        WebViewCompat.addWebMessageListener(web, "HearthAndroid", rules, this::onMessage);
    }

    private void showConnect(String query) {
        getBridge().getWebView().loadUrl(getBridge().getLocalUrl() + "/" + query);
    }

    private class HearthClient extends BridgeWebViewClient {
        HearthClient(Bridge bridge) { super(bridge); }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            String url = request.getUrl().toString();
            if (isOurs(url)) return false;
            // No way to pay from the app, whatever the page links to (see BridgePolicy.isPaymentPage).
            if (BridgePolicy.isPaymentPage(url)) {
                Toast.makeText(MainActivity.this, "Payments aren't available in the Android app", Toast.LENGTH_SHORT).show();
                return true;
            }
            // Leaving the connect screen: that's the server the person just chose (covers old web views
            // without window.HearthAndroid, which can't tell us directly). Its privacy policy link isn't: it goes
            // to the browser below, like links from the server's pages.
            String from = view.getUrl() == null ? "" : originOf(view.getUrl());
            if (from.equals(localOrigin()) && (url.startsWith("https://") || url.startsWith("http://")) && !BridgePolicy.opensInBrowser(url)) {
                setServerOrigin(originOf(url));
                return false;
            }
            if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("about:")) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, "No app can open this link", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            pageReady = false; // until the new page says hello
            // A new page (a reload after an update, switching server, an error page): any call lived in the page
            // being replaced, so its notification and the microphone service go too. (Only whole-page loads get
            // here, never the page's own #links.)
            CallService.stop(MainActivity.this);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (!request.isForMainFrame()) return;
            if (originOf(request.getUrl().toString()).equals(localOrigin())) return;
            String why = "Couldn't reach the server (" + error.getDescription() + "). Check the address and your connection.";
            try { showConnect("?error=" + URLEncoder.encode(why, "UTF-8")); } catch (Exception ignored) { }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            String url = error.getUrl();
            String host = originOf(url);
            String fp = fingerprint(error.getCertificate());
            String trusted = prefs.getString("cert:" + host, "");
            if (!fp.isEmpty() && fp.equals(trusted)) { handler.proceed(); return; }
            if (!host.equals(serverOrigin()) || fp.isEmpty()) { handler.cancel(); return; }
            pendingSsl.add(handler);
            if (sslDialog != null && sslDialog.isShowing()) return;
            boolean changed = !trusted.isEmpty();
            String message = (changed
                    ? "The security certificate for " + host + " has CHANGED. This can mean someone is intercepting your connection.\n\n"
                    : host + " uses a certificate that isn't signed by a trusted authority. That's normal for a self-hosted server without a domain.\n\n")
                    + "Only continue if the server owner confirms this fingerprint:\n\n" + fp;
            sslDialog = new AlertDialog.Builder(MainActivity.this)
                    .setTitle(changed ? "Certificate changed" : "Unverified certificate")
                    .setMessage(message)
                    .setCancelable(false)
                    .setPositiveButton("Trust this certificate", (d, w) -> {
                        prefs.edit().putString("cert:" + host, fp).apply();
                        for (SslErrorHandler h : pendingSsl) h.proceed();
                        pendingSsl.clear();
                    })
                    .setNegativeButton("Cancel", (d, w) -> {
                        for (SslErrorHandler h : pendingSsl) h.cancel();
                        pendingSsl.clear();
                        try { showConnect("?error=" + URLEncoder.encode("The server's certificate wasn't trusted.", "UTF-8")); } catch (Exception ignored) { }
                    })
                    .show();
        }
    }

    private static String fingerprint(SslCertificate cert) {
        try {
            byte[] der = SslCertificate.saveState(cert).getByteArray("x509-certificate");
            if (der == null) return "";
            byte[] d = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length; i++) { if (i > 0) sb.append(':'); sb.append(String.format("%02X", d[i])); }
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    // ------------------------------------------------------------------ messages from the page
    private void onMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame || message.getData() == null) return;
        try {
            JSONObject m = new JSONObject(message.getData());
            String type = m.optString("type");
            // Who sent it decides what it may do: only the connect screen may change the saved server.
            String from = sourceOrigin == null ? "" : originOf(sourceOrigin.toString());
            if (!BridgePolicy.allowed(type, from, localOrigin(), serverOrigin())) return;
            switch (type) {
                case "hello": {
                    // Only the server's own page gets push state, a tapped notification's address or an invite.
                    boolean server = from.equals(serverOrigin());
                    pageReady = server;
                    pageApi = Math.max(1, m.optInt("v", 1));
                    reply.postMessage(info(server).toString());
                    break;
                }
                case "setServer": {
                    String o = originOf(m.optString("origin"));
                    if (o.startsWith("https://") || o.startsWith("http://")) setServerOrigin(o);
                    reply.postMessage("{\"type\":\"serverSet\"}");
                    break;
                }
                case "pushState": reply.postMessage(HearthPush.state(this, true).toString()); break;
                case "pushRegister":
                case "pushPick":
                    HearthPush.register(this, m.optString("vapid"), "pushPick".equals(type));
                    reply.postMessage(HearthPush.state(this, true).toString());
                    break;
                case "pushUnregister":
                    HearthPush.unregister(this, HearthPush.currentInstance(this));
                    reply.postMessage(HearthPush.state(this, true).toString());
                    break;
                case "callStart": CallService.start(this, m.optString("title")); break;
                case "callEnd": CallService.stop(this); break;
                case "changeServer": showConnect("?change=1"); break;
                case "notify": notify(m.optString("title"), m.optString("body"), m.optString("tag")); break;
                case "cancel": NotificationManagerCompat.from(this).cancel(m.optString("tag"), 1); break;
                case "askNotify": askNotify(); break;
                case "saveStart": saveStart(m.optString("id"), m.optString("name"), m.optString("mime")); break;
                case "saveChunk": saveChunk(m.optString("id"), m.optString("data")); break;
                case "saveEnd": saveEnd(m.optString("id")); break;
                default: break;
            }
        } catch (Exception ignored) { }
    }

    private String notifyState() {
        if (Build.VERSION.SDK_INT < 33) return NotificationManagerCompat.from(this).areNotificationsEnabled() ? "granted" : "denied";
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return "granted";
        boolean asked = prefs.getBoolean("askedNotify", false);
        if (asked && !ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.POST_NOTIFICATIONS)) return "denied";
        return "default";
    }

    private JSONObject info(boolean fromServer) throws Exception {
        String version = "";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        JSONObject o = new JSONObject();
        o.put("type", "info");
        o.put("version", version);
        o.put("notify", notifyState());
        o.put("server", serverOrigin());
        if (fromServer) {
            o.put("push", HearthPush.state(this, true));
            o.put("call", true); // this app keeps calls going with the screen off
            if (pendingOpen != null) { o.put("open", pendingOpen); pendingOpen = null; }
            String code = takeInvite();
            if (code != null) o.put("invite", code);
        }
        return o;
    }

    private void toPage(String event, String detailJson) {
        String js = "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:" + detailJson + "}))";
        runOnUiThread(() -> {
            WebView w = getBridge().getWebView();
            if (isOurs(w.getUrl() == null ? "" : w.getUrl())) w.evaluateJavascript(js, null);
        });
    }

    // Only to the server's own page (not the connect screen): push keys and call controls belong to it.
    private void toServerPage(String event, String detailJson) {
        String js = "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:" + detailJson + "}))";
        runOnUiThread(() -> {
            WebView w = getBridge().getWebView();
            String o = originOf(w.getUrl() == null ? "" : w.getUrl());
            if (!o.isEmpty() && o.equals(serverOrigin())) w.evaluateJavascript(js, null);
        });
    }

    /** The push registration changed (a new address, a failure, the push app unregistered us). */
    static void pushChanged(JSONObject st) {
        MainActivity a = live.get();
        if (a != null) a.toServerPage("hearth-push", st.toString());
    }

    /** Hang up from the call notification: the page leaves the call. */
    static void hangUpFromNotification() {
        MainActivity a = live.get();
        if (a != null) a.toServerPage("hearth-hangup", "true");
    }

    private void askNotify() {
        if (Build.VERSION.SDK_INT >= 33 && !"granted".equals(notifyState())) {
            prefs.edit().putBoolean("askedNotify", true).apply();
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFY_PERMISSION);
        } else {
            toPage("hearth-notify-permission", JSONObject.quote(notifyState()));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFY_PERMISSION) toPage("hearth-notify-permission", JSONObject.quote(notifyState()));
    }

    private void notify(String title, String body, String tag) {
        if (!"granted".equals(notifyState())) return;
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("hearthTag", tag);
        PendingIntent pi = PendingIntent.getActivity(this, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);
        try { NotificationManagerCompat.from(this).notify(tag, 1, b.build()); } catch (SecurityException ignored) { }
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        // A notification posted while the app was closed: open the place it's about once the page is ready.
        String open = intent.getStringExtra(HearthNotifications.EXTRA_OPEN);
        if (open != null) {
            intent.removeExtra(HearthNotifications.EXTRA_OPEN);
            openPath(open);
            return;
        }
        // An invite link.
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            String[] invite = InviteLinks.parse(intent.getData().toString());
            intent.setData(null);
            if (invite == null) return;
            if (!serverOrigin().isEmpty() && !InviteLinks.forServer(invite, serverOrigin())) {
                Toast.makeText(this, "This invite is for " + invite[0] + ". Switch to that server first (Settings \u2192 Apps & devices).", Toast.LENGTH_LONG).show();
                return;
            }
            pendingInvite = invite;
            if (pageReady) deliverInvite();
            return;
        }
        // A notification the open page posted (it handles its own clicks).
        String tag = intent.getStringExtra("hearthTag");
        if (tag == null) return;
        intent.removeExtra("hearthTag");
        toPage("hearth-notification-click", JSONObject.quote(tag));
    }

    // Opens one of the app's own addresses in the server's page: now if it's ready, else once it says hello.
    private void openPath(String path) {
        pendingOpen = PushPolicy.safeOpenPath(path);
        if (pageReady) {
            if (pageApi >= 2) toServerPage("hearth-open", JSONObject.quote(pendingOpen));
            pendingOpen = null;
        }
    }

    // The invite waiting for this server, if any (once).
    private String takeInvite() {
        if (pendingInvite == null || !InviteLinks.forServer(pendingInvite, serverOrigin())) return null;
        String code = pendingInvite[1];
        pendingInvite = null;
        return code;
    }

    // The page is already open: a current page shows the "Join a server" box in place (a call keeps going); an
    // older one gets the invite page loaded instead.
    private void deliverInvite() {
        String code = takeInvite();
        if (code == null) return;
        if (pageApi >= 2) toServerPage("hearth-invite", JSONObject.quote(code));
        else getBridge().getWebView().loadUrl(InviteLinks.target(serverOrigin(), code));
    }

    // ------------------------------------------------------------------ saving files to Downloads/Hearth
    private void saveStart(String id, String name, String mime) {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (safe.isEmpty()) safe = "file";
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        try {
            OutputStream out;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Hearth");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("no uri");
                savingUris.put(id, uri);
                out = getContentResolver().openOutputStream(uri);
            } else {
                File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Hearth");
                dir.mkdirs();
                out = new FileOutputStream(new File(dir, safe));
            }
            saving.put(id, out);
            savingNames.put(id, safe);
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "Couldn't save the file", Toast.LENGTH_SHORT).show());
        }
    }

    private void saveChunk(String id, String data) {
        OutputStream out = saving.get(id);
        if (out == null) return;
        try { out.write(Base64.decode(data, Base64.DEFAULT)); } catch (Exception e) { saving.remove(id); }
    }

    private void saveEnd(String id) {
        OutputStream out = saving.remove(id);
        String name = savingNames.remove(id);
        savingUris.remove(id);
        if (out == null) return;
        try {
            out.close();
            String where = Build.VERSION.SDK_INT >= 29 ? "Downloads/Hearth" : "the app's Downloads folder";
            runOnUiThread(() -> Toast.makeText(this, "Saved " + name + " to " + where, Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "Couldn't save the file", Toast.LENGTH_SHORT).show());
        }
    }
}
