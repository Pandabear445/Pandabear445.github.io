package app.hearth.mobile;

/**
 * Which page may send which HearthAndroid message. Plain Java (no Android classes), so it can be tested on
 * any JVM (see test/client-hardening.test.js and test/android-push.test.js).
 *
 * "setServer" re-points the whole app at another site from then on: only the app's own connect screen may
 * send it, after the person typed an address there and pressed Connect. The server's page (and anything
 * injected into it) can't, so a compromised server can't move people to a look-alike that keeps them.
 * "changeServer" only opens the connect screen, where the person decides, so the server's page may ask for it.
 * "push..." (notifications while the app is closed) and "call..." (keeping a call going with the screen off) are
 * only for the server's own page: they belong to the account signed in there, and the connect screen has none.
 * Also which of the connect screen's links open in the browser instead (opensInBrowser), and which pages the app
 * never opens at all (isPaymentPage).
 */
final class BridgePolicy {
    private BridgePolicy() { }

    static boolean allowed(String type, String sourceOrigin, String localOrigin, String serverOrigin) {
        if (type == null || sourceOrigin == null || sourceOrigin.isEmpty()) return false;
        boolean local = localOrigin != null && !localOrigin.isEmpty() && sourceOrigin.equals(localOrigin);
        boolean server = serverOrigin != null && !serverOrigin.isEmpty() && sourceOrigin.equals(serverOrigin);
        if ("setServer".equals(type)) return local;
        if (type.startsWith("push") || type.startsWith("call")) return server;
        return local || server;
    }

    /** Hearth's own website, where the connect screen's privacy policy link goes. */
    static final String SITE = "https://pandabear445.github.io/Hearth-chat/";

    /**
     * Whether a link the connect screen opens goes to the browser. Any other https:// address the connect screen
     * goes to is the server the person chose (that's how an old web view without window.HearthAndroid says so),
     * so a link to Hearth's website must not become the server.
     */
    static boolean opensInBrowser(String url) {
        return url != null && url.startsWith(SITE);
    }

    /** Where Hearth's ways to pay lead: Stripe's checkout, payment links and billing pages, and Ko-fi. */
    private static final String[] PAYMENT_HOSTS = { "checkout.stripe.com", "buy.stripe.com", "donate.stripe.com", "billing.stripe.com" };

    /**
     * Whether a link goes to a page for paying. The app doesn't open those (Google Play doesn't allow an app to send
     * people to pay outside Play's own billing). Hearth 1.29.1 and newer show no way to pay in the app, but a server
     * on an older version still does, and anyone can post such a link in a message. Only the host counts, so a link
     * that merely mentions one of these addresses still opens.
     */
    static boolean isPaymentPage(String url) {
        if (url == null) return false;
        String s = url.trim().toLowerCase(java.util.Locale.ROOT);
        int start = s.indexOf("://");
        if (start < 0) return false;
        String scheme = s.substring(0, start);
        if (!scheme.equals("https") && !scheme.equals("http")) return false;
        start += 3;
        int end = s.length();
        for (char c : new char[] { '/', '?', '#', '\\' }) {
            int j = s.indexOf(c, start);
            if (j >= 0 && j < end) end = j;
        }
        String host = s.substring(start, end);
        int at = host.lastIndexOf('@');
        if (at >= 0) host = host.substring(at + 1);
        int colon = host.lastIndexOf(':');
        if (colon >= 0 && !host.endsWith("]")) host = host.substring(0, colon);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.equals("ko-fi.com") || host.endsWith(".ko-fi.com")) return true;
        for (String h : PAYMENT_HOSTS) if (host.equals(h)) return true;
        return false;
    }
}
