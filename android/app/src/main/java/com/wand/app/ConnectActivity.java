package com.wand.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import android.util.Base64;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class ConnectActivity extends AppCompatActivity {

    private static final int REQUEST_CAMERA_PERMISSION = 4242;

    private TextInputEditText urlInput;
    private MaterialButton connectButton;
    private MaterialButton scanQrButton;
    private TextView statusText;
    private LinearLayout recentList;
    private TextView recentLabel;
    private LinearLayout autoConnectGroup;
    private LinearLayout formGroup;
    private ServerStore serverStore;
    private boolean autoConnecting = false;

    // 用 single-thread executor 替代裸 new Thread, 配合 Future 在 onDestroy
    // 时 cancel(true) 中断未完成的连接探测 / cookie 写入。用户秒退或快速
    // 切服务器场景下, 之前的 raw Thread 还在跑, runOnUiThread 在 Activity
    // 已经 finish 之后调 setText / launchWebView 会触发 IllegalStateException
    // (尤其在低端机网络慢的时候比较常见)。
    private ExecutorService networkExecutor;
    private Future<?> currentTask;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_connect);

        serverStore = new ServerStore(this);
        networkExecutor = Executors.newSingleThreadExecutor();
        urlInput = findViewById(R.id.urlInput);
        connectButton = findViewById(R.id.connectButton);
        scanQrButton = findViewById(R.id.scanQrButton);
        statusText = findViewById(R.id.statusText);
        recentList = findViewById(R.id.recentList);
        recentLabel = findViewById(R.id.recentLabel);
        autoConnectGroup = findViewById(R.id.autoConnectGroup);
        formGroup = findViewById(R.id.formGroup);

        if (handleDeepLink(getIntent())) {
            return;
        }

        boolean skipAutoConnect = getIntent().getBooleanExtra("skip_auto_connect", false);
        String lastUrl = serverStore.getLastUrl();
        if (!TextUtils.isEmpty(lastUrl)) {
            urlInput.setText(lastUrl);
            if (!skipAutoConnect) {
                tryAutoConnect(lastUrl);
            } else {
                showForm();
            }
        } else {
            showForm();
        }

        connectButton.setOnClickListener(v -> attemptConnect());

        if (scanQrButton != null) {
            scanQrButton.setOnClickListener(v -> requestQrScan());
        }

        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                attemptConnect();
                return true;
            }
            return false;
        });
    }

    private void requestQrScan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA_PERMISSION);
            return;
        }
        launchQrScanner();
    }

    private void launchQrScanner() {
        IntentIntegrator integrator = new IntentIntegrator(this);
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
        integrator.setPrompt(getString(R.string.scan_qr_prompt));
        integrator.setBeepEnabled(false);
        integrator.setOrientationLocked(false);
        integrator.setBarcodeImageEnabled(false);
        integrator.initiateScan();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                launchQrScanner();
            } else {
                Toast.makeText(this, R.string.scan_qr_camera_denied, Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null) {
            String contents = result.getContents();
            if (TextUtils.isEmpty(contents)) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            String trimmed = contents.trim();
            // Accept either a Wand connect code (base64 URL#TOKEN), a wand://connect deep link,
            // or a plain server URL.
            String candidate = trimmed;
            if (candidate.startsWith("wand://")) {
                Uri uri = Uri.parse(candidate);
                if ("wand".equals(uri.getScheme()) && "connect".equals(uri.getHost())) {
                    String urlParam = uri.getQueryParameter("url");
                    if (!TextUtils.isEmpty(urlParam)) {
                        candidate = urlParam;
                    }
                }
            }
            String[] decoded = tryDecodeConnectCode(candidate);
            boolean looksLikeUrl = candidate.startsWith("http://") || candidate.startsWith("https://");
            if (decoded == null && !looksLikeUrl) {
                Toast.makeText(this, R.string.scan_qr_invalid, Toast.LENGTH_LONG).show();
                return;
            }
            urlInput.setText(candidate);
            attemptConnect();
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    private boolean handleDeepLink(Intent intent) {
        if (intent == null || intent.getData() == null) return false;
        Uri uri = intent.getData();
        if ("wand".equals(uri.getScheme()) && "connect".equals(uri.getHost())) {
            String serverUrl = uri.getQueryParameter("url");
            if (!TextUtils.isEmpty(serverUrl)) {
                urlInput.setText(serverUrl);
                attemptConnect();
                return true;
            }
        }
        return false;
    }

    private void tryAutoConnect(String savedInput) {
        autoConnecting = true;
        autoConnectGroup.setVisibility(View.VISIBLE);
        formGroup.setVisibility(View.GONE);

        cancelCurrentTask();
        currentTask = networkExecutor.submit(() -> {
            String[] decoded = tryDecodeConnectCode(savedInput);

            if (decoded != null) {
                String serverUrl = decoded[0];
                String appToken = decoded[1];
                String error = testConnectionWithToken(serverUrl, appToken, 5000);
                runOnUiThread(() -> {
                    autoConnecting = false;
                    if (error == null) {
                        serverStore.setAppToken(appToken);
                        launchWebView(serverUrl, appToken);
                    } else {
                        showFormWithMessage(error);
                    }
                });
            } else {
                String url = savedInput;
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                if (url.endsWith("/")) {
                    url = url.substring(0, url.length() - 1);
                }
                final String normalizedUrl = url;

                String savedToken = serverStore.getAppToken();
                if (!TextUtils.isEmpty(savedToken)) {
                    String error = testConnectionWithToken(normalizedUrl, savedToken, 5000);
                    if (error == null) {
                        runOnUiThread(() -> {
                            autoConnecting = false;
                            launchWebView(normalizedUrl, savedToken);
                        });
                        return;
                    }
                }

                String error = testConnection(normalizedUrl, 5000);
                runOnUiThread(() -> {
                    autoConnecting = false;
                    if (error == null) {
                        launchWebView(normalizedUrl, null);
                    } else {
                        showFormWithMessage(null);
                    }
                });
            }
        });
    }

    private void showForm() {
        autoConnectGroup.setVisibility(View.GONE);
        formGroup.setVisibility(View.VISIBLE);
        refreshRecentList();
    }

    private void showFormWithMessage(String errorMessage) {
        autoConnectGroup.setVisibility(View.GONE);
        formGroup.setVisibility(View.VISIBLE);
        if (errorMessage != null) {
            showStatus(errorMessage);
        }
        refreshRecentList();
    }

    /**
     * Try to decode the input as a connect code (base64 encoded "URL#TOKEN").
     * Returns a String[2] = {url, token} on success, or null.
     */
    private String[] tryDecodeConnectCode(String input) {
        try {
            String cleaned = input.replaceAll("\\s+", "");
            if (cleaned.isEmpty()) return null;
            byte[] buf = Base64.decode(cleaned, Base64.DEFAULT | Base64.NO_WRAP | Base64.URL_SAFE);
            String decoded = new String(buf, StandardCharsets.UTF_8);
            int hashIdx = decoded.lastIndexOf('#');
            if (hashIdx < 1) return null;
            String url = decoded.substring(0, hashIdx);
            String token = decoded.substring(hashIdx + 1);
            if (!url.startsWith("http") || token.length() < 16) return null;
            return new String[]{url, token};
        } catch (Exception e) {
            return null;
        }
    }

    private void attemptConnect() {
        String rawInput = urlInput.getText() != null ? urlInput.getText().toString().trim() : "";
        if (TextUtils.isEmpty(rawInput)) {
            showStatus("请输入连接码或服务器地址");
            return;
        }

        connectButton.setEnabled(false);
        connectButton.setText(R.string.connecting);
        statusText.setVisibility(View.GONE);

        cancelCurrentTask();
        currentTask = networkExecutor.submit(() -> {
            String[] decoded = tryDecodeConnectCode(rawInput);

            if (decoded != null) {
                String serverUrl = decoded[0];
                String appToken = decoded[1];

                String error = testConnectionWithToken(serverUrl, appToken, 8000);
                runOnUiThread(() -> {
                    connectButton.setEnabled(true);
                    connectButton.setText(R.string.connect_button);

                    if (error == null) {
                        serverStore.setLastUrl(rawInput);
                        serverStore.addRecentUrl(rawInput);
                        serverStore.setAppToken(appToken);
                        launchWebView(serverUrl, appToken);
                    } else {
                        showStatus(error);
                    }
                });
            } else {
                String url = rawInput;
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                if (url.endsWith("/")) {
                    url = url.substring(0, url.length() - 1);
                }

                final String normalizedUrl = url;
                String error = testConnection(normalizedUrl, 8000);
                runOnUiThread(() -> {
                    connectButton.setEnabled(true);
                    connectButton.setText(R.string.connect_button);

                    if (error == null) {
                        serverStore.setLastUrl(normalizedUrl);
                        serverStore.addRecentUrl(normalizedUrl);
                        serverStore.clearAppToken();
                        launchWebView(normalizedUrl, null);
                    } else {
                        showStatus(error);
                    }
                });
            }
        });
    }

    private void cancelCurrentTask() {
        if (currentTask != null && !currentTask.isDone()) {
            currentTask.cancel(true);
        }
        currentTask = null;
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        cancelCurrentTask();
        if (networkExecutor != null) {
            networkExecutor.shutdownNow();
            networkExecutor = null;
        }
    }

    private String testConnectionWithToken(String baseUrl, String appToken, int timeout) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(baseUrl + "/api/login");
            conn = (HttpURLConnection) url.openConnection();
            trustSelfSigned(conn);

            conn.setConnectTimeout(timeout);
            conn.setReadTimeout(timeout);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);

            JSONObject body = new JSONObject();
            body.put("appToken", appToken);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int code = conn.getResponseCode();
            String setCookie = conn.getHeaderField("Set-Cookie");
            conn.disconnect();

            if (code == 200) {
                if (setCookie != null) {
                    android.webkit.CookieManager.getInstance().setCookie(baseUrl, setCookie);
                    android.webkit.CookieManager.getInstance().flush();
                }
                return null;
            } else if (code == 401) {
                return "认证失败，连接码可能已过期（密码已更改），请重新获取连接码";
            } else if (code == 429) {
                return "登录尝试次数过多，请稍后再试";
            }
            return "服务器返回了异常状态码: " + code;
        } catch (java.net.ConnectException e) {
            return "无法连接到服务器，请确认地址和端口是否正确\n(" + e.getMessage() + ")";
        } catch (java.net.SocketTimeoutException e) {
            return "连接超时，请检查网络或服务器是否在运行\n(" + e.getMessage() + ")";
        } catch (java.net.UnknownHostException e) {
            return "无法解析主机名: " + e.getMessage();
        } catch (javax.net.ssl.SSLException e) {
            return "SSL/TLS 连接失败: " + e.getMessage();
        } catch (Exception e) {
            return "连接失败: " + e.getClass().getSimpleName() + " - " + e.getMessage();
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    private String testConnection(String baseUrl, int timeout) {
        try {
            URL url = new URL(baseUrl + "/api/config");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            trustSelfSigned(conn);

            conn.setConnectTimeout(timeout);
            conn.setReadTimeout(timeout);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            conn.disconnect();

            if (code == 200 || code == 401) {
                return null;
            }
            return "服务器返回了异常状态码: " + code;
        } catch (java.net.ConnectException e) {
            return "无法连接到服务器，请确认地址和端口是否正确\n(" + e.getMessage() + ")";
        } catch (java.net.SocketTimeoutException e) {
            return "连接超时，请检查网络或服务器是否在运行\n(" + e.getMessage() + ")";
        } catch (java.net.UnknownHostException e) {
            return "无法解析主机名: " + e.getMessage();
        } catch (javax.net.ssl.SSLException e) {
            return "SSL/TLS 连接失败: " + e.getMessage();
        } catch (java.net.MalformedURLException e) {
            return "地址格式不正确: " + e.getMessage();
        } catch (Exception e) {
            return "连接失败: " + e.getClass().getSimpleName() + " - " + e.getMessage();
        }
    }

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

    private void launchWebView(String url, String appToken) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("server_url", url);
        if (appToken != null) {
            intent.putExtra("app_token", appToken);
        }
        startActivity(intent);
        finish();
    }

    private void showStatus(String message) {
        statusText.setText(message);
        statusText.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!autoConnecting) {
            refreshRecentList();
        }
    }

    private void refreshRecentList() {
        recentList.removeAllViews();
        List<String> urls = serverStore.getRecentUrls();

        if (urls.isEmpty()) {
            recentLabel.setVisibility(View.GONE);
            return;
        }

        recentLabel.setVisibility(View.VISIBLE);

        for (String entry : urls) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dpToPx(8), 0, dpToPx(8));

            // Left column: primary URL + optional secondary "\ud83d\udd11 \u5df2\u7ed1\u5b9a\u8fde\u63a5\u7801" label.
            LinearLayout textColumn = new LinearLayout(this);
            textColumn.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams columnParams = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            textColumn.setLayoutParams(columnParams);

            String[] decoded = tryDecodeConnectCode(entry);
            String primaryText = decoded != null ? decoded[0] : entry;

            TextView urlText = new TextView(this);
            urlText.setText(primaryText);
            urlText.setTextSize(14f);
            urlText.setTextColor(getColor(R.color.primary));
            urlText.setTypeface(Typeface.MONOSPACE);
            urlText.setSingleLine(true);
            urlText.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            textColumn.addView(urlText);

            if (decoded != null) {
                TextView tag = new TextView(this);
                tag.setText("\ud83d\udd11 \u5df2\u7ed1\u5b9a\u8fde\u63a5\u7801");
                tag.setTextSize(11f);
                tag.setTextColor(getColor(R.color.text_secondary));
                tag.setPadding(0, dpToPx(2), 0, 0);
                textColumn.addView(tag);
            }

            TextView deleteBtn = new TextView(this);
            deleteBtn.setText("\u00d7");
            deleteBtn.setTextSize(18f);
            deleteBtn.setTextColor(getColor(R.color.text_hint));
            deleteBtn.setPadding(dpToPx(12), 0, dpToPx(4), 0);

            row.addView(textColumn);
            row.addView(deleteBtn);

            View.OnClickListener pickEntry = v -> {
                urlInput.setText(entry);
                attemptConnect();
            };
            textColumn.setOnClickListener(pickEntry);
            urlText.setOnClickListener(pickEntry);

            deleteBtn.setOnClickListener(v -> {
                serverStore.removeRecentUrl(entry);
                refreshRecentList();
            });

            recentList.addView(row);
        }
    }

    private int dpToPx(int dp) {
        return (int) (dp * getResources().getDisplayMetrics().density + 0.5f);
    }
}
