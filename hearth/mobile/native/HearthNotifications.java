package app.hearth.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;

/**
 * Hearth's notification channels, and the notifications the app posts by itself: pushes that arrive while the
 * app is closed (HearthPushService) and the "in a call" notification that keeps a call going (CallService).
 * Uses only Android's own classes, so the push path doesn't depend on the web view or its libraries.
 *
 * Push notifications never contain message text: the server doesn't have it. They say what the server's push
 * says: by default the server's name and "New message", so the lock screen shows nothing more. With previews set
 * to "names" they say who and where, on the lock screen too, unless Android is set to hide sensitive content
 * (Android's default shows it): only then does the lock screen get the generic public version.
 */
final class HearthNotifications {
    private HearthNotifications() { }

    static final String EXTRA_OPEN = "hearthOpen";
    static final String MESSAGES = "messages"; // the same id as before, so people's settings for it carry over
    static final String CALLS = "calls";
    static final String ACTIVITY = "activity";
    static final String ONGOING = "ongoing_call";
    private static final long RING_MS = 45_000; // the app's own ring stops after 45 s too

    /** Creates the channels (safe to call any number of times). A channel's sound can't change once made. */
    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel messages = new NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("New messages and mentions");
        nm.createNotificationChannel(messages);
        NotificationChannel calls = new NotificationChannel(CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Someone is calling you while Hearth is closed");
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        calls.enableVibration(true);
        nm.createNotificationChannel(calls);
        NotificationChannel activity = new NotificationChannel(ACTIVITY, "Events and updates", NotificationManager.IMPORTANCE_DEFAULT);
        activity.setDescription("Event reminders, tracker updates and missed calls");
        nm.createNotificationChannel(activity);
        NotificationChannel ongoing = new NotificationChannel(ONGOING, "Ongoing call", NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("Shown while you're in a call, so it keeps going with the screen off");
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);
    }

    /** Whether Android lets Hearth show notifications at all. */
    static boolean allowed(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** A one-colour status bar icon (res/drawable/ic_stat_hearth.xml); the colour launcher icon would be a white blob. */
    static int smallIcon(Context c) {
        int id = c.getResources().getIdentifier("ic_stat_hearth", "drawable", c.getPackageName());
        return id != 0 ? id : c.getApplicationInfo().icon;
    }

    static CharSequence appLabel(Context c) {
        try { return c.getPackageManager().getApplicationLabel(c.getApplicationInfo()); } catch (Exception e) { return "Hearth"; }
    }

    /** Opens the app at `path` (checked by PushPolicy.safeOpenPath), or just brings it back with null. */
    static PendingIntent openApp(Context c, String path, int requestCode) {
        Intent open = new Intent(c, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (path != null) open.putExtra(EXTRA_OPEN, PushPolicy.safeOpenPath(path));
        return PendingIntent.getActivity(c, requestCode, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder builder(Context c, String channel) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
    }

    /** One push from the server, shown under its tag (a newer one for the same conversation replaces it). */
    @SuppressWarnings("deprecation")
    static void showPush(Context c, PushPayload p) {
        if (!allowed(c)) return;
        ensureChannels(c);
        long now = System.currentTimeMillis();
        boolean call = p.tag.startsWith("call:");
        boolean fresh = !call || PushPolicy.freshCall(p.at, now);
        String channel = call ? (fresh ? CALLS : ACTIVITY) : PushPolicy.channelFor(p.tag);
        CharSequence label = appLabel(c);
        String title = PushPolicy.clean(p.title, 120);
        String body = call && !fresh ? "Missed call" : PushPolicy.clean(p.body, 240);
        if (title.isEmpty()) title = label.toString();
        if (body.isEmpty()) body = "New activity";
        // With Android set to hide sensitive content, the lock screen shows this generic version instead, even with
        // previews set to "names". (Android's default shows the full notification there.)
        String publicText = call && !fresh ? "Missed call" : PushPolicy.clean(p.generic, 60);
        if (publicText.isEmpty()) publicText = p.generic.isEmpty() ? body : "New activity";
        String tag = call && !fresh ? "missed-" + p.tag : p.tag;
        Notification publicVersion = builder(c, channel).setSmallIcon(smallIcon(c)).setContentTitle(label).setContentText(publicText).build();
        Notification.Builder b = builder(c, channel)
                .setSmallIcon(smallIcon(c))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setWhen(p.at > 0 ? p.at : now)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setCategory(call && fresh ? Notification.CATEGORY_CALL : tag.startsWith("c:") || tag.startsWith("d:") ? Notification.CATEGORY_MESSAGE : Notification.CATEGORY_EVENT)
                .setPriority(call && fresh ? Notification.PRIORITY_MAX : Notification.PRIORITY_HIGH)
                .setContentIntent(openApp(c, p.url, tag.hashCode()));
        if (call && fresh && Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(RING_MS);
        Notification n = b.build();
        if (call && fresh) n.flags |= Notification.FLAG_INSISTENT; // rings until answered or the 45 s are up
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        try { if (nm != null) nm.notify(tag, 1, n); } catch (SecurityException ignored) { }
    }

    /**
     * Hearth is on screen: a call notification still ringing (insistent, posted while the app was closed) stops, as
     * the open app shows calls itself. Returns where the newest one leads ("/#call/<room>"), or null if none rang.
     */
    static String stopRinging(Context c) {
        if (Build.VERSION.SDK_INT < 23) return null;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return null;
        String path = null;
        long newest = Long.MIN_VALUE;
        try {
            for (StatusBarNotification s : nm.getActiveNotifications()) {
                String p = PushPolicy.ringingCallPath(s.getTag());
                if (p == null) continue; // missed calls ("missed-call:...") and messages stay
                nm.cancel(s.getTag(), s.getId());
                if (s.getPostTime() > newest) { newest = s.getPostTime(); path = p; }
            }
        } catch (RuntimeException ignored) { }
        return path;
    }

    /**
     * The notification shown while in a call: tap to go back to it, or hang up. Its title is what the page sends
     * (app.js callTitle): who or where only with previews set to "names", as Android's lock screen shows it.
     */
    static Notification ongoingCall(Context c, String title, PendingIntent hangUp) {
        ensureChannels(c);
        String t = PushPolicy.clean(title, 80);
        CharSequence label = appLabel(c);
        Notification publicVersion = builder(c, ONGOING).setSmallIcon(smallIcon(c)).setContentTitle(label).setContentText("In a call").build();
        Notification.Builder b = builder(c, ONGOING)
                .setSmallIcon(smallIcon(c))
                .setContentTitle(t.isEmpty() ? "In a call" : t)
                .setContentText("Tap to go back to the call")
                .setOngoing(true)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentIntent(openApp(c, null, 7102))
                .addAction(new Notification.Action.Builder(null, "Hang up", hangUp).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }
}
