package app.hearth.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import org.junit.Test;

/**
 * The app's own rules for notifications, invite links and who may use the bridge, run by the Android build
 * (./gradlew testReleaseUnitTest). test/android-push.test.js runs the same cases with plain javac.
 */
public class PushPolicyTest {
    private static PushPayload parse(String json) { return PushPayload.parse(json.getBytes(StandardCharsets.UTF_8)); }

    @Test
    public void payloadsAreParsedStrictly() {
        PushPayload p = parse("{\"title\":\"Hearth\",\"body\":\"New message\",\"tag\":\"d:abc123\",\"url\":\"/#m/xyz789\",\"at\":1760000000000,\"_\":\"   \"}");
        assertNotNull(p);
        assertEquals("Hearth", p.title);
        assertEquals("New message", p.body);
        assertEquals("d:abc123", p.tag);
        assertEquals("/#m/xyz789", p.url);
        assertEquals(1760000000000L, p.at);
        assertEquals("", p.generic);
        byte[] big = new byte[4097];
        Arrays.fill(big, (byte) ' ');
        assertNull("over 4096 bytes", PushPayload.parse(big));
        assertNull(PushPayload.parse(new byte[0]));
        assertNull(PushPayload.parse(null));
        assertNull("not an object", parse("[]"));
        assertNull("no tag", parse("{\"title\":\"x\"}"));
        assertNull("bad tag", parse("{\"tag\":\"c:<script>\"}"));
        assertNull("trailing junk", parse("{\"tag\":\"c:a\"} x"));
        assertNull("unterminated", parse("{\"tag\":\"c:a\""));
        PushPayload nested = parse("{\"x\":{\"y\":[1,\"}\",{\"z\":null}]},\"tag\":\"c:abc\",\"ok\":true,\"no\":false,\"n\":null}");
        assertNotNull("unknown keys are skipped whatever they hold", nested);
        assertEquals("c:abc", nested.tag);
        PushPayload esc = parse("{\"tag\":\"c:a\",\"title\":\"caf\\u00e9 \\\"x\\\" \\/ \\\\\"}");
        assertEquals("caf\u00e9 \"x\" / \\", esc.title);
        assertEquals("a wrong url becomes the app's start", "/", parse("{\"tag\":\"c:a\",\"url\":\"https://evil.example/\"}").url);
        assertEquals("last key wins", "two", parse("{\"tag\":\"c:a\",\"title\":\"one\",\"title\":\"two\"}").title);
        assertEquals("a non-number time is 0", 0, parse("{\"tag\":\"c:a\",\"at\":\"soon\"}").at);
    }

    @Test
    public void textIsCleaned() {
        assertEquals("evil txt", PushPolicy.clean("evil\u202e\u0000txt", 50).replace("  ", " "));
        assertEquals("ab", PushPolicy.clean("a\u200eb", 50));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 500; i++) sb.append('x');
        String cut = PushPolicy.clean(sb.toString(), 120);
        assertEquals(120, cut.codePointCount(0, cut.length()));
        assertTrue(cut.endsWith("\u2026"));
        assertEquals("", PushPolicy.clean(null, 10));
        assertEquals("\ud83d\udd25\u2026", PushPolicy.clean("\ud83d\udd25\ud83d\udd25\ud83d\udd25", 2));
    }

    @Test
    public void notificationsOnlyOpenInAppAddresses() {
        for (String ok : new String[] { "/", "/#m/abc123", "/#c/abc", "/#d/abc", "/#call/dm:abc", "/#call/abc", "/#updates", "/#study", "/#scheduled" }) {
            assertEquals(ok, PushPolicy.safeOpenPath(ok));
        }
        for (String bad : new String[] { "https://evil.example/", "//evil.example", "/#reset=AAAAAAAAAAAAAAAAAAAAAAAA", "javascript:alert(1)",
                "/#m/ABC", "/#m/abc?x", "/#call/dm:abc/x", "", null, "/#invite/abc", "/x" }) {
            assertEquals(String.valueOf(bad), "/", PushPolicy.safeOpenPath(bad));
        }
        // A ringing call's notification, cancelled when Hearth is opened another way, leads to the call.
        assertEquals("/#call/dm:abc", PushPolicy.ringingCallPath("call:dm:abc"));
        assertEquals("/#call/abc", PushPolicy.ringingCallPath("call:abc"));
        for (String other : new String[] { "missed-call:dm:abc", "d:abc", "c:abc", "call:", "call:ABC", "call:dm:abc/x", "event:abc", null }) {
            assertNull(String.valueOf(other), PushPolicy.ringingCallPath(other));
        }
    }

    @Test
    public void eachServerHasItsOwnRegistrationAndCallsRingOnlyWhileFresh() {
        String a = PushPolicy.instanceFor("https://a.example");
        assertEquals(17, a.length());
        assertEquals(a, PushPolicy.instanceFor("https://a.example"));
        assertNotEquals(a, PushPolicy.instanceFor("https://b.example"));
        assertEquals("", PushPolicy.instanceFor(""));
        assertEquals("calls", PushPolicy.channelFor("call:dm:abc"));
        assertEquals("messages", PushPolicy.channelFor("c:abc"));
        assertEquals("messages", PushPolicy.channelFor("d:abc"));
        assertEquals("activity", PushPolicy.channelFor("event:abc"));
        assertEquals("activity", PushPolicy.channelFor("updates-abc"));
        long now = 1_760_000_000_000L;
        assertTrue(PushPolicy.freshCall(now - 119_000, now));
        assertFalse(PushPolicy.freshCall(now - 121_000, now));
        assertFalse(PushPolicy.freshCall(now + 400_000, now));
        assertFalse(PushPolicy.freshCall(0, now));
        String vapid = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
        assertTrue(PushPolicy.validVapid(vapid));
        assertFalse(PushPolicy.validVapid(vapid + "A"));
        assertFalse(PushPolicy.validVapid("A" + vapid.substring(1)));
        assertFalse(PushPolicy.validVapid(null));
    }

    @Test
    public void inviteLinksOnlyEverOpenAnInviteOnTheAppsServer() {
        String server = "https://chat.example.com";
        String[] h = InviteLinks.parse("hearth://invite/abcd2345");
        assertEquals("", h[0]);
        assertEquals("abcd2345", h[1]);
        assertTrue(InviteLinks.forServer(h, server));
        assertFalse("no server yet", InviteLinks.forServer(h, ""));
        String[] w = InviteLinks.parse("https://Chat.Example.com/invite/abcd2345/");
        assertEquals("https://chat.example.com", w[0]);
        assertTrue(InviteLinks.forServer(w, server));
        assertTrue(InviteLinks.forServer(w, "https://chat.example.com:443"));
        assertFalse(InviteLinks.forServer(w, "https://other.example"));
        assertEquals("https://chat.example.com/invite/abcd2345", InviteLinks.target(server, w[1]));
        String[] port = InviteLinks.parse("https://1.2.3.4:3000/invite/abcd2345");
        assertEquals("https://1.2.3.4:3000", port[0]);
        for (String bad : new String[] { "hearth://invite/", "hearth://invite/a", "hearth://invite/ab/cd", "hearth://evil/abcd2345",
                "https://chat.example.com/invite/ab%2F..", "https://chat.example.com/x/invite/abcd", "http://chat.example.com/invite/abcd2345",
                "https://user@chat.example.com/invite/abcd2345", "javascript:alert(1)", "hearth://invite/abcd2345?x=<script>", null, "" }) {
            String[] r = InviteLinks.parse(bad);
            assertTrue(String.valueOf(bad), r == null || "abcd2345".equals(r[1]));
        }
        assertNull(InviteLinks.parse("hearth://invite/ab/cd"));
        assertNull(InviteLinks.parse("https://user@chat.example.com/invite/abcd2345"));
    }

    @Test
    public void onlyTheServersPageManagesPushAndCalls() {
        String local = "https://localhost", server = "https://chat.example.com", evil = "https://evil.example";
        for (String t : new String[] { "pushRegister", "pushPick", "pushUnregister", "pushState", "callStart", "callEnd" }) {
            assertTrue(t, BridgePolicy.allowed(t, server, local, server));
            assertFalse(t, BridgePolicy.allowed(t, local, local, server));
            assertFalse(t, BridgePolicy.allowed(t, evil, local, server));
        }
        assertTrue(BridgePolicy.allowed("setServer", local, local, server));
        assertFalse(BridgePolicy.allowed("setServer", server, local, server));
    }

    @Test
    public void theConnectScreensPrivacyLinkOpensInTheBrowser() {
        assertTrue(BridgePolicy.opensInBrowser("https://pandabear445.github.io/Hearth-chat/privacy.html"));
        for (String other : new String[] { "https://kappachat.duckdns.org/", "https://pandabear445.github.io/", "https://pandabear445.github.io/Hearth-chat",
                "https://pandabear445.github.io.evil.example/Hearth-chat/privacy.html", "https://pandabear445.github.io@evil.example/Hearth-chat/",
                "http://pandabear445.github.io/Hearth-chat/privacy.html", "", null }) {
            assertFalse(String.valueOf(other), BridgePolicy.opensInBrowser(other));
        }
    }

    @Test
    public void paymentPagesDontOpenFromTheApp() {
        for (String pay : new String[] { "https://checkout.stripe.com/c/pay/cs_test_a1", "https://buy.stripe.com/test_123", "https://donate.stripe.com/x",
                "https://billing.stripe.com/p/session/x", "https://ko-fi.com/hearth", "https://www.ko-fi.com/hearth", "https://KO-FI.COM/hearth",
                "http://ko-fi.com/hearth", "https://ko-fi.com./hearth", "https://ko-fi.com:443/hearth", "https://someone@ko-fi.com/hearth", "https://ko-fi.com",
                "https://ko-fi.com?x=1", "https://ko-fi.com#top" }) {
            assertTrue(pay, BridgePolicy.isPaymentPage(pay));
        }
        for (String other : new String[] { "https://kappachat.duckdns.org/", "https://stripe.com/docs", "https://connect.stripe.com/express/x",
                "https://notko-fi.com/x", "https://ko-fi.com.evil.example/x", "https://evil.example/ko-fi.com", "https://evil.example/?u=https://ko-fi.com",
                "https://ko-fi.com@evil.example/", "https://[::1]:3000/", "ftp://ko-fi.com/", "ko-fi.com", "", null,
                "https://pandabear445.github.io/Hearth-chat/privacy.html" }) {
            assertFalse(String.valueOf(other), BridgePolicy.isPaymentPage(other));
        }
    }
}
