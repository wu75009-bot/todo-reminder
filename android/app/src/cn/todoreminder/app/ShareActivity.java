package cn.todoreminder.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 系统分享面板的落点。
 *
 * QQ / 微信里长按一条消息或一张图 → 分享 → 选「待办」，这边就把内容交给服务器，
 * 识别 + 排提醒一步做完，再把结果贴在最上面。用户全程不用离开聊天窗口太久。
 */
public class ShareActivity extends Activity {

    private TextView label;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(build());
        final Intent it = getIntent();
        new Thread(() -> {
            String msg;
            try {
                msg = handle(it);
            } catch (Exception e) {
                msg = "没记上\n" + shortMsg(e);
            }
            final String out = msg;
            ui.post(() -> finishWith(out));
        }).start();
    }

    private ViewGroup build() {
        float d = getResources().getDisplayMetrics().density;
        FrameLayout root = new FrameLayout(this);
        root.setPadding((int) (28 * d), (int) (28 * d), (int) (28 * d), (int) (28 * d));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        int p = (int) (20 * d);
        card.setPadding(p, p, p, p);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF0151618);
        bg.setCornerRadius(24 * d);
        card.setBackground(bg);

        label = new TextView(this);
        label.setTextColor(Color.WHITE);
        label.setTextSize(15f);
        label.setLineSpacing(6 * d, 1f);
        label.setGravity(Gravity.CENTER);
        label.setMaxWidth((int) (300 * d));
        label.setText("正在记…");
        card.addView(label);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        root.addView(card, lp);
        return root;
    }

    private String handle(Intent it) throws Exception {
        if (it == null || !Intent.ACTION_SEND.equals(it.getAction())) return "这条没东西可记";

        String type = it.getType() == null ? "" : it.getType();
        Uri stream = (Uri) it.getParcelableExtra(Intent.EXTRA_STREAM);
        String text = it.getStringExtra(Intent.EXTRA_TEXT);

        if (type.startsWith("image/") && stream != null) return shareImage(stream);

        // 有的 App 把图当文件分享，EXTRA_TEXT 里只有一坨链接，那就当文本记
        if (text != null && !text.trim().isEmpty()) return shareText(text);
        if (stream != null) return shareImage(stream);
        return "这条没东西可记";
    }

    private String shareText(String text) throws Exception {
        String resp = Net.post(this, "/api/share", text, "text/plain; charset=utf-8");
        return resp.trim().isEmpty() ? "记下了" : resp.trim();
    }

    private String shareImage(Uri uri) throws Exception {
        String dataUrl = toDataUrl(uri);
        String resp = Net.post(this, "/api/photo",
                new JSONObject().put("dataUrl", dataUrl).toString(),
                "application/json; charset=utf-8");

        JSONObject o = new JSONObject(resp);
        if (!o.optBoolean("ok")) return "没认出来\n" + o.optString("error", "换张清楚点的图试试");
        JSONObject task = o.optJSONObject("task");
        String title = task == null ? "" : task.optString("title", "");
        int created = o.optInt("created", 0);
        String head = "记下了" + (title.isEmpty() ? "" : "：" + title);
        if (created <= 0) return head + "\n（没认出时间，不会提醒）";
        return head + "\n会提醒 " + created + " 次";
    }

    /** 直出照片三五兆，传上去慢还容易超时：先等比压到 1600px、JPEG 85。 */
    private String toDataUrl(Uri uri) throws Exception {
        BitmapFactory.Options probe = new BitmapFactory.Options();
        probe.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(in, null, probe);
        } catch (Exception e) {
            throw new Exception("这张图打不开");
        }
        int scale = 1;
        int longest = Math.max(probe.outWidth, probe.outHeight);
        while (longest / scale > 1600) scale *= 2;

        BitmapFactory.Options opt = new BitmapFactory.Options();
        opt.inSampleSize = scale;
        Bitmap bmp;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            bmp = BitmapFactory.decodeStream(in, null, opt);
        }
        if (bmp == null) throw new Exception("这张图打不开");

        int w = bmp.getWidth(), h = bmp.getHeight();
        float f = Math.min(1f, 1600f / Math.max(w, h));
        if (f < 1f) bmp = Bitmap.createScaledBitmap(bmp, Math.round(w * f), Math.round(h * f), true);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    private void finishWith(String msg) {
        if (label != null) label.setText(msg);
        ui.postDelayed(this::finish, 2600);
    }

    private static String shortMsg(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.trim().isEmpty()) m = e.getClass().getSimpleName();
        return m;
    }
}
