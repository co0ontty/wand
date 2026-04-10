package com.wand.app;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
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
import androidx.core.content.FileProvider;

import com.google.android.material.button.MaterialButton;

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

    private WebView webView;
    private LinearLayout errorOverlay;
    private TextView errorMessage;
    private String serverUrl;
    private String appToken;
    private boolean hasLoadedPage = false;
    private boolean updateCheckDone = false;

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
        ProgressDialog progress = new ProgressDialog(this);
        progress.setMessage(getString(R.string.downloading_update));
        progress.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progress.setMax(100);
        progress.setCancelable(false);
        progress.show();

        new Thread(() -> {
            try {
                String fullUrl;
                if (downloadUrl.startsWith("http")) {
                    fullUrl = downloadUrl; // GitHub absolute URL
                } else {
                    fullUrl = serverUrl + downloadUrl; // Local relative URL
                }

                URL url = new URL(fullUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                trustSelfSigned(conn);

                // Forward cookies for local downloads
                if (!downloadUrl.startsWith("http")) {
                    String cookie = CookieManager.getInstance().getCookie(serverUrl);
                    if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                }

                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);

                int responseCode = conn.getResponseCode();
                // Handle GitHub redirect (302)
                if (responseCode == 302 || responseCode == 301) {
                    String redirectUrl = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (redirectUrl != null) {
                        url = new URL(redirectUrl);
                        conn = (HttpURLConnection) url.openConnection();
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(60000);
                        conn.setInstanceFollowRedirects(true);
                    }
                }

                int fileLength = conn.getContentLength();
                File outputFile = new File(getExternalFilesDir(null), fileName);

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
                conn.disconnect();

                runOnUiThread(() -> {
                    progress.dismiss();
                    installApk(outputFile);
                });

            } catch (Exception e) {
                runOnUiThread(() -> {
                    progress.dismiss();
                    Toast.makeText(MainActivity.this,
                            getString(R.string.download_failed) + ": " + e.getMessage(),
                            Toast.LENGTH_LONG).show();
                });
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
            Toast.makeText(this, "安装失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
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
