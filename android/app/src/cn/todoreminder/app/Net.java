package cn.todoreminder.app;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** 三个接口都用得上的一点点网络代码，不想引第三方库。 */
final class Net {
    private Net() {}

    static String post(Context c, String path, String body, String contentType) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(Cfg.origin(c) + path).openConnection();
        try {
            con.setRequestMethod("POST");
            con.setConnectTimeout(15000);
            con.setReadTimeout(90000);
            con.setDoOutput(true);
            con.setRequestProperty("Content-Type", contentType);
            String t = Cfg.token(c);
            if (!t.isEmpty()) con.setRequestProperty("X-Todo-Token", t);
            byte[] raw = body.getBytes("UTF-8");
            con.setFixedLengthStreamingMode(raw.length);
            OutputStream os = con.getOutputStream();
            os.write(raw);
            os.flush();
            os.close();
            return read(con);
        } finally {
            con.disconnect();
        }
    }

    static String get(Context c, String path) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(Cfg.origin(c) + path).openConnection();
        try {
            con.setRequestMethod("GET");
            con.setConnectTimeout(15000);
            con.setReadTimeout(30000);
            String t = Cfg.token(c);
            if (!t.isEmpty()) con.setRequestProperty("X-Todo-Token", t);
            return read(con);
        } finally {
            con.disconnect();
        }
    }

    private static String read(HttpURLConnection con) throws Exception {
        int code = con.getResponseCode();
        InputStream in = code >= 400 ? con.getErrorStream() : con.getInputStream();
        String text = in == null ? "" : slurp(in);
        if (code == 401) throw new Exception("密钥不对了，进 App 贴一条新链接");
        if (code >= 400 && text.trim().isEmpty()) throw new Exception("服务器返回 " + code);
        return text;
    }

    private static String slurp(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
