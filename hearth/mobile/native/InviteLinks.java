package app.hearth.mobile;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Invite links that open in the app: hearth://invite/CODE (the same links the desktop app takes) and
 * https://your-server/invite/CODE (Android App Links, for an app built for one server). Plain Java, tested on
 * any JVM.
 *
 * Only the code is taken from a link, never an address to load: the app opens /invite/CODE on the server it is
 * already set up for, so a link can't point the app at another site. An https link for a different server than
 * the app's is refused (the person switches server first).
 */
final class InviteLinks {
    private InviteLinks() { }

    private static final Pattern CODE = Pattern.compile("^[A-Za-z0-9]{2,64}$");

    /** { origin, code } from a link ("" origin for hearth://, which means "my server"), or null if it isn't an invite. */
    static String[] parse(String link) {
        if (link == null || link.length() > 2000) return null;
        URI u;
        try { u = new URI(link); } catch (Exception e) { return null; }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (u.getRawUserInfo() != null) return null;
        String path = u.getRawPath() == null ? "" : u.getRawPath();
        if ("hearth".equals(scheme)) {
            if (!"invite".equalsIgnoreCase(u.getHost())) return null;
            String code = trimSlash(path.startsWith("/") ? path.substring(1) : path);
            return CODE.matcher(code).matches() ? new String[] { "", code } : null;
        }
        if (!"https".equals(scheme) || u.getHost() == null) return null;
        if (!path.startsWith("/invite/")) return null;
        String code = trimSlash(path.substring("/invite/".length()));
        if (!CODE.matcher(code).matches()) return null;
        int port = u.getPort();
        String origin = "https://" + u.getHost().toLowerCase(Locale.ROOT) + (port > 0 && port != 443 ? ":" + port : "");
        return new String[] { origin, code };
    }

    /** Whether an invite parsed from a link can be opened on the server the app uses. */
    static boolean forServer(String[] invite, String serverOrigin) {
        if (invite == null || serverOrigin == null || serverOrigin.isEmpty()) return false;
        return invite[0].isEmpty() || invite[0].equals(normalOrigin(serverOrigin));
    }

    /** The page to open for an invite on the app's server. */
    static String target(String serverOrigin, String code) {
        return normalOrigin(serverOrigin) + "/invite/" + code;
    }

    // "https://Chat.Example.com:443" -> "https://chat.example.com"
    static String normalOrigin(String origin) {
        if (origin == null) return "";
        String o = origin.trim();
        int i = o.indexOf("://");
        if (i < 0) return o;
        String scheme = o.substring(0, i).toLowerCase(Locale.ROOT);
        String rest = o.substring(i + 3).toLowerCase(Locale.ROOT);
        if (rest.endsWith("/")) rest = rest.substring(0, rest.length() - 1);
        if ("https".equals(scheme) && rest.endsWith(":443")) rest = rest.substring(0, rest.length() - 4);
        if ("http".equals(scheme) && rest.endsWith(":80")) rest = rest.substring(0, rest.length() - 3);
        return scheme + "://" + rest;
    }

    private static String trimSlash(String s) { return s.endsWith("/") ? s.substring(0, s.length() - 1) : s; }
}
