package app.hearth.mobile;

import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Notifications from Hearth while the app is closed. The UnifiedPush library hands over each message after
 * decrypting it with this phone's keys (RFC 8291); anything it couldn't decrypt (sent by someone who only knows
 * the push address) is dropped here. A notification never includes message text: the server never has it.
 * Declared in the manifest unexported, for the library's PUSH_EVENT only (mobile/scripts/patch-android.js).
 */
public class HearthPushService extends PushService {
    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) { HearthPush.onEndpoint(this, instance, endpoint); }

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted()) return;                              // not encrypted for this phone: never shown
        if (!instance.equals(HearthPush.currentInstance(this))) return;   // a previous server's registration
        PushPayload p = PushPayload.parse(message.getContent());
        if (p == null) return;
        if (MainActivity.isForeground()) return;                          // the open app shows its own
        HearthNotifications.showPush(this, p);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) { HearthPush.onFailed(this, instance, reason.name()); }

    @Override
    public void onUnregistered(String instance) { HearthPush.onUnregistered(this, instance); }
}
