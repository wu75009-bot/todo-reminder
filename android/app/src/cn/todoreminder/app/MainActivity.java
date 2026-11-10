package cn.todoreminder.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 就是一个把手机页装进来的壳。
 *
 * 为什么不直接做原生界面：那套页面在浏览器里已经调好了（排版、深色模式、提醒预览），
 * 重写一遍只会多出一份要同步维护的代码。壳负责三件浏览器给不了的事：
 * 常驻图标、系统分享入口、把 token 藏进 App 里不用每次贴链接。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_CAL = 1002;

    private WebView web;
    private ValueCallback<Uri[]> pending;
    private Uri cameraUri;
    private boolean askedForUrl;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.parseColor("#f6f7f9"));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#f6f7f9"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                checkLocked();
            }
        });

        // 关键：页面里的 <input type="file"> 在 WebView 里默认没反应，
        // 不接管的话「拍照」「相册」两个按钮点下去像死了一样。
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                return pickFile(cb, params);
            }
        });

        web.loadUrl(Cfg.url(this));
        web.addJavascriptInterface(new Bridge(), "TodoApp");
    }

    /**
     * 页面里点「同步到手机日历」会调到这儿。
     * 走原生是因为只有原生拿得到日历权限 —— 网页里那条 .ics 链接在安卓上等于死链。
     */
    public class Bridge {
        @JavascriptInterface
        public void syncCalendar() {
            runOnUiThread(() -> {
                if (checkSelfPermission(Manifest.permission.WRITE_CALENDAR)
                        != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{
                            Manifest.permission.WRITE_CALENDAR,
                            Manifest.permission.READ_CALENDAR}, REQ_CAL);
                } else {
                    doSyncCalendar();
                }
            });
        }
    }

    private void doSyncCalendar() {
        Toast.makeText(this, "正在写进手机日历…", Toast.LENGTH_SHORT).show();
        final Context ctx = this;
        new Thread(() -> {
            String msg;
            try {
                long calId = Cal.writableCalendar(ctx);
                if (calId < 0) {
                    msg = "手机里没有可写的日历，先在日历 App 里建一个「本地日历」";
                } else {
                    String json = Net.get(ctx, "/api/calendar.json?days=60");
                    int n = Cal.sync(ctx, calId, json);
                    msg = n > 0 ? "已写进手机日历：" + n + " 条，提醒也会响" : "没有需要同步的日程";
                }
            } catch (Exception e) {
                String m = e.getMessage();
                msg = "同步失败：" + (m == null || m.trim().isEmpty() ? e.getClass().getSimpleName() : m);
            }
            final String out = msg;
            runOnUiThread(() -> Toast.makeText(this, out, Toast.LENGTH_LONG).show());
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        if (req != REQ_CAL) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
            doSyncCalendar();
        } else {
            Toast.makeText(this, "没给日历权限，写不进去", Toast.LENGTH_LONG).show();
        }
    }

    /** 页面自报 401（链接里 token 过期）时，让它就地换一条，不必重装。 */
    private void checkLocked() {
        if (askedForUrl) return;
        web.evaluateJavascript(
                "(function(){var l=document.getElementById('locked');"
                        + "return (l && !l.hidden) ? 'LOCKED' : 'OK';})()",
                value -> {
                    if (value != null && value.contains("LOCKED")) askForUrl();
                });
    }

    private void askForUrl() {
        askedForUrl = true;
        EditText et = new EditText(this);
        et.setInputType(InputType.TYPE_CLASS_TEXT);
        et.setHint("http://…/m?t=…");
        et.setText(Cfg.url(this));
        et.setSelection(et.getText().length());
        new AlertDialog.Builder(this)
                .setTitle("链接无效了")
                .setMessage("把新的那条链接整条贴进来，以后就用它。")
                .setView(et)
                .setPositiveButton("用这条", (d, w) -> {
                    String s = et.getText().toString().trim();
                    if (!s.startsWith("http")) {
                        Toast.makeText(this, "这不是一条链接", Toast.LENGTH_SHORT).show();
                        askedForUrl = false;
                        return;
                    }
                    Cfg.prefs(this).edit().putString(Cfg.KEY_URL, s).apply();
                    web.loadUrl(s);
                })
                .setNegativeButton("先不管", null)
                .show();
    }

    private boolean pickFile(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams params) {
        if (pending != null) pending.onReceiveValue(null);
        pending = cb;
        cameraUri = null;

        boolean wantCamera = false;
        try {
            wantCamera = params != null && params.isCaptureEnabled();
        } catch (Throwable ignored) {
        }

        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("image/*");
        Intent chooser = Intent.createChooser(pick, "选一张图");

        if (wantCamera) {
            try {
                cameraUri = newImageUri();
                if (cameraUri != null) {
                    Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
                }
            } catch (Throwable e) {
                cameraUri = null; // 老系统拿不到媒体库写权限就只给相册，不算失败
            }
        }

        try {
            startActivityForResult(chooser, REQ_FILE);
            return true;
        } catch (Throwable e) {
            pending = null;
            cb.onReceiveValue(null);
            return false;
        }
    }

    private Uri newImageUri() {
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Images.Media.DISPLAY_NAME, "todo-" + System.currentTimeMillis() + ".jpg");
        cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        if (Build.VERSION.SDK_INT >= 29) {
            cv.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures");
        }
        return getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) {
            super.onActivityResult(req, res, data);
            return;
        }
        Uri[] out = null;
        if (res == RESULT_OK) {
            Uri picked = data != null ? data.getData() : null;
            if (picked != null) out = new Uri[]{picked};
            else if (cameraUri != null) out = new Uri[]{cameraUri};
        }
        if (pending != null) pending.onReceiveValue(out);
        pending = null;
        cameraUri = null;
    }

    @Override
    public void onBackPressed() {
        // 页面里没有跳转，返回就是退出；但别把输入到一半的内容干掉
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        moveTaskToBack(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setWebChromeClient(null);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
