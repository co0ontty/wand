package com.wand.app;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends AppCompatActivity {

    private static final String CHANNEL_ID_SILENT = "wand_notif_silent";
    private static final String CHANNEL_ID_TASKS = "wand_notif_tasks";
    private static final String CHANNEL_ID_UPDATES = "wand_notif_updates";
    private static final String CHANNEL_ID_PROGRESS = "wand_notif_progress";
    private static final String CHANNEL_ID_PREFIX_LEGACY = "wand_notif_";
    private static final String CHANNEL_ID_LEGACY = "wand_notifications";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final int FILE_CHOOSER_REQUEST = 1002;
    private static final int NOTIFICATION_ID_BASE = 2000;
    private static final long PROGRESS_UPDATE_DEBOUNCE_MS = 50;

    private static final String[][] SOUND_PRESETS = {
        {"chime",  "叮咚"},
        {"bubble", "气泡"},
        {"meow",   "喵~"},
        {"bell",   "铃声"},
    };

    private WebView webView;
    private LinearLayout errorOverlay;
    private LinearLayout loadingOverlay;
    private TextView errorMessage;
    private String serverUrl;
    private String appToken;
    private boolean hasLoadedPage = false;
    private boolean updateCheckDone = false;
    private int notificationCounter = 0;
    private final Map<String, Long> progressUpdateTimestamps = new HashMap<>();
    private final Map<String, Runnable> pendingProgressUpdates = new HashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private boolean keepAliveRunning = false;
    private long lastBackPressedTime = 0;

    // Last known system-bar safe-area insets, in CSS pixels (dp). Android
    // targetSdk 35+ forces edge-to-edge, so the WebView renders behind the
    // status bar; but Android WebView does NOT propagate these insets to
    // env(safe-area-inset-*). We capture them in onApplyWindowInsetsListener
    // and inject them into --app-inset-* CSS variables on every page load.
    private float lastInsetTopDp = 0f;
    private float lastInsetBottomDp = 0f;
    private float lastInsetLeftDp = 0f;
    private float lastInsetRightDp = 0f;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // 让状态栏/导航栏图标颜色匹配 wand 主题; 同时初始化 inset bridge 之前
        // 先确认控制器在位。
        applySystemBarAppearance();

        serverUrl = getIntent().getStringExtra("server_url");
        appToken = getIntent().getStringExtra("app_token");
        if (serverUrl == null || serverUrl.isEmpty()) {
            finish();
            return;
        }

        webView = findViewById(R.id.webView);
        errorOverlay = findViewById(R.id.errorOverlay);
        loadingOverlay = findViewById(R.id.loadingOverlay);
        errorMessage = findViewById(R.id.errorMessage);

        MaterialButton retryButton = findViewById(R.id.retryButton);
        MaterialButton backButton = findViewById(R.id.backToConnectButton);

        retryButton.setOnClickListener(v -> {
            hideError();
            webView.loadUrl(serverUrl);
        });

        backButton.setOnClickListener(v -> {
            Intent connectIntent = new Intent(this, ConnectActivity.class);
            connectIntent.putExtra("skip_auto_connect", true);
            connectIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(connectIntent);
            finish();
        });

        // Volume keys in this activity should adjust the notification stream,
        // so users see the "Notification volume" slider when they press volume
        // buttons — and lowering it to 0 actually mutes our notification sounds.
        // (Default for activities is STREAM_MUSIC, which is why volume keys
        // previously controlled media volume even though our sound routes to
        // STREAM_NOTIFICATION via AudioAttributes.)
        setVolumeControlStream(AudioManager.STREAM_NOTIFICATION);

        createNotificationChannels();
        setupWebView();
        webView.loadUrl(serverUrl);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{return window.handleNativeBack?window.handleNativeBack():false;}catch(e){return false;}})()",
                    result -> {
                        if ("true".equals(result)) return;
                        long now = System.currentTimeMillis();
                        if (now - lastBackPressedTime < 2000) {
                            finish();
                        } else {
                            lastBackPressedTime = now;
                            Toast.makeText(MainActivity.this, "再按一次退出", Toast.LENGTH_SHORT).show();
                        }
                    }
                );
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        // 设 WebView 背景色匹配主题 background, 避免 (a) 首次 loadUrl 之前
        // WebView 默认白底闪一下; (b) 暗黑色页面切换时露出 WebView 的白底。
        // 跟 themes.xml 的 windowBackground 同一色, 整个启动 → ConnectActivity
        // → MainActivity → WebView 首帧, 色温保持一致。
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.background));

        // 让后台 WebView 渲染进程保持高优先级, 这样切到其他 App 再回来时
        // Chromium 不会因为内存抖动重启 renderer (renderer 重启 = WebSocket
        // 整路重建, 用户看到的就是"切回来卡顿几秒、消息延迟到"的体感)。
        // RENDERER_PRIORITY_IMPORTANT 在 minSdk 24 就有, 不需要版本守卫。
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        // 让 WebView 在视口外多保留一帧栅格化结果, 滚动 / 切换抽屉时的
        // 重绘成本明显下降。AndroidX webkit 1.0+ 支持, minSdk OK。
        if (WebViewFeature.isFeatureSupported(WebViewFeature.OFF_SCREEN_PRERASTER)) {
            WebSettingsCompat.setOffscreenPreRaster(settings, true);
        }

        // Dynamic version in User-Agent
        String versionName = "1.0";
        try {
            versionName = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {}
        settings.setUserAgentString(settings.getUserAgentString() + " WandApp/" + versionName);

        // Enable cookies
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // Capture system-bar insets so we can inject them as CSS variables.
        // (See lastInsetTopDp comment above for why.)
        installWindowInsetsBridge();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                hasLoadedPage = true;
                hideError();
                // 首帧到达, fade out 启动 loading overlay (原生层接力 web 的
                // boot-loading 卡片, 全程无白闪)。淡出 200ms 后 gone 掉, 这样
                // 触摸事件直接落到 WebView 上。
                hideLoadingOverlay();
                // 注入原生 inset marker 类, 让 CSS 关掉 32px 兜底 (因为我们已经
                // 在 WebView 上加了原生 padding, 不需要再多一层 CSS padding)。
                injectNativeInsetsMarker();
                if (!updateCheckDone) {
                    updateCheckDone = true;
                    checkForApkUpdate();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError(getString(R.string.connection_failed));
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.proceed();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(serverUrl)) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, request.getUrl());
                    startActivity(intent);
                } catch (Exception e) {
                    // ignore
                }
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 渲染进程崩溃（OOM 或未处理异常）时重建 WebView，避免整个 Activity 闪退
                try {
                    android.view.ViewGroup parent = (android.view.ViewGroup) view.getParent();
                    if (parent != null) parent.removeView(view);
                    view.destroy();
                    webView = new WebView(MainActivity.this);
                    webView.setLayoutParams(new android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT));
                    if (parent != null) parent.addView(webView, 0);
                    // 重建期间 loading overlay 重新可见, 让用户知道"页面在恢复"
                    // 而不是"App 自己刷新了一下" (静默重建容易让用户以为是 bug)。
                    if (loadingOverlay != null) {
                        loadingOverlay.setAlpha(1f);
                        loadingOverlay.setVisibility(View.VISIBLE);
                    }
                    Toast.makeText(MainActivity.this, R.string.renderer_crashed,
                            Toast.LENGTH_SHORT).show();
                    setupWebView();
                    webView.loadUrl(serverUrl);
                } catch (Exception e) {
                    recreate();
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (pendingFileChooserCallback != null) {
                    pendingFileChooserCallback.onReceiveValue(null);
                }
                pendingFileChooserCallback = filePathCallback;

                Intent contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
                contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
                contentIntent.setType("*/*");

                String[] acceptTypes = fileChooserParams.getAcceptTypes();
                List<String> mimeTypes = new ArrayList<>();
                if (acceptTypes != null) {
                    for (String t : acceptTypes) {
                        if (t != null && !t.trim().isEmpty()) mimeTypes.add(t.trim());
                    }
                }
                if (!mimeTypes.isEmpty()) {
                    contentIntent.putExtra(Intent.EXTRA_MIME_TYPES,
                            mimeTypes.toArray(new String[0]));
                }
                if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    contentIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }

                Intent chooser = Intent.createChooser(contentIntent,
                        fileChooserParams.getTitle() != null
                                ? fileChooserParams.getTitle().toString()
                                : "选择文件");
                try {
                    startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    pendingFileChooserCallback = null;
                    filePathCallback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "未找到可用的文件选择器",
                            Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // Register JS bridge for native notifications
        webView.addJavascriptInterface(new NotificationBridge(), "WandNative");
    }

    // ── Notification channels ──

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null) return;

            // Remove legacy channels (sound was baked in, can't change volume)
            nm.deleteNotificationChannel(CHANNEL_ID_LEGACY);
            for (String[] preset : SOUND_PRESETS) {
                nm.deleteNotificationChannel(CHANNEL_ID_PREFIX_LEGACY + preset[0]);
            }

            // Silent checks / low-priority notices
            if (nm.getNotificationChannel(CHANNEL_ID_SILENT) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID_SILENT, "Wand 轻提醒", NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("低优先级提醒（铃声由应用内控制）");
                channel.setSound(null, null);
                nm.createNotificationChannel(channel);
            }

            if (nm.getNotificationChannel(CHANNEL_ID_TASKS) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID_TASKS, "Wand 任务", NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("任务进展与权限提醒");
                channel.setSound(null, null);
                nm.createNotificationChannel(channel);
            }

            if (nm.getNotificationChannel(CHANNEL_ID_UPDATES) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID_UPDATES, "Wand 更新", NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription("版本更新提醒");
                channel.setSound(null, null);
                nm.createNotificationChannel(channel);
            }

            if (nm.getNotificationChannel(CHANNEL_ID_PROGRESS) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID_PROGRESS, "Wand 实时进度", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("任务实时进度通知");
                channel.setSound(null, null);
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
    }

    private static final AudioAttributes NOTIF_AUDIO_ATTRS = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            // Belt-and-suspenders: ensure routing to STREAM_NOTIFICATION even on
            // OEM ROMs that don't honor USAGE_NOTIFICATION strictly.
            .setLegacyStreamType(AudioManager.STREAM_NOTIFICATION)
            .build();

    /**
     * Returns true when the device's ringer mode means we should not play any
     * audible notification sound (silent or vibrate).
     */
    private boolean isSystemMuted() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) return false;
        int mode = am.getRingerMode();
        if (mode == AudioManager.RINGER_MODE_SILENT
                || mode == AudioManager.RINGER_MODE_VIBRATE) {
            return true;
        }
        // Defensive: if the notification stream itself is at 0, also skip.
        return am.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0;
    }

    private void playNotificationSound() {
        if (isSystemMuted()) return;

        ServerStore store = new ServerStore(this);
        String soundName = store.getNotificationSound();
        float vol = store.getNotificationVolume() / 100f;
        if (vol <= 0) return;

        int resId = getResources().getIdentifier("notif_" + soundName, "raw", getPackageName());
        if (resId == 0) return;

        try {
            MediaPlayer mp = MediaPlayer.create(this, resId, NOTIF_AUDIO_ATTRS, 0);
            if (mp != null) {
                mp.setVolume(vol, vol);
                mp.setOnCompletionListener(MediaPlayer::release);
                mp.start();
            }
        } catch (Exception ignored) {}
    }

    private String resolveNotificationChannel(String tag) {
        if (tag == null || tag.isEmpty()) {
            return CHANNEL_ID_SILENT;
        }
        if (tag.startsWith("update:")) {
            return CHANNEL_ID_UPDATES;
        }
        if (tag.startsWith("task:") || tag.startsWith("permission:") || tag.startsWith("task-ended:")) {
            return CHANNEL_ID_TASKS;
        }
        return CHANNEL_ID_SILENT;
    }

    private int resolveNotificationPriority(String channelId) {
        if (CHANNEL_ID_UPDATES.equals(channelId)) {
            return NotificationCompat.PRIORITY_HIGH;
        }
        return NotificationCompat.PRIORITY_DEFAULT;
    }

    // ── JS bridge ──

    private class NotificationBridge {

        /**
         * Allow the in-WebView UI to jump back to the connect screen, which lists
         * recent servers — used by the "switch server" buttons on the logout area
         * and the login form.
         */
        @JavascriptInterface
        public void switchServer() {
            runOnUiThread(() -> {
                Intent connectIntent = new Intent(MainActivity.this, ConnectActivity.class);
                connectIntent.putExtra("skip_auto_connect", true);
                connectIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(connectIntent);
                finish();
            });
        }

        @JavascriptInterface
        public String getPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                return "granted"; // Pre-Android 13 doesn't need runtime permission
            }
            int result = ContextCompat.checkSelfPermission(
                    MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS);
            if (result == PackageManager.PERMISSION_GRANTED) return "granted";
            if (ActivityCompat.shouldShowRequestPermissionRationale(
                    MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS)) {
                return "denied";
            }
            return "default";
        }

        @JavascriptInterface
        public void requestPermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                runOnUiThread(() -> ActivityCompat.requestPermissions(
                        MainActivity.this,
                        new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                        NOTIFICATION_PERMISSION_REQUEST));
            }
        }

        @JavascriptInterface
        public String getAppIcon() {
            ServerStore store = new ServerStore(MainActivity.this);
            return store.getAppIcon();
        }

        @JavascriptInterface
        public void setAppIcon(String iconName) {
            if (!"shorthair".equals(iconName) && !"garfield".equals(iconName)) return;

            ServerStore store = new ServerStore(MainActivity.this);
            String current = store.getAppIcon();
            if (iconName.equals(current)) return;

            store.setAppIcon(iconName);

            PackageManager pm = getPackageManager();
            String pkg = getPackageName();
            ComponentName shorthairAlias = new ComponentName(pkg, pkg + ".ConnectActivity.Shorthair");
            ComponentName garfieldAlias = new ComponentName(pkg, pkg + ".ConnectActivity.Garfield");

            if ("garfield".equals(iconName)) {
                pm.setComponentEnabledSetting(shorthairAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(garfieldAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
            } else {
                pm.setComponentEnabledSetting(garfieldAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(shorthairAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
            }
        }

        @JavascriptInterface
        public String getAppVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void downloadUpdate(String url, String fileName, String source) {
            runOnUiThread(() -> downloadAndInstall(url, fileName, source, null));
        }

        @JavascriptInterface
        public void sendNotification(String title, String body, String tag) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ContextCompat.checkSelfPermission(MainActivity.this,
                        android.Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    return;
                }
            }

            Intent intent = new Intent(MainActivity.this, MainActivity.class);
            intent.putExtra("server_url", serverUrl);
            if (appToken != null) intent.putExtra("app_token", appToken);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            int requestCode = (tag != null ? tag.hashCode() : notificationCounter++) & 0x7FFFFFFF;
            PendingIntent pi = PendingIntent.getActivity(
                    MainActivity.this, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            String channelId = resolveNotificationChannel(tag);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, channelId)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title != null ? title : "Wand")
                    .setContentText(body != null ? body : "")
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body != null ? body : ""))
                    .setPriority(resolveNotificationPriority(channelId))
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setSilent(true);

            String notifyTag = tag;
            if (notifyTag != null) {
                NotificationManagerCompat.from(MainActivity.this).notify(notifyTag, 0, builder.build());
            } else {
                NotificationManagerCompat.from(MainActivity.this).notify(
                        NOTIFICATION_ID_BASE + (notificationCounter % 20), builder.build());
            }

            // Play sound manually with volume control
            playNotificationSound();
        }

        @JavascriptInterface
        public String getNotificationSound() {
            return new ServerStore(MainActivity.this).getNotificationSound();
        }

        @JavascriptInterface
        public void setNotificationSound(String name) {
            // Validate against known presets
            boolean valid = false;
            for (String[] preset : SOUND_PRESETS) {
                if (preset[0].equals(name)) { valid = true; break; }
            }
            if (!valid) return;
            new ServerStore(MainActivity.this).setNotificationSound(name);
        }

        @JavascriptInterface
        public String getAvailableSounds() {
            try {
                JSONArray arr = new JSONArray();
                for (String[] preset : SOUND_PRESETS) {
                    JSONObject obj = new JSONObject();
                    obj.put("id", preset[0]);
                    obj.put("name", preset[1]);
                    arr.put(obj);
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public int getNotificationVolume() {
            return new ServerStore(MainActivity.this).getNotificationVolume();
        }

        @JavascriptInterface
        public void setNotificationVolume(int volume) {
            new ServerStore(MainActivity.this).setNotificationVolume(volume);
        }

        @JavascriptInterface
        public void previewSound(String name) {
            // Validate
            boolean valid = false;
            for (String[] preset : SOUND_PRESETS) {
                if (preset[0].equals(name)) { valid = true; break; }
            }
            if (!valid) return;

            runOnUiThread(() -> {
                if (isSystemMuted()) {
                    Toast.makeText(MainActivity.this,
                            "系统已静音/振动模式，无法预览声音",
                            Toast.LENGTH_SHORT).show();
                    return;
                }
                try {
                    int resId = getResources().getIdentifier("notif_" + name, "raw", getPackageName());
                    if (resId == 0) return;
                    MediaPlayer mp = MediaPlayer.create(MainActivity.this, resId, NOTIF_AUDIO_ATTRS, 0);
                    if (mp != null) {
                        float vol = new ServerStore(MainActivity.this).getNotificationVolume() / 100f;
                        mp.setVolume(vol, vol);
                        mp.setOnCompletionListener(MediaPlayer::release);
                        mp.start();
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void updateSessionProgress(String sessionId, String jsonData) {
            if (sessionId == null || sessionId.isEmpty() || jsonData == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ContextCompat.checkSelfPermission(MainActivity.this,
                        android.Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    return;
                }
            }
            long now = System.currentTimeMillis();
            Long lastUpdate = progressUpdateTimestamps.get(sessionId);
            if (lastUpdate != null && (now - lastUpdate) < PROGRESS_UPDATE_DEBOUNCE_MS) {
                Runnable pending = pendingProgressUpdates.remove(sessionId);
                if (pending != null) mainHandler.removeCallbacks(pending);
                Runnable deferred = () -> {
                    pendingProgressUpdates.remove(sessionId);
                    progressUpdateTimestamps.put(sessionId, System.currentTimeMillis());
                    doUpdateSessionProgress(sessionId, jsonData);
                };
                pendingProgressUpdates.put(sessionId, deferred);
                mainHandler.postDelayed(deferred, PROGRESS_UPDATE_DEBOUNCE_MS);
                return;
            }
            progressUpdateTimestamps.put(sessionId, now);
            doUpdateSessionProgress(sessionId, jsonData);
        }

        @JavascriptInterface
        public void clearSessionProgress(String sessionId) {
            if (sessionId == null || sessionId.isEmpty()) return;
            progressUpdateTimestamps.remove(sessionId);
            Runnable pending = pendingProgressUpdates.remove(sessionId);
            if (pending != null) mainHandler.removeCallbacks(pending);
            NotificationManagerCompat.from(MainActivity.this).cancel("progress:" + sessionId, 0);
        }

        // ── Clipboard ──

        @JavascriptInterface
        public String copyToClipboard(String text) {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager)
                        getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("wand", text));
                    return "ok";
                }
                return "error";
            } catch (Exception e) {
                return "error";
            }
        }

        // ── Wake lock ──

        @JavascriptInterface
        public void setKeepScreenOn(boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        // ── Foreground service ──

        @JavascriptInterface
        public void startKeepAlive() {
            if (keepAliveRunning) return;
            keepAliveRunning = true;
            runOnUiThread(() -> {
                try {
                    Intent serviceIntent = new Intent(MainActivity.this, WandForegroundService.class);
                    serviceIntent.putExtra("server_url", serverUrl);
                    serviceIntent.putExtra("app_token", appToken);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(serviceIntent);
                    } else {
                        startService(serviceIntent);
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void stopKeepAlive() {
            if (!keepAliveRunning) return;
            keepAliveRunning = false;
            runOnUiThread(() -> {
                try {
                    stopService(new Intent(MainActivity.this, WandForegroundService.class));
                } catch (Exception ignored) {}
            });
        }

        // ── Haptic feedback ──

        @JavascriptInterface
        public void vibrate(String pattern) {
            if (!new ServerStore(MainActivity.this).isHapticEnabled()) return;
            android.os.Vibrator vibrator = (android.os.Vibrator)
                    getSystemService(android.content.Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    android.os.VibrationEffect effect;
                    switch (pattern != null ? pattern : "light") {
                        case "medium":
                            effect = android.os.VibrationEffect.createOneShot(30,
                                    android.os.VibrationEffect.DEFAULT_AMPLITUDE);
                            break;
                        case "success":
                            effect = android.os.VibrationEffect.createWaveform(
                                    new long[]{0, 10, 80, 10}, -1);
                            break;
                        case "error":
                            effect = android.os.VibrationEffect.createWaveform(
                                    new long[]{0, 30, 60, 30, 60, 30}, -1);
                            break;
                        case "light":
                        default:
                            effect = android.os.VibrationEffect.createOneShot(10,
                                    android.os.VibrationEffect.DEFAULT_AMPLITUDE);
                            break;
                    }
                    vibrator.vibrate(effect);
                } else {
                    switch (pattern != null ? pattern : "light") {
                        case "medium":
                            vibrator.vibrate(30);
                            break;
                        case "success":
                            vibrator.vibrate(new long[]{0, 10, 80, 10}, -1);
                            break;
                        case "error":
                            vibrator.vibrate(new long[]{0, 30, 60, 30, 60, 30}, -1);
                            break;
                        case "light":
                        default:
                            vibrator.vibrate(10);
                            break;
                    }
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public boolean isHapticEnabled() {
            return new ServerStore(MainActivity.this).isHapticEnabled();
        }

        @JavascriptInterface
        public void setHapticEnabled(boolean enabled) {
            new ServerStore(MainActivity.this).setHapticEnabled(enabled);
        }
    }

    private void doUpdateSessionProgress(String sessionId, String jsonData) {
        try {
            JSONObject data = new JSONObject(jsonData);
            String sessionLabel = data.optString("sessionLabel", sessionId);
            String status = data.optString("status", "running");
            String latestUserText = data.optString("latestUserText", "");
            JSONArray todosArray = data.optJSONArray("todos");

            int total = todosArray != null ? todosArray.length() : 0;
            int completed = 0;
            int inProgress = 0;

            if (todosArray != null) {
                for (int i = 0; i < todosArray.length(); i++) {
                    JSONObject todo = todosArray.getJSONObject(i);
                    String todoStatus = todo.optString("status", "pending");
                    if ("completed".equals(todoStatus)) {
                        completed++;
                    } else if ("in_progress".equals(todoStatus)) {
                        inProgress++;
                    }
                }
            }

            boolean isOngoingState = "running".equals(status) || "thinking".equals(status)
                    || "initializing".equals(status);

            // Capsule (minimized live activity): just the count of in-progress
            // tasks, or a short status word. Keep it minimal.
            String capsuleText;
            if (!isOngoingState) {
                capsuleText = "完成";
            } else if (inProgress > 0) {
                capsuleText = String.valueOf(inProgress);
            } else {
                capsuleText = "运行";
            }

            // Expanded view: title is the user's most recent prompt (the
            // message they just sent), body is just the live status.
            String displayTitle = truncateForNotification(
                    pickFirstNonEmpty(latestUserText, sessionLabel, "Wand"), 40);
            String contentText;
            if (!isOngoingState) {
                contentText = "已完成";
            } else if (total > 0) {
                contentText = "执行中";
            } else {
                contentText = "正在执行";
            }

            Intent intent = new Intent(this, MainActivity.class);
            intent.putExtra("server_url", serverUrl);
            if (appToken != null) intent.putExtra("app_token", appToken);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int requestCode = ("progress:" + sessionId).hashCode() & 0x7FFFFFFF;
            PendingIntent pi = PendingIntent.getActivity(this, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID_PROGRESS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(displayTitle)
                    .setContentText(contentText)
                    .setContentIntent(pi)
                    .setOngoing(isOngoingState)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setAutoCancel(!isOngoingState);

            // Only attach a progress style when there are todos AND we're still
            // running — that's where the "spinner / progress" feedback belongs.
            // No todos → no extra style; the single-line title + status is the
            // whole story.
            if (isOngoingState && total > 0) {
                if (Build.VERSION.SDK_INT >= 36) {
                    buildProgressStyleNotification(builder, todosArray, total, completed, inProgress);
                } else {
                    buildFallbackProgressNotification(builder, total, completed);
                }
            }

            builder.setShortCriticalText(capsuleText);
            if (isOngoingState) {
                builder.setRequestPromotedOngoing(true);
            }

            NotificationManagerCompat.from(this).notify("progress:" + sessionId, 0, builder.build());
        } catch (Exception ignored) {}
    }

    private static String pickFirstNonEmpty(String... candidates) {
        if (candidates == null) return "";
        for (String c : candidates) {
            if (c != null && !c.isEmpty()) return c;
        }
        return "";
    }

    private static String truncateForNotification(String text, int max) {
        if (text == null) return "";
        // Collapse newlines so the expanded view stays a tight one/two lines
        // rather than wrapping into a five-line wall.
        String compact = text.replace('\n', ' ').replace('\r', ' ').trim();
        if (compact.length() <= max) return compact;
        return compact.substring(0, Math.max(0, max - 1)) + "…";
    }

    private void buildProgressStyleNotification(NotificationCompat.Builder builder,
            JSONArray todosArray, int total, int completed, int inProgress) {
        try {
            NotificationCompat.ProgressStyle progressStyle = new NotificationCompat.ProgressStyle();
            int currentProgress = completed * 100 + (inProgress > 0 ? 50 : 0);
            progressStyle.setStyledByProgress(false);
            progressStyle.setProgress(currentProgress);

            int completedColor = Color.parseColor("#4CAF50");
            int activeColor = Color.parseColor("#2196F3");
            int pendingColor = Color.parseColor("#9E9E9E");

            for (int i = 0; i < todosArray.length(); i++) {
                JSONObject todo = todosArray.getJSONObject(i);
                String todoStatus = todo.optString("status", "pending");
                int color;
                if ("completed".equals(todoStatus)) {
                    color = completedColor;
                } else if ("in_progress".equals(todoStatus)) {
                    color = activeColor;
                } else {
                    color = pendingColor;
                }
                progressStyle.addProgressSegment(
                        new NotificationCompat.ProgressStyle.Segment(100).setColor(color));
            }

            builder.setStyle(progressStyle);
            builder.setSubText(completed + "/" + total);
        } catch (Exception e) {
            buildFallbackProgressNotification(builder, total, completed);
        }
    }

    private void buildFallbackProgressNotification(NotificationCompat.Builder builder,
            int total, int completed) {
        // Pre-API-36 fallback: just a determinate bar — no extra body wall.
        builder.setProgress(total, completed, false);
        builder.setSubText(completed + "/" + total);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST) return;

        ValueCallback<Uri[]> cb = pendingFileChooserCallback;
        pendingFileChooserCallback = null;
        if (cb == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        cb.onReceiveValue(results);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            String result = (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED)
                    ? "granted" : "denied";
            webView.evaluateJavascript(
                    "if(window._onNativePermissionResult) window._onNativePermissionResult('" + result + "');",
                    null);
        }
    }

    // ── Update check ──

    private void checkForApkUpdate() {
        String currentVersion;
        try {
            currentVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return;
        }

        final String cv = currentVersion;
        new Thread(() -> {
            try {
                String apiUrl = serverUrl + "/api/android-apk-update?currentVersion=" +
                        java.net.URLEncoder.encode(cv, "UTF-8");
                URL url = new URL(apiUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                trustSelfSigned(conn);

                // Forward session cookie
                String cookie = CookieManager.getInstance().getCookie(serverUrl);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);

                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setRequestMethod("GET");

                int code = conn.getResponseCode();
                if (code != 200) {
                    conn.disconnect();
                    return;
                }

                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();
                conn.disconnect();

                JSONObject data = new JSONObject(sb.toString());
                if (!data.optBoolean("updateAvailable", false)) return;

                String latestVersion = data.optString("latestVersion", "");
                String downloadUrl = data.optString("downloadUrl", "");
                String fileName = data.optString("fileName", "wand-update.apk");
                long size = data.optLong("size", 0);
                String source = data.optString("source", "");

                if (latestVersion.isEmpty() || downloadUrl.isEmpty()) return;

                ServerStore store = new ServerStore(MainActivity.this);
                if (latestVersion.equals(store.getSkippedVersion())) return;
                if (latestVersion.equals(store.getDownloadedApkVersion())) return;

                runOnUiThread(() -> {
                    new NotificationBridge().sendNotification(
                            "Wand 发现新版本",
                            "当前 " + cv + " → 最新 " + latestVersion,
                            "update:wand-update");
                    showUpdateDialog(cv, latestVersion, downloadUrl, fileName, size, source);
                });

            } catch (Exception e) {
                // Silently ignore update check failures
            }
        }).start();
    }

    @SuppressLint("DefaultLocale")
    private void showUpdateDialog(String currentVer, String latestVer,
                                  String downloadUrl, String fileName, long size, String source) {
        String sizeText = size > 0 ? "\n文件大小: " + formatSize(size) : "";
        String sourceText = "github".equals(source) ? "\n来源: GitHub Release" : "";

        new MaterialAlertDialogBuilder(this, R.style.Theme_Wand_Dialog)
                .setTitle(R.string.update_title)
                .setMessage("当前版本: " + currentVer + "\n最新版本: " + latestVer + sizeText + sourceText)
                .setPositiveButton(R.string.update_now, (dialog, which) ->
                        downloadAndInstall(downloadUrl, fileName, source, latestVer))
                .setNegativeButton(R.string.remind_later, null)
                .setNeutralButton(R.string.skip_version, (dialog, which) ->
                        new ServerStore(this).setSkippedVersion(latestVer))
                .setCancelable(true)
                .show();
    }

    private void downloadAndInstall(String downloadUrl, String fileName, String source, String latestVersion) {
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            Toast.makeText(this, "下载地址为空", Toast.LENGTH_LONG).show();
            return;
        }
        if (fileName == null || fileName.isEmpty()) {
            fileName = "wand-update.apk";
        }
        final String safeFileName = fileName;

        // Inflate custom progress dialog (replaces deprecated ProgressDialog)
        View progressView = getLayoutInflater().inflate(R.layout.dialog_download_progress, null);
        final ProgressBar progressBar = progressView.findViewById(R.id.progressBar);
        final TextView progressPercent = progressView.findViewById(R.id.progressPercent);
        final TextView progressBytes = progressView.findViewById(R.id.progressBytes);

        final AlertDialog progress = new MaterialAlertDialogBuilder(this, R.style.Theme_Wand_Dialog)
                .setView(progressView)
                .setCancelable(false)
                .create();
        progress.show();

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                String fullUrl;
                if (downloadUrl.startsWith("http")) {
                    fullUrl = downloadUrl;
                } else {
                    fullUrl = serverUrl + downloadUrl;
                }

                URL url = new URL(fullUrl);
                conn = (HttpURLConnection) url.openConnection();
                trustSelfSigned(conn);

                // Forward cookies for local downloads
                if (!downloadUrl.startsWith("http")) {
                    String cookie = CookieManager.getInstance().getCookie(serverUrl);
                    if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                }

                conn.setConnectTimeout(15000);
                conn.setReadTimeout(120000);
                conn.setInstanceFollowRedirects(true);

                int responseCode = conn.getResponseCode();
                // Handle redirect (301/302)
                if (responseCode == 302 || responseCode == 301) {
                    String redirectUrl = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (redirectUrl != null) {
                        url = new URL(redirectUrl);
                        conn = (HttpURLConnection) url.openConnection();
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(120000);
                        conn.setInstanceFollowRedirects(true);
                        responseCode = conn.getResponseCode();
                    }
                }

                if (responseCode != 200) {
                    throw new Exception("服务器返回 " + responseCode);
                }

                int fileLength = conn.getContentLength();
                File outputFile = new File(getExternalFilesDir(null), safeFileName);

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(outputFile)) {
                    byte[] buffer = new byte[8192];
                    long total = 0;
                    int count;
                    long lastUiUpdate = 0;
                    while ((count = in.read(buffer)) != -1) {
                        total += count;
                        out.write(buffer, 0, count);
                        long now = System.currentTimeMillis();
                        // Throttle UI updates to ~50ms
                        if (now - lastUiUpdate > 50 || total == fileLength) {
                            lastUiUpdate = now;
                            final long totalSnap = total;
                            final int totalLen = fileLength;
                            runOnUiThread(() -> {
                                if (totalLen > 0) {
                                    int percent = (int) (totalSnap * 100 / totalLen);
                                    progressBar.setProgress(percent);
                                    progressPercent.setText(percent + "%");
                                    progressBytes.setText(formatSize(totalSnap) + " / " + formatSize(totalLen));
                                } else {
                                    progressBar.setIndeterminate(true);
                                    progressBytes.setText(formatSize(totalSnap));
                                }
                            });
                        }
                    }
                }

                if (!outputFile.exists() || outputFile.length() == 0) {
                    throw new Exception("下载文件为空");
                }

                if (latestVersion != null) {
                    new ServerStore(MainActivity.this).setDownloadedApkVersion(latestVersion);
                }

                runOnUiThread(() -> {
                    progress.dismiss();
                    installApk(outputFile);
                });

            } catch (Exception e) {
                final String errMsg = e.getMessage() != null ? e.getMessage() : "未知错误";
                runOnUiThread(() -> {
                    progress.dismiss();
                    new MaterialAlertDialogBuilder(MainActivity.this, R.style.Theme_Wand_Dialog)
                        .setTitle("下载失败")
                        .setMessage(errMsg)
                        .setPositiveButton(android.R.string.ok, null)
                        .show();
                });
            } finally {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
            }
        }).start();
    }

    private void installApk(File apkFile) {
        try {
            Uri apkUri = FileProvider.getUriForFile(this,
                    getPackageName() + ".fileprovider", apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            new MaterialAlertDialogBuilder(this, R.style.Theme_Wand_Dialog)
                .setTitle("安装失败")
                .setMessage(e.getMessage())
                .setPositiveButton(android.R.string.ok, null)
                .show();
        }
    }

    private static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
    }

    // ── SSL helper ──

    private void trustSelfSigned(HttpURLConnection conn) throws Exception {
        if (conn instanceof HttpsURLConnection) {
            HttpsURLConnection httpsConn = (HttpsURLConnection) conn;
            TrustManager[] trustAll = new TrustManager[]{
                new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    public void checkClientTrusted(X509Certificate[] certs, String authType) {}
                    public void checkServerTrusted(X509Certificate[] certs, String authType) {}
                }
            };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, trustAll, new SecureRandom());
            httpsConn.setSSLSocketFactory(sc.getSocketFactory());
            httpsConn.setHostnameVerifier((hostname, session) -> true);
        }
    }

    // ── Lifecycle ──

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        if (errorOverlay.getVisibility() == View.VISIBLE) {
            hideError();
            webView.reload();
            return;
        }
        // Notify the page that the host activity just resumed. The page's
        // visibilitychange / focus / pageshow listeners are unreliable on
        // Android after Doze or long backgrounding (Chromium may suspend
        // the renderer entirely), so we drive a deterministic foreground
        // sync from native. The handler in scripts.js force-reconnects the
        // WebSocket and force-refits the terminal grid.
        // Posted to the WebView's own thread to avoid running JS while the
        // view is still mid-resume.
        webView.post(() -> {
            try {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('wand-android-resume'));",
                    null
                );
            } catch (Exception ignored) {}
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onDestroy() {
        if (keepAliveRunning) {
            try { stopService(new Intent(this, WandForegroundService.class)); } catch (Exception ignored) {}
            keepAliveRunning = false;
        }
        NotificationManagerCompat nm = NotificationManagerCompat.from(this);
        for (String sessionId : progressUpdateTimestamps.keySet()) {
            nm.cancel("progress:" + sessionId, 0);
        }
        progressUpdateTimestamps.clear();
        pendingProgressUpdates.clear();
        mainHandler.removeCallbacksAndMessages(null);
        webView.destroy();
        super.onDestroy();
    }

    private void showError(String message) {
        errorMessage.setText(message);
        errorOverlay.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        // 错误页比 loading 优先, 把 loading 立刻 gone 掉 (不淡出 — 避免和
        // errorOverlay 同时可见时 alpha 透出后面的 WebView 错误状态)。
        if (loadingOverlay != null && loadingOverlay.getVisibility() == View.VISIBLE) {
            loadingOverlay.animate().cancel();
            loadingOverlay.setAlpha(1f);
            loadingOverlay.setVisibility(View.GONE);
        }
    }

    private void hideError() {
        errorOverlay.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    /**
     * 把启动 loading overlay 淡出并 gone 掉。idempotent — onPageFinished 可能
     * 被多次触发 (重定向 / hash 变更 / SPA 路由), 第二次以后这里直接 no-op。
     */
    private void hideLoadingOverlay() {
        if (loadingOverlay == null) return;
        if (loadingOverlay.getVisibility() != View.VISIBLE) return;
        loadingOverlay.animate()
                .alpha(0f)
                .setDuration(220)
                .withEndAction(() -> {
                    if (loadingOverlay != null) {
                        loadingOverlay.setVisibility(View.GONE);
                    }
                })
                .start();
    }

    /**
     * 系统内存吃紧时通知 WebView 内的页面释放可丢弃的缓存 (大图缓存 /
     * 不活跃会话的 terminal scrollback 等)。页面侧可选地实现
     * window.wandTrimCache(level) — 没有实现也无害, evaluateJavascript
     * 静默忽略。同时调 WebView 自己的 trim 让 Chromium 也回收一些字节码。
     */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (webView == null) return;
        try {
            if (level >= TRIM_MEMORY_RUNNING_LOW) {
                webView.evaluateJavascript(
                        "(function(){try{if(window.wandTrimCache)window.wandTrimCache(" + level + ");}catch(e){}})();",
                        null);
            }
            if (level >= TRIM_MEMORY_UI_HIDDEN) {
                // UI 在后台 + 系统压力中等以上, 让 Chromium 释放渲染缓存。
                // freeMemory 是历史 API, 但仍然是触发 Chromium 主动 GC 最直接
                // 的 hook (即使官方标 deprecated, AOSP 内部仍会做 trim)。
                webView.freeMemory();
            }
        } catch (Exception ignored) {}
    }

    // 跟踪软键盘 (IME) 当前是否处于动画 / 已展开状态。WindowInsetsAnimation
    // 在动画期间会一帧一帧 dispatch 中间 inset, 我们用 lastDispatchedImeBottom
    // 缓存最近一次写到 padding 上的 IME 高度, 防止动画结束时静态 listener 又
    // 重复覆盖一次 padding 导致跳变。
    private boolean imeAnimating = false;
    private int lastSysBarTopPx = 0;
    private int lastSysBarBottomPx = 0;
    private int lastSysBarLeftPx = 0;
    private int lastSysBarRightPx = 0;
    private int lastImeBottomPx = 0;

    /**
     * 用 Android 原生 WindowInsets 把整个 activity 内容根 (含 WebView + 错误
     * overlay) 朝里缩 — 这是 Google 在 targetSdk >= 35 强制边到边渲染时推荐
     * 的标准做法, 完全在 APK 层处理, 不依赖任何 CSS / JS。
     *
     * 处理三类 inset:
     *   1. 静态系统栏 (status bar / navigation bar / display cutout) —
     *      永远 padding 在内容根上, 页面顶/底自然贴系统栏沿。
     *   2. IME (软键盘) — 静态 listener 处理"不带动画"的情况 (如旋转后
     *      键盘已经在屏上、分屏直接出现键盘等), 把键盘高度同样 padding
     *      在底部, WebView 收缩, 网页 input-panel 自动上浮。
     *   3. IME 动画 — WindowInsetsAnimationCompat.Callback 在键盘 slide-in /
     *      slide-out 的每一帧 dispatch 中间 inset, 我们每帧更新 padding,
     *      WebView 跟着键盘动画平滑 resize, 不会有"先卡住再啪嗒"的跳变。
     *
     * CONSUMED 不需要返回, 因为我们用 Builder 归零自己消费过的部分, 子 view
     * 仍可拿到 IME inset 用于 visualViewport 等 (虽然现在已经不依赖它)。
     */
    private void installWindowInsetsBridge() {
        // 装在 android.R.id.content 而不是 WebView 上, 这样 WebView + errorOverlay
        // (它们是同一个 FrameLayout 的子 view) 一起被父容器的 padding 顶下去。
        View root = findViewById(android.R.id.content);
        if (root == null) return;

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insetsCompat) -> {
            Insets bars = insetsCompat.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = insetsCompat.getInsets(WindowInsetsCompat.Type.ime());

            // 缓存静态系统栏值, 后续 IME 动画进度回调会用它做基线。
            lastSysBarTopPx = bars.top;
            lastSysBarBottomPx = bars.bottom;
            lastSysBarLeftPx = bars.left;
            lastSysBarRightPx = bars.right;

            // 动画期间不在这里碰 padding — 让 onProgress 一帧一帧推。
            if (!imeAnimating) {
                lastImeBottomPx = ime.bottom;
                applyInsetPadding(v);
            }

            // 旋转 / 分屏 / 重连等场景下重新 dispatch 时, marker 类补一次。
            injectNativeInsetsMarker();

            // 把消费过的部分归零返回 (IME 仍保留, 给可能的下游观察者)。
            return new WindowInsetsCompat.Builder(insetsCompat)
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.NONE)
                .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .build();
        });

        // 软键盘动画回调: 跟随 Android 原生 IME 的 slide-in / slide-out 节奏
        // 一帧一帧地更新 padding, WebView 跟键盘同步移动, 无跳变。
        ViewCompat.setWindowInsetsAnimationCallback(root, new WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {

            @Override
            public void onPrepare(WindowInsetsAnimationCompat animation) {
                if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                    imeAnimating = true;
                }
            }

            @Override
            public WindowInsetsCompat onProgress(WindowInsetsCompat insets,
                                                 java.util.List<WindowInsetsAnimationCompat> running) {
                Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                lastImeBottomPx = ime.bottom;
                applyInsetPadding(root);
                return insets;
            }

            @Override
            public void onEnd(WindowInsetsAnimationCompat animation) {
                if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                    imeAnimating = false;
                    // 动画收尾时, 用 root 当前最新 inset 校准一次, 避免和
                    // 系统的最终值差 1 像素引起的细微抖动。
                    applyInsetPadding(root);
                }
            }
        });

        ViewCompat.requestApplyInsets(root);
    }

    /**
     * Apply the cached system-bar + IME padding to the content root.
     * Pulled out so both the static listener and the animation callback can
     * use the same logic.
     */
    private void applyInsetPadding(View v) {
        int bottom = Math.max(lastSysBarBottomPx, lastImeBottomPx);
        v.setPadding(lastSysBarLeftPx, lastSysBarTopPx, lastSysBarRightPx, bottom);

        // 更新 dp 缓存, 仅供调试 / 旧逻辑兜底用。
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) density = 1f;
        lastInsetTopDp = lastSysBarTopPx / density;
        lastInsetBottomDp = bottom / density;
        lastInsetLeftDp = lastSysBarLeftPx / density;
        lastInsetRightDp = lastSysBarRightPx / density;
    }

    /**
     * 让状态栏 / 导航栏的图标颜色匹配它们各自的背景:
     *   - statusBarColor = primary_dark (深棕) -> 图标要亮 (light icons = false)
     *   - navigationBarColor = background (奶油) -> 图标要暗 (light icons = true)
     * 否则会出现 "深底深字" / "浅底浅字" 的视觉冲突。
     */
    private void applySystemBarAppearance() {
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller == null) return;
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(true);
    }

    /**
     * 告诉页面 CSS "我已经在原生层处理了系统栏 inset"。CSS 看到这个类后会
     * 关掉 .is-wand-app 上的 32px 兜底, 因为再加 padding 就重复了。
     * --app-inset-* 显式置 0, 同样目的是抵消任何旧版 CSS 残留。
     */
    private void injectNativeInsetsMarker() {
        if (webView == null) return;
        String js =
            "(function(){try{" +
                "var r=document.documentElement;" +
                "r.classList.add('is-wand-app-native-insets');" +
                "r.style.setProperty('--app-inset-top','0px');" +
                "r.style.setProperty('--app-inset-bottom','0px');" +
                "r.style.setProperty('--app-inset-left','0px');" +
                "r.style.setProperty('--app-inset-right','0px');" +
            "}catch(e){}})();";
        try {
            webView.evaluateJavascript(js, null);
        } catch (Exception ignored) {}
    }
}
