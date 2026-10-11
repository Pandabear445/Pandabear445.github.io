package app.hearth.mobile;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * One decrypted push from the Hearth server: { title, body, tag, url, at, generic?, _ }. Plain Java, so it's
 * tested on any JVM (org.json is only a stub outside a phone).
 *
 * Strict: anything that isn't a JSON object of at most 4096 bytes with a valid tag is dropped. Unknown keys are
 * skipped whatever their value, so a newer server adding fields never breaks an older app. The url always comes
 * out as an in-app address.
 */
final class PushPayload {
    final String title;
    final String body;
    final String tag;
    final String url;
    final String generic;
    final long at;

    private PushPayload(String title, String body, String tag, String url, String generic, long at) {
        this.title = title; this.body = body; this.tag = tag; this.url = url; this.generic = generic; this.at = at;
    }

    static PushPayload parse(byte[] utf8) {
        if (utf8 == null || utf8.length == 0 || utf8.length > PushPolicy.MAX_PAYLOAD_BYTES) return null;
        Map<String, Object> m;
        try { m = new Reader(new String(utf8, StandardCharsets.UTF_8)).object(); } catch (RuntimeException e) { return null; }
        if (m == null) return null;
        String tag = str(m.get("tag"));
        if (!PushPolicy.validTag(tag)) return null;
        Object at = m.get("at");
        long when = at instanceof Double && !((Double) at).isNaN() && !((Double) at).isInfinite() ? (long) (double) (Double) at : 0;
        return new PushPayload(str(m.get("title")), str(m.get("body")), tag, PushPolicy.safeOpenPath(str(m.get("url"))), str(m.get("generic")), Math.max(0, when));
    }

    private static String str(Object o) { return o instanceof String ? (String) o : ""; }

    /**
     * A small JSON reader for one flat object: string and number values are kept, anything else (objects, arrays,
     * true/false/null) is skipped. Throws on malformed input.
     */
    private static final class Reader {
        private final String s;
        private int i;
        private int depth;
        Reader(String s) { this.s = s; }

        Map<String, Object> object() {
            ws();
            if (!eat('{')) return null;
            Map<String, Object> out = new HashMap<>();
            ws();
            if (eat('}')) return end(out);
            while (true) {
                ws();
                String key = string();
                ws();
                expect(':');
                ws();
                Object v = topValue();
                if (v != null) out.put(key, v); else out.remove(key); // last one wins, even a skipped one
                ws();
                if (eat(',')) continue;
                expect('}');
                return end(out);
            }
        }
        private Map<String, Object> end(Map<String, Object> out) { ws(); if (i != s.length()) throw bad(); return out; }

        private Object topValue() {
            char c = peek();
            if (c == '"') return string();
            if (c == '-' || (c >= '0' && c <= '9')) return number();
            skipValue();
            return null;
        }
        private void skipValue() {
            char c = peek();
            if (c == '"') { string(); return; }
            if (c == '-' || (c >= '0' && c <= '9')) { number(); return; }
            if (c == '{' || c == '[') {
                if (++depth > 32) throw bad();
                char close = c == '{' ? '}' : ']';
                i++;
                ws();
                if (eat(close)) { depth--; return; }
                while (true) {
                    ws();
                    if (close == '}') { string(); ws(); expect(':'); ws(); }
                    skipValue();
                    ws();
                    if (eat(',')) continue;
                    expect(close);
                    depth--;
                    return;
                }
            }
            for (String w : new String[] { "true", "false", "null" }) if (s.startsWith(w, i)) { i += w.length(); return; }
            throw bad();
        }
        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw bad();
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c < 0x20) throw bad();
                if (c != '\\') { sb.append(c); continue; }
                if (i >= s.length()) throw bad();
                char e = s.charAt(i++);
                switch (e) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw bad();
                        try { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); } catch (NumberFormatException x) { throw bad(); }
                        i += 4;
                        break;
                    default: throw bad();
                }
            }
        }
        private Double number() {
            int start = i;
            if (peek() == '-') i++;
            while (i < s.length() && "0123456789.eE+-".indexOf(s.charAt(i)) >= 0) i++;
            try { return Double.valueOf(s.substring(start, i)); } catch (NumberFormatException e) { throw bad(); }
        }
        private void ws() { while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++; }
        private char peek() { if (i >= s.length()) throw bad(); return s.charAt(i); }
        private boolean eat(char c) { if (i < s.length() && s.charAt(i) == c) { i++; return true; } return false; }
        private void expect(char c) { if (!eat(c)) throw bad(); }
        private static IllegalArgumentException bad() { return new IllegalArgumentException("bad json"); }
    }
}
