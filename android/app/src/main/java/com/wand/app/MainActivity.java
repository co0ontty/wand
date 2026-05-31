package com.wand.app;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.nio.charset.StandardCharsets;

public class MainActivity extends AppCompatActivity {

    private static final String CHANNEL_ID_SILENT = "wand_notif_silent";
    private static final String CHANNEL_ID_TASKS = "wand_notif_tasks";
    private static final String CHANNEL_ID_UPDATES = "wand_notif_updates";
    private static final String CHANNEL_ID_PROGRESS = "wand_notif_progress";
    private static final String CHANNEL_ID_PREFIX_LEGACY = "wand_notif_";
    private static final String CHANNEL_ID_LEGACY = "wand_notifications";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final int FILE_CHOOSER_REQUEST = 1002;
    private static final int INSTALL_PERMISSION_REQUEST = 1003;
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
    // 当前正在加载 (或刚加载完) 的页面是否在 onReceivedError 里翻车。
    // WebView 在主框架加载失败时会先 dispatch onReceivedError, 然后 *再*
    // 把它自己合成的"网页无法打开"错误页喂给 onPageFinished — 如果在
    // onPageFinished 里无脑 hideError(), 就会把刚弹出的自定义错误层撤掉,
    // 让用户看到 Chromium 系统错误页。用这个 flag 在 onPageStarted 时重置、
    // 在 onReceivedError 时置位, onPageFinished 据此决定是否真的清错误层。
    private boolean lastLoadFailed = false;
    private int notificationCounter = 0;
    private final Map<String, Long> progressUpdateTimestamps = new HashMap<>();
    private final Map<String, Runnable> pendingProgressUpdates = new HashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> pendingFileChooserCallback;
    // 待安装的 APK — 未知来源安装权限缺失时引导用户授权, 授权返回后继续安装。
    private File pendingInstallFile;
    private boolean keepAliveRunning = false;
    private long lastBackPressedTime = 0;

    // ConnectivityManager 监听: 切 Wi-Fi/4G、Doze 恢复网络、机场模式开关等
    // 场景下, JS 的 navigator.onLine / visibilitychange 都不够灵敏 (尤其
    // 在前台没有 lifecycle 变化时, 唯一信号源就是这里)。我们把网络变化
    // 桥到 WebView, JS 侧立刻 forceReconnectWebSocket, 不再等 8s backoff。
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean hasUsableNetwork = true;

    // 后台任务 (update check, APK 下载) 用 executor 而不是裸 Thread, 这样
    // Activity 切换 / WebView render 进程崩溃重建时, onDestroy 可以
    // shutdownNow 中断未完成的下载 — 之前 raw Thread 会跑完整个下载流程,
    // 然后在已 finish 的 Activity 上 runOnUiThread 弹 dialog 触发崩溃。
    private ExecutorService backgroundExecutor;

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

        backButton.setOnClickListener(v -> openConnectScreen());

        // Volume keys in this activity should adjust the notification stream,
        // so users see the "Notification volume" slider when they press volume
        // buttons — and lowering it to 0 actually mutes our notification sounds.
        // (Default for activities is STREAM_MUSIC, which is why volume keys
        // previously controlled media volume even though our sound routes to
        // STREAM_NOTIFICATION via AudioAttributes.)
        setVolumeControlStream(AudioManager.STREAM_NOTIFICATION);

        createNotificationChannels();
        setupWebView();
        registerNetworkCallback();
        // 2 个线程足够: 1 个 update check + 1 个 download 同时跑顶天了。
        backgroundExecutor = Executors.newFixedThreadPool(2);
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

    /**
     * 回到连接界面 (最近服务器列表)。供"返回连接"按钮和 JS 的 switchServer
     * 共用。带 skip_auto_connect 避免又被自动连回当前服务器。
     */
    private void openConnectScreen() {
        Intent connectIntent = new Intent(this, ConnectActivity.class);
        connectIntent.putExtra("skip_auto_connect", true);
        connectIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(connectIntent);
        finish();
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

        // 终端 / 控制台是等宽固定布局, 必须按 1.0 scale 渲染。一旦页面被缩放
        // (双指 pinch-zoom, 或 APK 刚启动、手指还没离屏时被识别成的多点触摸误触)
        // 就会缩成 75% 之类, 弹出系统缩放浮层、等宽行换行全乱。这里彻底关掉
        // WebView 缩放: setSupportZoom(false) 禁掉手势缩放, 另两项关掉内置 +/-
        // 控件。配合网页 viewport 的 maximum-scale=1 / user-scalable=no 双保险。
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

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
        settings.setUserAgentString(settings.getUserAgentString() + " WandApp/" + versionName + " WandPlatform/Android");

        // Enable cookies
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // Capture system-bar insets so we can inject them as CSS variables.
        // (See lastInsetTopDp comment above for why.)
        installWindowInsetsBridge();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // 每次新一轮主框架加载开始, 把"上一轮是否失败"的 flag 清零。
                // 这样 onPageFinished 在收尾时能区分: 这是一次成功加载 → 撤掉
                // 错误层 + loading overlay; 还是 Chromium 自己合成的错误页
                // finish 信号 → 保留错误层 (即任务一的核心修复点)。
                lastLoadFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hasLoadedPage = true;
                if (lastLoadFailed) {
                    // 主框架刚 onReceivedError 过 — 不要 hideError()!
                    // 否则 WebView 会把自己的"网页无法打开"系统错误页露出来,
                    // 完全盖掉我们刚 showError() 的自定义错误层。loading overlay
                    // showError() 里已经处理过, 这里也不重复 fade out。
                    return;
                }
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
                    // 标记当前加载已失败 — 紧跟着会进来的 onPageFinished 会读这个
                    // flag, 不去 hideError()。否则系统会用 Chromium 自带错误页盖掉
                    // 我们的自定义层 (Android WebView 任何主框架失败都会跟一发
                    // onPageFinished, 这是 Chromium 设计行为, 不是 bug)。
                    lastLoadFailed = true;
                    // 按错误类型给更具体的文案, 而非一律"连接失败"。
                    int msgRes;
                    switch (error.getErrorCode()) {
                        case ERROR_HOST_LOOKUP:
                            msgRes = R.string.error_host_lookup; break;
                        case ERROR_CONNECT:
                        case ERROR_IO:
                            msgRes = R.string.error_connect; break;
                        case ERROR_TIMEOUT:
                            msgRes = R.string.error_timeout; break;
                        default:
                            msgRes = hasUsableNetwork ? R.string.connection_failed : R.string.error_no_network;
                    }
                    showError(getString(msgRes));
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
        playPresetSound(store.getNotificationSound(), store.getNotificationVolume() / 100f);
    }

    /**
     * 按预设声音名 + 音量 (0~1) 播放一次通知音, 走 STREAM_NOTIFICATION 路由。
     * 音量 <= 0 或资源缺失时静默跳过; 播完自动 release。
     */
    private void playPresetSound(String soundName, float vol) {
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

    /** 校验声音名是否属于内置预设 (SOUND_PRESETS)。 */
    private static boolean isValidSound(String name) {
        for (String[] preset : SOUND_PRESETS) {
            if (preset[0].equals(name)) return true;
        }
        return false;
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

    /** Android 13+ 需运行时通知权限; 未授予返回 false (低版本恒为 true)。 */
    private boolean hasPostNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 构建"点击通知拉回 MainActivity"的 PendingIntent — 带 server_url / app_token,
     * SINGLE_TOP|CLEAR_TOP 复用现有实例而非新开。供普通通知和实时进度通知共用。
     */
    private PendingIntent buildSelfPendingIntent(int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("server_url", serverUrl);
        if (appToken != null) intent.putExtra("app_token", appToken);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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
            runOnUiThread(MainActivity.this::openConnectScreen);
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
            if (!hasPostNotificationPermission()) return;

            int requestCode = (tag != null ? tag.hashCode() : notificationCounter++) & 0x7FFFFFFF;
            PendingIntent pi = buildSelfPendingIntent(requestCode);

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
            if (!isValidSound(name)) return;
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
            if (!isValidSound(name)) return;
            runOnUiThread(() -> {
                if (isSystemMuted()) {
                    Toast.makeText(MainActivity.this,
                            "系统已静音/振动模式，无法预览声音",
                            Toast.LENGTH_SHORT).show();
                    return;
                }
                playPresetSound(name, new ServerStore(MainActivity.this).getNotificationVolume() / 100f);
            });
        }

        @JavascriptInterface
        public void updateSessionProgress(String sessionId, String jsonData) {
            if (sessionId == null || sessionId.isEmpty() || jsonData == null) return;
            if (!hasPostNotificationPermission()) return;
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

            int requestCode = ("progress:" + sessionId).hashCode() & 0x7FFFFFFF;
            PendingIntent pi = buildSelfPendingIntent(requestCode);

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
        if (requestCode == INSTALL_PERMISSION_REQUEST) {
            File toInstall = pendingInstallFile;
            pendingInstallFile = null;
            if (toInstall == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && getPackageManager().canRequestPackageInstalls()) {
                doInstallApk(toInstall);
            } else {
                Toast.makeText(this, R.string.install_permission_denied, Toast.LENGTH_LONG).show();
            }
            return;
        }
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
        if (backgroundExecutor == null || backgroundExecutor.isShutdown()) return;
        backgroundExecutor.execute(() -> {
            try {
                String apiUrl = serverUrl + "/api/android-apk-update?currentVersion=" +
                        java.net.URLEncoder.encode(cv, "UTF-8");
                URL url = new URL(apiUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                NetUtils.trustSelfSigned(conn);

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
                String releaseNotes = data.optString("releaseNotes", "");

                if (latestVersion.isEmpty() || downloadUrl.isEmpty()) return;

                ServerStore store = new ServerStore(MainActivity.this);
                if (latestVersion.equals(store.getSkippedVersion())) return;
                if (latestVersion.equals(store.getDownloadedApkVersion())) return;

                runOnUiThread(() -> {
                    new NotificationBridge().sendNotification(
                            "Wand 发现新版本",
                            "当前 " + cv + " → 最新 " + latestVersion,
                            "update:wand-update");
                    showUpdateDialog(cv, latestVersion, downloadUrl, fileName, size, source, releaseNotes);
                });

            } catch (Exception e) {
                // Silently ignore update check failures
            }
        });
    }

    @SuppressLint("DefaultLocale")
    private void showUpdateDialog(String currentVer, String latestVer,
                                  String downloadUrl, String fileName, long size, String source,
                                  String releaseNotes) {
        String sizeText = size > 0 ? "\n文件大小: " + formatSize(size) : "";
        String sourceText = "github".equals(source) ? "\n来源: GitHub Release" : "";
        String notesText = (releaseNotes != null && !releaseNotes.isEmpty())
                ? "\n\n更新内容:\n" + releaseNotes : "";

        new MaterialAlertDialogBuilder(this, R.style.Theme_Wand_Dialog)
                .setTitle(R.string.update_title)
                .setMessage("当前版本: " + currentVer + "\n最新版本: " + latestVer + sizeText + sourceText + notesText)
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

        // 允许用户主动取消下载: 弱网卡住时不必干等到 readTimeout(120s)。
        final boolean[] cancelled = {false};
        final AlertDialog progress = new MaterialAlertDialogBuilder(this, R.style.Theme_Wand_Dialog)
                .setView(progressView)
                .setNegativeButton(R.string.cancel_download, (d, w) -> cancelled[0] = true)
                .setCancelable(false)
                .create();
        progress.show();

        if (backgroundExecutor == null || backgroundExecutor.isShutdown()) {
            progress.dismiss();
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
            return;
        }
        backgroundExecutor.execute(() -> {
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
                NetUtils.trustSelfSigned(conn);

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

                // 下载前粗略校验可用空间 (预留 5MB), 避免写到一半 ENOSPC 抛不可读异常。
                if (fileLength > 0) {
                    File dir = outputFile.getParentFile();
                    long usable = dir != null ? dir.getUsableSpace() : Long.MAX_VALUE;
                    if (usable < (long) fileLength + 5 * 1024 * 1024) {
                        throw new Exception("存储空间不足，需要约 " + formatSize(fileLength) + "，请清理后重试");
                    }
                }

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(outputFile)) {
                    byte[] buffer = new byte[8192];
                    long total = 0;
                    int count;
                    long lastUiUpdate = 0;
                    final long startTime = System.currentTimeMillis();
                    while ((count = in.read(buffer)) != -1) {
                        if (cancelled[0]) break;
                        total += count;
                        out.write(buffer, 0, count);
                        long now = System.currentTimeMillis();
                        // Throttle UI updates to ~50ms
                        if (now - lastUiUpdate > 50 || total == fileLength) {
                            lastUiUpdate = now;
                            final long totalSnap = total;
                            final int totalLen = fileLength;
                            final long elapsed = Math.max(1, now - startTime);
                            final long bytesPerSec = totalSnap * 1000 / elapsed;
                            runOnUiThread(() -> {
                                String speedText = "  " + formatSize(bytesPerSec) + "/s";
                                if (totalLen > 0) {
                                    int percent = (int) (totalSnap * 100 / totalLen);
                                    progressBar.setIndeterminate(false);
                                    progressBar.setProgress(percent);
                                    progressPercent.setText(percent + "%");
                                    progressBytes.setText(formatSize(totalSnap) + " / " + formatSize(totalLen) + speedText);
                                } else {
                                    // Content-Length 缺失 (GitHub 重定向/分块传输常见): 明确告知"大小未知",
                                    // 避免停在"0% + 转圈"让用户误以为卡死。
                                    progressBar.setIndeterminate(true);
                                    progressPercent.setText("大小未知");
                                    progressBytes.setText(formatSize(totalSnap) + speedText);
                                }
                            });
                        }
                    }
                }

                if (cancelled[0]) {
                    // 用户主动取消: 删除半成品, 不弹失败框 (进度框已被取消按钮关闭)。
                    if (outputFile.exists()) {
                        try { outputFile.delete(); } catch (Exception ignored) {}
                    }
                    return;
                }

                if (!outputFile.exists() || outputFile.length() == 0) {
                    throw new Exception("下载文件为空");
                }

                // 记录已下载版本用于去重; 设置页下载路径 latestVersion 为 null 时从文件名解析,
                // 否则装完下次仍会重复弹"发现新版本"。
                String versionToRecord = latestVersion != null ? latestVersion : extractVersionFromFileName(safeFileName);
                if (versionToRecord != null) {
                    new ServerStore(MainActivity.this).setDownloadedApkVersion(versionToRecord);
                }

                runOnUiThread(() -> {
                    progress.dismiss();
                    installApk(outputFile);
                });

            } catch (Exception e) {
                if (cancelled[0]) return; // 取消引发的读异常, 不再提示
                final String errMsg = friendlyDownloadError(e);
                runOnUiThread(() -> {
                    progress.dismiss();
                    new MaterialAlertDialogBuilder(MainActivity.this, R.style.Theme_Wand_Dialog)
                        .setTitle("下载失败")
                        .setMessage(errMsg)
                        .setPositiveButton("重试", (d, w) ->
                                downloadAndInstall(downloadUrl, safeFileName, source, latestVersion))
                        .setNegativeButton(android.R.string.cancel, null)
                        .show();
                });
            } finally {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
            }
        });
    }

    private void installApk(File apkFile) {
        // Android 8+ 安装 APK 需要"未知来源"特殊权限。未授予时直接 ACTION_VIEW 会被系统
        // 静默拦下, 用户以为更新失败。这里先引导授权, 授权返回后在 onActivityResult 续装。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstallFile = apkFile;
            new MaterialAlertDialogBuilder(this, R.style.Theme_Wand_Dialog)
                .setTitle(R.string.install_permission_title)
                .setMessage(R.string.install_permission_message)
                .setPositiveButton(R.string.install_permission_goto, (d, w) -> requestInstallPermission())
                .setNegativeButton(android.R.string.cancel, (d, w) -> pendingInstallFile = null)
                .setCancelable(true)
                .show();
            return;
        }
        doInstallApk(apkFile);
    }

    private void requestInstallPermission() {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            startActivityForResult(intent, INSTALL_PERMISSION_REQUEST);
        } catch (Exception e) {
            // 个别 ROM 不支持该 action, 退回应用详情页。
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName()));
                startActivityForResult(fallback, INSTALL_PERMISSION_REQUEST);
            } catch (Exception ignored) {
                Toast.makeText(this, R.string.install_permission_failed, Toast.LENGTH_LONG).show();
            }
        }
    }

    private void doInstallApk(File apkFile) {
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

    private static String friendlyDownloadError(Exception e) {
        if (e instanceof java.net.SocketTimeoutException) return "下载超时，请检查网络后重试";
        if (e instanceof java.net.UnknownHostException) return "无法连接到下载服务器，请检查网络";
        if (e instanceof java.net.ConnectException) return "无法连接到下载服务器";
        String raw = e.getMessage() != null ? e.getMessage() : "";
        if (raw.contains("ENOSPC") || raw.toLowerCase().contains("space")) return "存储空间不足，请清理后重试";
        return raw.isEmpty() ? "下载失败，请稍后重试" : raw;
    }

    private static String extractVersionFromFileName(String fileName) {
        if (fileName == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?)").matcher(fileName);
        return m.find() ? m.group(1) : null;
    }

    private static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
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
        unregisterNetworkCallback();
        // 中断后台 update/download — 防止在 Activity 已 finish 之后, 后台
        // 线程跑完 download 又 runOnUiThread 弹 dialog 撞 IllegalStateException。
        if (backgroundExecutor != null) {
            backgroundExecutor.shutdownNow();
            backgroundExecutor = null;
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
        if (level >= TRIM_MEMORY_RUNNING_LOW) {
            evalJs("if(window.wandTrimCache)window.wandTrimCache(" + level + ");");
        }
        if (level >= TRIM_MEMORY_UI_HIDDEN) {
            // UI 在后台 + 系统压力中等以上, 让 Chromium 释放渲染缓存。
            // freeMemory 是历史 API, 但仍然是触发 Chromium 主动 GC 最直接
            // 的 hook (即使官方标 deprecated, AOSP 内部仍会做 trim)。
            try { webView.freeMemory(); } catch (Exception ignored) {}
        }
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
        //
        // 同时向 WebView 派发 'wand-ime-state' 事件 (state = "start" / "end"),
        // JS 侧 (setupVisualViewportHandlers) 检测到 APK 环境下 IME 由原生
        // padding 处理后, 会跳过专为 iOS Safari 写的 window.scrollTo(0,0)
        // 复位 hack — 那段 hack 在 Android 上会跟原生 setPadding 打架, 偶尔
        // 看到一帧抖。原生层全权接管后, JS 只负责终端 refit 这种纯展示活。
        ViewCompat.setWindowInsetsAnimationCallback(root, new WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {

            @Override
            public void onPrepare(WindowInsetsAnimationCompat animation) {
                if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                    imeAnimating = true;
                    dispatchImeState("start");
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
                    // 通知 JS 键盘动画收尾, 触发 terminal refit。lastImeBottomPx
                    // 在 onProgress 已经收尾到 0 (键盘收起) 或最终高度 (键盘展开),
                    // JS 直接读 visualViewport 即可。
                    dispatchImeState(lastImeBottomPx > 0 ? "shown" : "hidden");
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
     * 注册系统级网络回调, 把"网络可用"/"网络断开"/"网络容量变化" (Wi-Fi
     * → 4G、4G → Wi-Fi、机场模式切换、Doze 网络挂起恢复) 桥到 WebView。
     *
     * 收到 onAvailable 后, JS 端 dispatch 'wand-android-network' 事件,
     * 收 detail.state === "available" 时 forceReconnectWebSocket — 这比
     * 等 JS 的 navigator.onLine 或 visibilitychange 早 2-8 秒, 切网场景
     * 下用户基本感知不到断线。
     *
     * NetworkRequest 显式只关注 INTERNET 能力, 避免 VPN 拨上 / 断开等
     * 噪声触发误重连。监听 default network 即可, 多网卡设备 Android
     * 自己会路由。
     */
    private void registerNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return;
            // 启动时若已有 active network, 缓存初始状态。后续 onLost /
            // onAvailable 跟这个比较, 避免冗余 dispatch。
            android.net.Network active = cm.getActiveNetwork();
            hasUsableNetwork = (active != null);

            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    if (!hasUsableNetwork) {
                        hasUsableNetwork = true;
                        dispatchNetworkChange("available");
                    } else {
                        // 已有可用网络, 但换了一条 (Wi-Fi → 4G 等), socket
                        // 通常会因为 IP 变化而无声死亡。也强制重连一次。
                        dispatchNetworkChange("changed");
                    }
                }

                @Override
                public void onLost(Network network) {
                    // 仍可能有其他 network 兜底, 这里只做标记, 由 onAvailable
                    // 来决定是否真正触发重连; 同时通知 JS 进入降级 UI。
                    ConnectivityManager cm2 = (ConnectivityManager)
                            getSystemService(CONNECTIVITY_SERVICE);
                    android.net.Network nowActive = cm2 != null ? cm2.getActiveNetwork() : null;
                    if (nowActive == null) {
                        hasUsableNetwork = false;
                        dispatchNetworkChange("lost");
                    }
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    // 容量从无 INTERNET 跳到有 INTERNET (验证型 captive
                    // portal 通过、VPN 完成握手) 也走 available 路径。
                    if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                            && !hasUsableNetwork) {
                        hasUsableNetwork = true;
                        dispatchNetworkChange("validated");
                    }
                }
            };
            cm.registerNetworkCallback(request, networkCallback);
        } catch (Exception ignored) {
            // 极端 OEM ROM 可能拒绝注册, 这里失败不影响主流程 — JS 还有
            // navigator.onLine + 前台 resume 路径兜底。
        }
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) {}
        networkCallback = null;
    }

    /**
     * 通过 evaluateJavascript 派发自定义事件给页面。挑事件 + detail 是为了
     * 让 JS 侧用 addEventListener 自然消费, 不污染 window 全局命名空间。
     */
    private void dispatchNetworkChange(String state) {
        runOnUiThread(() -> {
            if (webView == null) return;
            // 错误页可见 + 网络恢复 → 自动重连, 省去用户手动点"重新连接"。
            if (("available".equals(state) || "validated".equals(state) || "changed".equals(state))
                    && errorOverlay != null && errorOverlay.getVisibility() == View.VISIBLE) {
                hideError();
                webView.reload();
                return;
            }
            String safe = state == null ? "" : state.replace("'", "");
            evalJs("window.dispatchEvent(new CustomEvent('wand-android-network',"
                    + "{detail:{state:'" + safe + "'}}));");
        });
    }

    /**
     * IME 动画状态桥。state 取值:
     *   "start"  — 键盘动画刚启动 (onPrepare)
     *   "shown"  — 键盘动画结束且已展开
     *   "hidden" — 键盘动画结束且已收起
     *
     * JS 侧用这个信号关掉 iOS Safari 专用的 window.scrollTo(0,0) 复位
     * hack — 那个 hack 在 Android 上会跟原生 padding 打架。同时把
     * window.__wandImeNative = true 立一面旗, JS 可以早 return。
     *
     * 标记是粘性的 (一旦收到 start 就永远视为"原生 IME 已接管"), 因为
     * 第一次开键盘前 JS 不知道我们存在; 只要触发过一次, 后续 IME 不动
     * 也算原生处理。
     */
    private void dispatchImeState(String state) {
        runOnUiThread(() -> {
            if (webView == null) return;
            String safe = state == null ? "" : state.replace("'", "");
            evalJs("window.__wandImeNative=true;"
                    + "window.dispatchEvent(new CustomEvent('wand-ime-state',"
                    + "{detail:{state:'" + safe + "'}}));");
        });
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
        evalJs(
            "var r=document.documentElement;" +
            "r.classList.add('is-wand-app-native-insets');" +
            "r.style.setProperty('--app-inset-top','0px');" +
            "r.style.setProperty('--app-inset-bottom','0px');" +
            "r.style.setProperty('--app-inset-left','0px');" +
            "r.style.setProperty('--app-inset-right','0px');");
    }

    /**
     * 在 WebView 里执行一段 JS, 自动套 (function(){try{...}catch(e){}})() 防御
     * 包裹 + webView null / 异常守卫。供各原生 → 页面事件桥共用。
     */
    private void evalJs(String innerBody) {
        if (webView == null) return;
        try {
            webView.evaluateJavascript("(function(){try{" + innerBody + "}catch(e){}})();", null);
        } catch (Exception ignored) {}
    }
}
