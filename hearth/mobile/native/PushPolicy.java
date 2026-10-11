package app.hearth.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;

/**
 * The rules for notifications that arrive while Hearth is closed. Plain Java (no Android classes), so it can be
 * tested on any JVM (test/android-push.test.js compiles and runs it; the Android build runs PushPolicyTest).
 *
 * A notification only ever opens an address inside the app (never another site), each server gets its own push
 * registration, and a call that rang too long ago is a missed call, not a ring.
 */
final class PushPolicy {
    private PushPolicy() { }

    /** UnifiedPush (AND_3): an encrypted message is at most 4096 bytes, so the decrypted one is smaller still. */
    static final int MAX_PAYLOAD_BYTES = 4096;
    /** A ring older than this (the push service held it while the phone was offline) shows as a missed call. */
    static final long CALL_FRESH_MS = 120_000;
    /** How far the phone's clock may be ahead of the server's before a ring from "the future" is distrusted. */
    static final long CLOCK_SKEW_MS = 300_000;

    // "/" or one of the app's own hash links. Ids are the server's newId(): lowercase letters and digits. #scheduled is
    // the person's scheduled messages (a push says one wasn't sent, or is waiting for them).
    private static final Pattern OPEN = Pattern.compile("^/(#(?:m|c|d)/[a-z0-9]{1,64}|#call/(?:dm:)?[a-z0-9]{1,64}|#updates|#study|#scheduled)?$");
    private static final Pattern TAG = Pattern.compile("^[A-Za-z0-9:_-]{1,100}$");
    // An uncompressed P-256 public key (65 bytes starting 0x04) in base64url without padding: 87 characters,
    // and the 0x04 makes the first one "B".
    private static final Pattern VAPID = Pattern.compile("^B[A-Za-z0-9_-]{86}$");

    /** The push registration name for one server: "o" and 16 hex characters of SHA-256(origin). "" without a server. */
    static String instanceFor(String origin) {
        if (origin == null || origin.isEmpty()) return "";
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder("o");
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i] & 0xff));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    /** url when it is "/" or one of the app's own links, else "/". */
    static String safeOpenPath(String url) {
        return url != null && OPEN.matcher(url).matches() ? url : "/";
    }

    /**
     * Where a ringing call's notification (tag "call:<room>") leads: "/#call/<room>", or null for any other tag.
     * Hearth opened some other way while it rings goes there too (MainActivity.onResume).
     */
    static String ringingCallPath(String tag) {
        if (tag == null || !tag.startsWith("call:")) return null;
        String path = "/#call/" + tag.substring(5);
        return OPEN.matcher(path).matches() ? path : null;
    }

    static boolean validTag(String tag) { return tag != null && TAG.matcher(tag).matches(); }

    static boolean validVapid(String key) { return key != null && VAPID.matcher(key).matches(); }

    /** Which notification channel a push goes to (people can silence each in Android's settings). */
    static String channelFor(String tag) {
        if (tag == null) return "activity";
        if (tag.startsWith("call:")) return "calls";
        if (tag.startsWith("c:") || tag.startsWith("d:")) return "messages";
        return "activity";
    }

    /** A call push sent at `at` (server time) still rings at `now`. */
    static boolean freshCall(long at, long now) {
        return at > 0 && now - at <= CALL_FRESH_MS && at - now <= CLOCK_SKEW_MS;
    }

    /**
     * Text fit for a notification: no control characters or direction overrides (which could make a name read
     * as something else), trimmed, and at most maxCodePoints characters (cut with "...").
     */
    static String clean(String s, int maxCodePoints) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        s.codePoints().forEach((cp) -> {
            if (cp <= 0x1f || cp == 0x7f || (cp >= 0x80 && cp <= 0x9f)) { sb.append(' '); return; }
            if (cp == 0x200e || cp == 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return;
            sb.appendCodePoint(cp);
        });
        String t = sb.toString().trim().replaceAll(" {2,}", " ");
        if (maxCodePoints < 1) return "";
        if (t.codePointCount(0, t.length()) <= maxCodePoints) return t;
        int end = t.offsetByCodePoints(0, maxCodePoints - 1);
        return t.substring(0, end).trim() + "\u2026";
    }
}
