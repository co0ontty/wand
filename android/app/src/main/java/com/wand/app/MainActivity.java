package com.wand.app;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.media.AudioManager;
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
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity implements NetworkMonitor.Listener {

    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final int FILE_CHOOSER_REQUEST = 1002;

    private WebView webView;
    private LinearLayout errorOverlay;
    private LinearLayout loadingOverlay;
    private TextView errorMessage;
    private String serverUrl;
    private String appToken;
    private boolean hasLoadedPage = false;
    private boolean updateCheckDone = false;
    private boolean lastLoadFailed = false;
    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private boolean keepAliveRunning = false;
    private long lastBackPressedTime = 0;
    private ExecutorService backgroundExecutor;

    private ServerStore serverStore;
    private NotificationHelper notificationHelper;
    private UpdateManager updateManager;
    private NetworkMonitor networkMonitor;

    // IME 动画跟踪
    private boolean imeAnimating = false;
    private int lastSysBarTopPx = 0;
    private int lastSysBarBottomPx = 0;
    private int lastSysBarLeftPx = 0;
    private int lastSysBarRightPx = 0;
    private int lastImeBottomPx = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        applySystemBarAppearance();

        serverUrl = getIntent().getStringExtra("server_url");
        appToken = getIntent().getStringExtra("app_token");
        if (serverUrl == null || serverUrl.isEmpty()) {
            finish();
            return;
        }

        serverStore = new ServerStore(this);
        notificationHelper = new NotificationHelper(this);
        backgroundExecutor = Executors.newFixedThreadPool(2);
        updateManager = new UpdateManager(this, serverStore, backgroundExecutor, serverUrl);
        networkMonitor = new NetworkMonitor(this, this);

        webView = findViewById(R.id.webView);
        errorOverlay = findViewById(R.id.errorOverlay);
        loadingOverlay = findViewById(R.id.loadingOverlay);
        errorMessage = findViewById(R.id.errorMessage);

        findViewById(R.id.retryButton).setOnClickListener(v -> {
            hideError();
            webView.loadUrl(serverUrl);
        });
        findViewById(R.id.backToConnectButton).setOnClickListener(v -> openConnectScreen());

        setVolumeControlStream(AudioManager.STREAM_NOTIFICATION);

        notificationHelper.createChannels();
        setupWebView();
        networkMonitor.register();
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

    // ── NetworkMonitor.Listener ──

    @Override
    public void onNetworkStateChanged(String state) {
        runOnUiThread(() -> {
            if (webView == null) return;
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

    // ── Navigation ──

    private void openConnectScreen() {
        Intent connectIntent = new Intent(this, ConnectActivity.class);
        connectIntent.putExtra("skip_auto_connect", true);
        connectIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(connectIntent);
        finish();
    }

    // ── WebView setup ──

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

        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.background));
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.OFF_SCREEN_PRERASTER)) {
            WebSettingsCompat.setOffscreenPreRaster(settings, true);
        }

        String versionName = "1.0";
        try {
            versionName = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {}
        settings.setUserAgentString(settings.getUserAgentString()
                + " WandApp/" + versionName + " WandPlatform/Android");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        installWindowInsetsBridge();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                lastLoadFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hasLoadedPage = true;
                if (lastLoadFailed) return;
                hideError();
                hideLoadingOverlay();
                injectNativeInsetsMarker();
                if (!updateCheckDone) {
                    updateCheckDone = true;
                    updateManager.checkForUpdate((cv, lv, dl, fn, sz, src, notes) -> {
                        notificationHelper.sendNotification(
                                "Wand 发现新版本",
                                "当前 " + cv + " → 最新 " + lv,
                                "update:wand-update",
                                buildSelfPendingIntent(0), serverStore);
                        updateManager.showUpdateDialog(cv, lv, dl, fn, sz, src, notes);
                    });
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    lastLoadFailed = true;
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
                            msgRes = networkMonitor.hasUsableNetwork()
                                    ? R.string.connection_failed : R.string.error_no_network;
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
                if (url.startsWith(serverUrl)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                try {
                    android.view.ViewGroup parent = (android.view.ViewGroup) view.getParent();
                    if (parent != null) parent.removeView(view);
                    view.destroy();
                    webView = new WebView(MainActivity.this);
                    webView.setLayoutParams(new android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT));
                    if (parent != null) parent.addView(webView, 0);
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

        webView.addJavascriptInterface(new NativeBridge(), "WandNative");
    }

    // ── PendingIntent factory ──

    PendingIntent buildSelfPendingIntent(int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("server_url", serverUrl);
        if (appToken != null) intent.putExtra("app_token", appToken);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ── JS bridge ──

    private class NativeBridge {

        @JavascriptInterface
        public void switchServer() {
            runOnUiThread(MainActivity.this::openConnectScreen);
        }

        @JavascriptInterface
        public String getPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
            int result = ContextCompat.checkSelfPermission(
                    MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS);
            if (result == PackageManager.PERMISSION_GRANTED) return "granted";
            if (ActivityCompat.shouldShowRequestPermissionRationale(
                    MainActivity.this, android.Manifest.permission.POST_NOTIFICATIONS))
                return "denied";
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
            return serverStore.getAppIcon();
        }

        @JavascriptInterface
        public void setAppIcon(String iconName) {
            if (!"shorthair".equals(iconName) && !"garfield".equals(iconName)) return;
            if (iconName.equals(serverStore.getAppIcon())) return;
            serverStore.setAppIcon(iconName);

            PackageManager pm = getPackageManager();
            String pkg = getPackageName();
            ComponentName shorthairAlias = new ComponentName(pkg, pkg + ".ConnectActivity.Shorthair");
            ComponentName garfieldAlias = new ComponentName(pkg, pkg + ".ConnectActivity.Garfield");

            if ("garfield".equals(iconName)) {
                pm.setComponentEnabledSetting(shorthairAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(garfieldAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
            } else {
                pm.setComponentEnabledSetting(garfieldAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(shorthairAlias,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
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
            runOnUiThread(() -> updateManager.downloadAndInstall(url, fileName, source, null));
        }

        @JavascriptInterface
        public void sendNotification(String title, String body, String tag) {
            int requestCode = (tag != null ? tag.hashCode() : 0) & 0x7FFFFFFF;
            notificationHelper.sendNotification(title, body, tag,
                    buildSelfPendingIntent(requestCode), serverStore);
        }

        @JavascriptInterface
        public String getNotificationSound() {
            return serverStore.getNotificationSound();
        }

        @JavascriptInterface
        public void setNotificationSound(String name) {
            if (!NotificationHelper.isValidSound(name)) return;
            serverStore.setNotificationSound(name);
        }

        @JavascriptInterface
        public String getAvailableSounds() {
            try {
                JSONArray arr = new JSONArray();
                for (String[] preset : NotificationHelper.SOUND_PRESETS) {
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
            return serverStore.getNotificationVolume();
        }

        @JavascriptInterface
        public void setNotificationVolume(int volume) {
            serverStore.setNotificationVolume(volume);
        }

        @JavascriptInterface
        public void previewSound(String name) {
            if (!NotificationHelper.isValidSound(name)) return;
            runOnUiThread(() -> {
                if (notificationHelper.isSystemMuted()) {
                    Toast.makeText(MainActivity.this,
                            "系统已静音/振动模式，无法预览声音",
                            Toast.LENGTH_SHORT).show();
                    return;
                }
                notificationHelper.playPresetSound(name,
                        serverStore.getNotificationVolume() / 100f);
            });
        }

        @JavascriptInterface
        public void updateSessionProgress(String sessionId, String jsonData) {
            int requestCode = ("progress:" + sessionId).hashCode() & 0x7FFFFFFF;
            notificationHelper.updateSessionProgress(sessionId, jsonData,
                    buildSelfPendingIntent(requestCode));
        }

        @JavascriptInterface
        public void clearSessionProgress(String sessionId) {
            notificationHelper.clearSessionProgress(sessionId);
        }

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

        @JavascriptInterface
        public void vibrate(String pattern) {
            if (!serverStore.isHapticEnabled()) return;
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
                        case "medium": vibrator.vibrate(30); break;
                        case "success": vibrator.vibrate(new long[]{0, 10, 80, 10}, -1); break;
                        case "error": vibrator.vibrate(new long[]{0, 30, 60, 30, 60, 30}, -1); break;
                        case "light":
                        default: vibrator.vibrate(10); break;
                    }
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public boolean isHapticEnabled() {
            return serverStore.isHapticEnabled();
        }

        @JavascriptInterface
        public void setHapticEnabled(boolean enabled) {
            serverStore.setHapticEnabled(enabled);
        }
    }

    // ── Activity results & permissions ──

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (updateManager.handleActivityResult(requestCode)) return;

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
        webView.post(() -> {
            try {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('wand-android-resume'));", null);
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
        networkMonitor.unregister();
        if (backgroundExecutor != null) {
            backgroundExecutor.shutdownNow();
            backgroundExecutor = null;
        }
        notificationHelper.cancelAllProgress();
        webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (webView == null) return;
        if (level >= TRIM_MEMORY_RUNNING_LOW) {
            evalJs("if(window.wandTrimCache)window.wandTrimCache(" + level + ");");
        }
        if (level >= TRIM_MEMORY_UI_HIDDEN) {
            try { webView.freeMemory(); } catch (Exception ignored) {}
        }
    }

    // ── Error/loading overlay ──

    private void showError(String message) {
        errorMessage.setText(message);
        errorOverlay.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
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

    private void hideLoadingOverlay() {
        if (loadingOverlay == null || loadingOverlay.getVisibility() != View.VISIBLE) return;
        loadingOverlay.animate()
                .alpha(0f)
                .setDuration(220)
                .withEndAction(() -> {
                    if (loadingOverlay != null) loadingOverlay.setVisibility(View.GONE);
                })
                .start();
    }

    // ── Window insets (edge-to-edge + IME) ──

    private void installWindowInsetsBridge() {
        View root = findViewById(android.R.id.content);
        if (root == null) return;

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insetsCompat) -> {
            Insets bars = insetsCompat.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insetsCompat.getInsets(WindowInsetsCompat.Type.ime());

            lastSysBarTopPx = bars.top;
            lastSysBarBottomPx = bars.bottom;
            lastSysBarLeftPx = bars.left;
            lastSysBarRightPx = bars.right;

            if (!imeAnimating) {
                lastImeBottomPx = ime.bottom;
                applyInsetPadding(v);
            }

            injectNativeInsetsMarker();

            return new WindowInsetsCompat.Builder(insetsCompat)
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.NONE)
                .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .build();
        });

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
                    applyInsetPadding(root);
                    dispatchImeState(lastImeBottomPx > 0 ? "shown" : "hidden");
                }
            }
        });

        ViewCompat.requestApplyInsets(root);
    }

    private void applyInsetPadding(View v) {
        int bottom = Math.max(lastSysBarBottomPx, lastImeBottomPx);
        v.setPadding(lastSysBarLeftPx, lastSysBarTopPx, lastSysBarRightPx, bottom);
    }

    private void dispatchImeState(String state) {
        runOnUiThread(() -> {
            if (webView == null) return;
            String safe = state == null ? "" : state.replace("'", "");
            evalJs("window.__wandImeNative=true;"
                    + "window.dispatchEvent(new CustomEvent('wand-ime-state',"
                    + "{detail:{state:'" + safe + "'}}));");
        });
    }

    // ── System bar appearance ──

    private void applySystemBarAppearance() {
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller == null) return;
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(true);
    }

    private void injectNativeInsetsMarker() {
        evalJs(
            "var r=document.documentElement;" +
            "r.classList.add('is-wand-app-native-insets');" +
            "r.style.setProperty('--app-inset-top','0px');" +
            "r.style.setProperty('--app-inset-bottom','0px');" +
            "r.style.setProperty('--app-inset-left','0px');" +
            "r.style.setProperty('--app-inset-right','0px');");
    }

    // ── JS eval helper ──

    private void evalJs(String innerBody) {
        if (webView == null) return;
        try {
            webView.evaluateJavascript("(function(){try{" + innerBody + "}catch(e){}})();", null);
        } catch (Exception ignored) {}
    }
}
