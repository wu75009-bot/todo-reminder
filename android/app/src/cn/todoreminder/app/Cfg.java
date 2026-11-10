package cn.todoreminder.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 服务器地址与密钥的唯一来源。
 *
 * 页面报「链接无效」时 App 会让用户贴一条新链接，存进 SharedPreferences；
 * 之后主界面和分享入口都从这里取，改链接不用重装 APK。
 */
final class Cfg {
    static final String PREFS = "todo";
    static final String KEY_URL = "url";

    /** 出厂的默认链接（手机页 + 密钥）。 */
    static final String DEF_URL = "http://118.178.175.48:6099/m?t=8TSSSALCETUXGK89";

    private static final Pattern TOKEN = Pattern.compile("[?&]t=([^&#]+)");

    private Cfg() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String url(Context c) {
        String s = prefs(c).getString(KEY_URL, "");
        return s == null || s.trim().isEmpty() ? DEF_URL : s.trim();
    }

    /** 从整条链接里抠出 t= 那一段，分享接口要拿它做鉴权。 */
    static String token(Context c) {
        Matcher m = TOKEN.matcher(url(c));
        return m.find() ? m.group(1) : "";
    }

    /** http://host:port/m?t=xxx → http://host:port，拼 /api/share 用。 */
    static String origin(Context c) {
        String u = url(c);
        int i = u.indexOf("/m");
        if (i < 0) {
            int q = u.indexOf('?');
            return q < 0 ? u : u.substring(0, q);
        }
        return u.substring(0, i);
    }
}
