package app.hearth.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;

import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.ResolvedDistributor;
import org.unifiedpush.android.connector.data.PushEndpoint;

import java.util.ArrayList;
import java.util.List;

/**
 * Notifications while Hearth is closed, through UnifiedPush: a push app on the phone (a "distributor", usually
 * ntfy) gives Hearth a Web Push address, and the UnifiedPush library makes the keys and decrypts what arrives.
 * This class registers and unregisters one registration per server and keeps what the page needs to know.
 *
 * Native code never talks to the Hearth server and never sees the sign-in token: it hands the address and the
 * public keys to the server's own page (MainActivity -> "hearth-push"), which subscribes them like a browser
 * would. State lives in the app's "hearth" preferences:
 *   push.instance, push.vapid, push.endpoint, push.p256dh, push.auth, push.temporary, push.state, push.reason
 * with push.state one of none | pending | registered | failed | noDistributor | blocked.
 */
final class HearthPush {
    private HearthPush() { }

    private static AlertDialog chooser; // one at a time

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("hearth", Context.MODE_PRIVATE); }

    /** This server's registration name (each server gets its own, so two never share a push address). */
    static String currentInstance(Context c) { return PushPolicy.instanceFor(prefs(c).getString("server", "")); }

    /** What the page sees: the state, and the keys only when asked (the server's own page subscribes them). */
    static JSONObject state(Context c, boolean withKeys) {
        SharedPreferences p = prefs(c);
        JSONObject o = new JSONObject();
        try {
            String st = p.getString("push.state", "none");
            String reason = p.getString("push.reason", "");
            String distributor = "";
            try { String d = UnifiedPush.getAckDistributor(c); if (d != null) distributor = d; } catch (RuntimeException ignored) { }
            // Registered, but the push app was uninstalled since.
            if ("registered".equals(st) && distributor.isEmpty()) { st = "none"; reason = "DISTRIBUTOR_GONE"; }
            boolean mine = "registered".equals(st) && currentInstance(c).equals(p.getString("push.instance", ""));
            if ("registered".equals(st) && !mine) st = "none";
            o.put("type", "pushState");
            o.put("state", st);
            o.put("reason", reason);
            o.put("vapid", p.getString("push.vapid", ""));
            o.put("endpoint", mine ? p.getString("push.endpoint", "") : "");
            o.put("temporary", mine && p.getBoolean("push.temporary", false));
            if (withKeys && mine) {
                o.put("p256dh", p.getString("push.p256dh", ""));
                o.put("auth", p.getString("push.auth", ""));
            }
            o.put("distributor", distributor);
            o.put("distributorName", distributor.isEmpty() ? "" : nameOf(c, distributor));
            int count = 0;
            try { count = UnifiedPush.getDistributors(c).size(); } catch (RuntimeException ignored) { }
            o.put("distributors", count);
        } catch (Exception ignored) { }
        return o;
    }

    private static String nameOf(Context c, String pkg) {
        if (pkg.equals(c.getPackageName())) return "Google push (built into this app)";
        try {
            PackageManager pm = c.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(ai));
        } catch (Exception e) { return pkg; }
    }

    private static void set(Context c, String state, String reason) {
        prefs(c).edit().putString("push.state", state).putString("push.reason", reason == null ? "" : reason).apply();
    }

    /**
     * Asks for a push address for the current server. `vapid` is the server's VAPID public key (from
     * /api/push/key); `choose` is "Change": Hearth's list of push apps, even if one was picked before.
     * The answer comes later, through onEndpoint or onFailed (or a cancel, see cancelled()).
     */
    static void register(Activity a, String vapid, boolean choose) {
        String key = vapid == null ? "" : vapid.replace("=", "");
        if (!PushPolicy.validVapid(key)) { failNow(a, "VAPID_INVALID"); return; }
        if (!HearthNotifications.allowed(a)) { set(a, "blocked", ""); changed(a); return; }
        String instance = currentInstance(a);
        if (instance.isEmpty()) { failNow(a, "INTERNAL_ERROR"); return; }
        SharedPreferences p = prefs(a);
        // "Change" leaves the registration this server has until another push app is picked: backing out of the
        // list keeps it as it was (nothing is removed up front).
        boolean keep = choose && "registered".equals(p.getString("push.state", "")) && instance.equals(p.getString("push.instance", ""));
        p.edit().putString("push.instance", instance).putString("push.vapid", key).apply();
        set(a, "pending", "");
        try {
            if (choose) { pickDistributor(a, instance, key, true, keep); return; }
            // A push app picked before (and still installed) answers without a question.
            if (UnifiedPush.getAckDistributor(a) != null) { doRegister(a, instance, key); return; }
            ResolvedDistributor resolved = UnifiedPush.resolveDefaultDistributor(a);
            if (resolved instanceof ResolvedDistributor.Found) {
                // The phone's default push app, or the only one: no question either.
                UnifiedPush.saveDistributor(a, ((ResolvedDistributor.Found) resolved).getPackageName());
                doRegister(a, instance, key);
            } else if (resolved instanceof ResolvedDistributor.ToSelect) {
                // Several push apps and no default: Android asks (and can remember the answer for every app that
                // uses UnifiedPush). Backing out of Android's list is a cancel, not a reason to ask again.
                UnifiedPush.tryUseDefaultDistributor(a, (ok) -> {
                    a.runOnUiThread(() -> { if (Boolean.TRUE.equals(ok)) doRegister(a, instance, key); else cancelled(a, false); });
                    return kotlin.Unit.INSTANCE;
                });
            } else {
                // Nothing Android can choose between (no push app, or only older ones without its list): Hearth's own.
                pickDistributor(a, instance, key, false, false);
            }
        } catch (RuntimeException e) { failNow(a, "INTERNAL_ERROR"); }
    }

    // Hearth's own list of push apps: every one installed, older ones too, whatever the phone's default is. Without
    // `choose`, a single push app is used without asking. keep: cancelling leaves the current registration.
    private static void pickDistributor(Activity a, String instance, String key, boolean choose, boolean keep) {
        List<String> found = new ArrayList<>();
        try { found.addAll(UnifiedPush.getDistributors(a)); } catch (RuntimeException ignored) { }
        if (found.isEmpty()) { set(a, "noDistributor", ""); changed(a); return; }
        if (!choose && found.size() == 1 && !found.get(0).equals(a.getPackageName())) {
            UnifiedPush.saveDistributor(a, found.get(0));
            doRegister(a, instance, key);
            return;
        }
        if (chooser != null && chooser.isShowing()) return;
        String current = "";
        try { String d = UnifiedPush.getAckDistributor(a); if (d != null) current = d; } catch (RuntimeException ignored) { }
        String[] labels = new String[found.size()];
        for (int i = 0; i < labels.length; i++) {
            String pkg = found.get(i);
            labels[i] = (pkg.equals(a.getPackageName())
                    ? "Google push (built into this app) \u2014 Google sees when you get a notification, not what it says"
                    : nameOf(a, pkg)) + (pkg.equals(current) ? " (in use)" : "");
        }
        chooser = new AlertDialog.Builder(a)
                .setTitle("Which app should deliver Hearth\u2019s notifications?")
                .setItems(labels, (d, which) -> {
                    // Saving another push app unregisters this app from the old one (the library does that).
                    UnifiedPush.saveDistributor(a, found.get(which));
                    doRegister(a, instance, key);
                })
                .setNegativeButton("Cancel", (d, w) -> cancelled(a, keep))
                .setOnCancelListener((d) -> cancelled(a, keep))
                .show();
    }

    // The person backed out of a list of push apps. Turning push on ends there (none, CANCELLED); "Change" goes back
    // to the registration it had. Either way the page's wait ends with "cancelled" (and no message).
    private static void cancelled(Context c, boolean keep) {
        if (keep) set(c, "registered", ""); else set(c, "none", "CANCELLED");
        JSONObject st = state(c, true);
        try { st.put("cancelled", true); } catch (Exception ignored) { }
        MainActivity.pushChanged(st);
    }

    private static void doRegister(Context c, String instance, String key) {
        try {
            UnifiedPush.register(c, instance, "Hearth \u00b7 " + host(prefs(c).getString("server", "")), key);
        } catch (Exception e) {
            // The library throws VapidNotValidException for a key in the wrong form (checked above already).
            failNow(c, e instanceof UnifiedPush.VapidNotValidException ? "VAPID_INVALID" : "INTERNAL_ERROR");
        }
    }

    private static String host(String origin) {
        try { String h = Uri.parse(origin).getHost(); return h == null ? "" : h; } catch (Exception e) { return ""; }
    }

    /** Removes this phone's registration for `instance` (sign-out, switching server, turning push off). */
    static void unregister(Context c, String instance) {
        if (instance != null && !instance.isEmpty()) {
            try { UnifiedPush.unregister(c, instance); } catch (RuntimeException ignored) { }
        }
        prefs(c).edit().remove("push.instance").remove("push.vapid").remove("push.endpoint").remove("push.p256dh")
                .remove("push.auth").remove("push.temporary").putString("push.state", "none").putString("push.reason", "").apply();
    }

    // ---------------------------------------------------------------- answers from the push app (HearthPushService)
    static void onEndpoint(Context c, String instance, PushEndpoint e) {
        if (!instance.equals(currentInstance(c))) return; // a previous server's
        PublicKeySet keys = e.getPubKeySet();
        if (keys == null) { failNow(c, "NO_KEYS"); return; }
        prefs(c).edit().putString("push.instance", instance).putString("push.endpoint", e.getUrl())
                .putString("push.p256dh", keys.getPubKey()).putString("push.auth", keys.getAuth())
                .putBoolean("push.temporary", e.getTemporary())
                .putString("push.state", "registered").putString("push.reason", "").apply();
        changed(c);
    }

    static void onFailed(Context c, String instance, String reason) {
        if (!instance.equals(currentInstance(c))) return;
        failNow(c, reason);
    }

    static void onUnregistered(Context c, String instance) {
        if (!instance.equals(currentInstance(c))) return;
        prefs(c).edit().remove("push.endpoint").remove("push.p256dh").remove("push.auth").apply();
        set(c, "none", "UNREGISTERED");
        changed(c);
    }

    private static void failNow(Context c, String reason) {
        set(c, "failed", reason);
        changed(c);
    }

    // Tells the server's page, if it's open; otherwise it asks for the state when it next starts.
    private static void changed(Context c) { MainActivity.pushChanged(state(c, true)); }
}
