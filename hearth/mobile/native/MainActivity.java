package app.hearth.mobile;

import android.Manifest;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
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
 *  - links to other sites open in the browser; only your server (and the connect screen) load in the app
 * The page talks to this code through window.HearthAndroid, which exists only on your server's own pages.
 */
public class MainActivity extends BridgeActivity {
    private static final String PREFS = "hearth";
    private static final String CHANNEL = "messages";
    private static final int NOTIFY_PERMISSION = 7101;

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
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        bridge.setWebViewClient(new HearthClient(bridge));
        listen();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("New messages and mentions");
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView w = getBridge().getWebView();
                if (w.canGoBack()) w.goBack();
                else moveTaskToBack(true); // keep running so messages keep arriving
            }
        });
        handleNotificationTap(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleNotificationTap(intent);
    }

    // ------------------------------------------------------------------ which pages may load in the app
    private String serverOrigin() { return prefs.getString("server", ""); }

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
            // Leaving the connect screen: that's the server the person just chose (covers old web views
            // without window.HearthAndroid, which can't tell us directly).
            String from = view.getUrl() == null ? "" : originOf(view.getUrl());
            if (from.equals(localOrigin()) && (url.startsWith("https://") || url.startsWith("http://"))) {
                prefs.edit().putString("server", originOf(url)).apply();
                listen();
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
            switch (type) {
                case "hello": reply.postMessage(info().toString()); break;
                case "setServer": {
                    String o = originOf(m.optString("origin"));
                    if (o.startsWith("https://") || o.startsWith("http://")) { prefs.edit().putString("server", o).apply(); listen(); }
                    reply.postMessage("{\"type\":\"serverSet\"}");
                    break;
                }
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

    private JSONObject info() throws Exception {
        String version = "";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        JSONObject o = new JSONObject();
        o.put("type", "info");
        o.put("version", version);
        o.put("notify", notifyState());
        o.put("server", serverOrigin());
        return o;
    }

    private void toPage(String event, String detailJson) {
        String js = "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:" + detailJson + "}))";
        runOnUiThread(() -> {
            WebView w = getBridge().getWebView();
            if (isOurs(w.getUrl() == null ? "" : w.getUrl())) w.evaluateJavascript(js, null);
        });
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

    private void handleNotificationTap(Intent intent) {
        if (intent == null) return;
        String tag = intent.getStringExtra("hearthTag");
        if (tag == null) return;
        intent.removeExtra("hearthTag");
        toPage("hearth-notification-click", JSONObject.quote(tag));
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
