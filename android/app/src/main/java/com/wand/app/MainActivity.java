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
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

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
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends AppCompatActivity {

    private static final String CHANNEL_ID_PREFIX = "wand_notif_";
    private static final String CHANNEL_ID_LEGACY = "wand_notifications";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final int NOTIFICATION_ID_BASE = 2000;

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

        backButton.setOnClickListener(v -> finish());

        createNotificationChannels();
        setupWebView();
        webView.loadUrl(serverUrl);
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

        webView.setWebChromeClient(new WebChromeClient());

        // Register JS bridge for native notifications
        webView.addJavascriptInterface(new NotificationBridge(), "WandNative");
    }

    // ── Notification channels ──

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null) return;

            // Remove legacy single channel
            nm.deleteNotificationChannel(CHANNEL_ID_LEGACY);

            AudioAttributes audioAttr = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();

            for (String[] preset : SOUND_PRESETS) {
                String channelId = CHANNEL_ID_PREFIX + preset[0];
                // Skip if channel already exists (sound cannot be changed after creation)
                if (nm.getNotificationChannel(channelId) != null) continue;

                NotificationChannel channel = new NotificationChannel(
                        channelId, "Wand · " + preset[1], NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("Wand 通知 — " + preset[1] + "铃声");
                Uri soundUri = Uri.parse("android.resource://" + getPackageName() + "/raw/notif_" + preset[0]);
                channel.setSound(soundUri, audioAttr);
                nm.createNotificationChannel(channel);
            }
        }
    }

    private String getActiveChannelId() {
        ServerStore store = new ServerStore(this);
        return CHANNEL_ID_PREFIX + store.getNotificationSound();
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
            runOnUiThread(() -> downloadAndInstall(url, fileName, source));
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

            NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, getActiveChannelId())
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title != null ? title : "Wand")
                    .setContentText(body != null ? body : "")
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setContentIntent(pi)
                    .setAutoCancel(true);

            if (tag != null) {
                NotificationManagerCompat.from(MainActivity.this).notify(tag, 0, builder.build());
            } else {
                NotificationManagerCompat.from(MainActivity.this).notify(
                        NOTIFICATION_ID_BASE + (notificationCounter % 20), builder.build());
            }
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
                    MediaPlayer mp = MediaPlayer.create(MainActivity.this, resId);
                    if (mp != null) {
                        mp.setOnCompletionListener(MediaPlayer::release);
                        mp.start();
                    }
                } catch (Exception ignored) {}
            });
        }
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

                // Check if user skipped this version
                ServerStore store = new ServerStore(MainActivity.this);
                if (latestVersion.equals(store.getSkippedVersion())) return;

                runOnUiThread(() -> showUpdateDialog(cv, latestVersion, downloadUrl, fileName, size, source));

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
                        downloadAndInstall(downloadUrl, fileName, source))
                .setNegativeButton(R.string.remind_later, null)
                .setNeutralButton(R.string.skip_version, (dialog, which) ->
                        new ServerStore(this).setSkippedVersion(latestVer))
                .setCancelable(true)
                .show();
    }

    @SuppressWarnings("deprecation")
    private void downloadAndInstall(String downloadUrl, String fileName, String source) {
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

    // ── Navigation and lifecycle ──

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        if (errorOverlay.getVisibility() == View.VISIBLE) {
            hideError();
            webView.reload();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onDestroy() {
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
