package app.hearth.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps a call going when the screen locks or Hearth goes to the background.
 *
 * The call itself runs in the web view. Without this, Android treats a backgrounded Hearth like any other app in
 * the background: it may freeze or end it, and since Android 11 it cuts off the microphone. A foreground service
 * of type "microphone", started while the person is in the app (joining the call), keeps the app and its mic
 * going, with a notification that says so and offers Hang up. The page starts it when a call starts and stops it
 * when the call ends (public/js/android.js); Hang up tells the page to leave the call.
 *
 * Android's rules (sources in mobile/README.md): FOREGROUND_SERVICE (Android 9+), a declared service type and
 * FOREGROUND_SERVICE_MICROPHONE (Android 14+), the microphone permission already granted, and the service started
 * while the app is visible.
 */
public class CallService extends Service {
    static final String ACTION_START = "app.hearth.mobile.CALL_START";
    static final String ACTION_HANGUP = "app.hearth.mobile.CALL_HANGUP";
    static final String ACTION_STOP = "app.hearth.mobile.CALL_STOP";
    private static final int NOTIFICATION_ID = 7201;
    private static volatile boolean running;
    // What the page asked for last. A stop that comes before Android got round to starting the service still
    // wins: the service comes up (it must, once asked to start in the foreground) and goes straight away.
    private static volatile boolean wanted;

    static boolean isRunning() { return running; }

    /** Whether Android will let this service hold the microphone: only with the permission already granted. */
    static boolean canStart(Context c) {
        return c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Starts (or updates the title of) the call notification. Call from the visible app only. */
    static void start(Context c, String title) {
        if (!canStart(c)) return;
        // Already showing (a moderator moved the call to another channel, say): only the text changes. Starting the
        // service again could be refused while the screen is off.
        if (running && wanted) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            try { if (nm != null) nm.notify(NOTIFICATION_ID, HearthNotifications.ongoingCall(c, title, hangUpIntent(c))); } catch (RuntimeException ignored) { }
            return;
        }
        Intent i = new Intent(c, CallService.class).setAction(ACTION_START).putExtra("title", title == null ? "" : title);
        wanted = true;
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (RuntimeException e) { wanted = false; /* not allowed right now (the app went to the background first): the call goes on without it */ }
    }

    static void stop(Context c) {
        if (!wanted && !running) return;
        wanted = false;
        // Through onStartCommand rather than stopService: a start still on its way is handled first, so the
        // service never ends before it was put in the foreground (which Android treats as a crash).
        try { c.startService(new Intent(c, CallService.class).setAction(ACTION_STOP)); }
        catch (RuntimeException e) { try { c.stopService(new Intent(c, CallService.class)); } catch (RuntimeException ignored) { } }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_HANGUP.equals(action)) {
            wanted = false;
            MainActivity.hangUpFromNotification();
            finish();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action) || intent == null) { finish(); return START_NOT_STICKY; }
        Notification n = HearthNotifications.ongoingCall(this, intent.getStringExtra("title"), hangUpIntent(this));
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTIFICATION_ID, n);
            running = true;
            if (!wanted) finish(); // the call ended before Android started this
        } catch (RuntimeException e) {
            // Android refused (the microphone permission was taken away, or the app was already in the
            // background): stop at once rather than linger without a notification.
            finish();
        }
        // Not restarted by Android if it ever kills the app: the call ended with the web view.
        return START_NOT_STICKY;
    }

    private static PendingIntent hangUpIntent(Context c) {
        return PendingIntent.getService(c, 1, new Intent(c, CallService.class).setAction(ACTION_HANGUP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @SuppressWarnings("deprecation")
    private void finish() {
        running = false;
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE); else stopForeground(true);
        } catch (RuntimeException ignored) { }
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiped away from recent apps: the web view (and the call in it) is gone, so is this.
        finish();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
