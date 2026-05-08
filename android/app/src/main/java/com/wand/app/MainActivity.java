package com.wand.app;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.ProgressDialog;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
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
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.google.android.material.button.MaterialButton;

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
    private static final long PROGRESS_UPDATE_DEBOUNCE_MS = 500;

    private static final String[][] SOUND_PRESETS = {
        {"chime",  "叮咚"},
        {"bubble", "气泡"},
        {"meow",   "喵~"},
        {"bell",   "铃声"},
    };

    private WebView webView;
    private LinearLayout errorOverlay;
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

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        serverUrl = getIntent().getStringExtra("server_url");
        appToken = getIntent().getStringExtra("app_token");
        if (serverUrl == null || serverUrl.isEmpty()) {
            finish();
            return;
        }

        webView = findViewById(R.id.webView);
        errorOverlay = findViewById(R.id.errorOverlay);
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

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                hasLoadedPage = true;
                hideError();
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
            .build();

    private void playNotificationSound() {
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
            String currentTask = data.optString("currentTask", "");
            String latestUserText = data.optString("latestUserText", "");
            String latestAssistantText = data.optString("latestAssistantText", "");
            JSONArray todosArray = data.optJSONArray("todos");

            int total = todosArray != null ? todosArray.length() : 0;
            int completed = 0;
            int inProgress = 0;
            String activeForm = "";

            if (todosArray != null) {
                for (int i = 0; i < todosArray.length(); i++) {
                    JSONObject todo = todosArray.getJSONObject(i);
                    String todoStatus = todo.optString("status", "pending");
                    if ("completed".equals(todoStatus)) {
                        completed++;
                    } else if ("in_progress".equals(todoStatus)) {
                        inProgress++;
                        if (activeForm.isEmpty()) {
                            activeForm = todo.optString("activeForm",
                                    todo.optString("content", ""));
                        }
                    }
                }
            }

            // Pick the most informative line for the secondary text. sessionLabel
            // is frozen to round-1's prompt (session.summary), so without falling
            // back to latestAssistantText / latestUserText the lock-screen card
            // would keep showing the very first message even after many turns.
            String contentText = pickFirstNonEmpty(
                    activeForm,
                    currentTask,
                    latestAssistantText,
                    latestUserText,
                    "运行中");

            // Title: keep sessionLabel as the anchor (round-1 summary), but if
            // the user has sent later prompts, prefix with "Q:" + latestUserText
            // so the OPPO Live Activity actually moves with the conversation.
            String displayTitle = sessionLabel;
            if (!latestUserText.isEmpty() && !latestUserText.equals(sessionLabel)) {
                displayTitle = latestUserText;
            }

            Intent intent = new Intent(this, MainActivity.class);
            intent.putExtra("server_url", serverUrl);
            if (appToken != null) intent.putExtra("app_token", appToken);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int requestCode = ("progress:" + sessionId).hashCode() & 0x7FFFFFFF;
            PendingIntent pi = PendingIntent.getActivity(this, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            boolean isOngoing = "running".equals(status) || "thinking".equals(status)
                    || "initializing".equals(status);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID_PROGRESS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(displayTitle)
                    .setContentText(contentText)
                    .setContentIntent(pi)
                    .setOngoing(isOngoing)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setAutoCancel(!isOngoing);

            // Subtext shows the session label so the user always sees which
            // session this is, even when the title now mirrors the latest prompt.
            if (!sessionLabel.isEmpty() && !sessionLabel.equals(displayTitle)) {
                builder.setSubText(sessionLabel);
            }

            if (Build.VERSION.SDK_INT >= 36 && total > 0) {
                buildProgressStyleNotification(builder, todosArray, total, completed, inProgress);
            } else if (total > 0) {
                buildFallbackProgressNotification(builder, total, completed, inProgress,
                        activeForm, currentTask, latestAssistantText, latestUserText);
            } else {
                String bigText = buildBigTextLines(contentText, latestAssistantText, latestUserText);
                builder.setStyle(new NotificationCompat.BigTextStyle().bigText(bigText));
            }

            if (total > 0) {
                builder.setShortCriticalText(completed + "/" + total);
            }
            if (isOngoing) {
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

    private static String buildBigTextLines(String primary, String latestAssistant, String latestUser) {
        StringBuilder sb = new StringBuilder();
        if (primary != null && !primary.isEmpty()) sb.append(primary);
        // Include latest user prompt and assistant reply only when they add
        // information beyond `primary` — avoids double-printing the same line.
        if (latestUser != null && !latestUser.isEmpty() && !latestUser.equals(primary)) {
            if (sb.length() > 0) sb.append("\n");
            sb.append("Q: ").append(latestUser);
        }
        if (latestAssistant != null && !latestAssistant.isEmpty()
                && !latestAssistant.equals(primary)) {
            if (sb.length() > 0) sb.append("\n");
            sb.append("A: ").append(latestAssistant);
        }
        return sb.toString();
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
        } catch (Exception e) {
            // Fallback if ProgressStyle API is unavailable at runtime
            buildFallbackProgressNotification(builder, total, completed, inProgress, "", "", "", "");
        }
    }

    private void buildFallbackProgressNotification(NotificationCompat.Builder builder,
            int total, int completed, int inProgress, String activeForm, String currentTask,
            String latestAssistantText, String latestUserText) {
        builder.setProgress(total, completed, false);
        StringBuilder bigText = new StringBuilder();
        bigText.append(completed).append("/").append(total).append(" 完成");
        if (inProgress > 0 && activeForm != null && !activeForm.isEmpty()) {
            bigText.append(" · ").append(activeForm);
        }
        if (currentTask != null && !currentTask.isEmpty()) {
            bigText.append("\n").append(currentTask);
        }
        // Surface latest round so the card moves with the conversation; skip
        // the assistant line when it would duplicate currentTask/activeForm.
        if (latestUserText != null && !latestUserText.isEmpty()) {
            bigText.append("\nQ: ").append(latestUserText);
        }
        if (latestAssistantText != null && !latestAssistantText.isEmpty()
                && !latestAssistantText.equals(currentTask)
                && !latestAssistantText.equals(activeForm)) {
            bigText.append("\nA: ").append(latestAssistantText);
        }
        builder.setStyle(new NotificationCompat.BigTextStyle().bigText(bigText.toString()));
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

        new AlertDialog.Builder(this)
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

    @SuppressWarnings("deprecation")
    private void downloadAndInstall(String downloadUrl, String fileName, String source, String latestVersion) {
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            Toast.makeText(this, "下载地址为空", Toast.LENGTH_LONG).show();
            return;
        }
        if (fileName == null || fileName.isEmpty()) {
            fileName = "wand-update.apk";
        }
        final String safeFileName = fileName;

        ProgressDialog progress = new ProgressDialog(this);
        progress.setMessage(getString(R.string.downloading_update));
        progress.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progress.setMax(100);
        progress.setCancelable(false);
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
                    while ((count = in.read(buffer)) != -1) {
                        total += count;
                        out.write(buffer, 0, count);
                        if (fileLength > 0) {
                            int percent = (int) (total * 100 / fileLength);
                            runOnUiThread(() -> progress.setProgress(percent));
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
                    new AlertDialog.Builder(MainActivity.this)
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
            new AlertDialog.Builder(this)
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
    }

    private void hideError() {
        errorOverlay.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }
}
