package com.wand.app;

import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class ConnectActivity extends AppCompatActivity {

    private TextInputEditText urlInput;
    private MaterialButton connectButton;
    private TextView statusText;
    private LinearLayout recentList;
    private TextView recentLabel;
    private ServerStore serverStore;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_connect);

        serverStore = new ServerStore(this);
        urlInput = findViewById(R.id.urlInput);
        connectButton = findViewById(R.id.connectButton);
        statusText = findViewById(R.id.statusText);
        recentList = findViewById(R.id.recentList);
        recentLabel = findViewById(R.id.recentLabel);

        handleDeepLink(getIntent());

        String lastUrl = serverStore.getLastUrl();
        if (!TextUtils.isEmpty(lastUrl)) {
            urlInput.setText(lastUrl);
        }

        connectButton.setOnClickListener(v -> attemptConnect());

        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                attemptConnect();
                return true;
            }
            return false;
        });

        refreshRecentList();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    private void handleDeepLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri uri = intent.getData();
        if ("wand".equals(uri.getScheme()) && "connect".equals(uri.getHost())) {
            String serverUrl = uri.getQueryParameter("url");
            if (!TextUtils.isEmpty(serverUrl)) {
                urlInput.setText(serverUrl);
                attemptConnect();
            }
        }
    }

    /**
     * Try to decode the input as a connect code (base64 encoded "URL#TOKEN").
     * Returns a String[2] = {url, token} on success, or null.
     */
    private String[] tryDecodeConnectCode(String input) {
        try {
            byte[] buf = Base64.getDecoder().decode(input.trim());
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

        new Thread(() -> {
            // First try decoding as connect code
            String[] decoded = tryDecodeConnectCode(rawInput);

            if (decoded != null) {
                String serverUrl = decoded[0];
                String appToken = decoded[1];

                String error = testConnectionWithToken(serverUrl, appToken);
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
                // Plain URL fallback
                String url = rawInput;
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                if (url.endsWith("/")) {
                    url = url.substring(0, url.length() - 1);
                }

                final String normalizedUrl = url;
                String error = testConnection(normalizedUrl);
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
        }).start();
    }

    private String testConnectionWithToken(String baseUrl, String appToken) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(baseUrl + "/api/login");
            conn = (HttpURLConnection) url.openConnection();
            trustSelfSigned(conn);

            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
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

    private String testConnection(String baseUrl) {
        try {
            URL url = new URL(baseUrl + "/api/config");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            trustSelfSigned(conn);

            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
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
    }

    private void showStatus(String message) {
        statusText.setText(message);
        statusText.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshRecentList();
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

            TextView urlText = new TextView(this);
            String displayText = entry;
            if (entry.length() > 60 && tryDecodeConnectCode(entry) != null) {
                displayText = entry.substring(0, 16) + "..." + entry.substring(entry.length() - 8);
            }
            urlText.setText(displayText);
            urlText.setTextSize(14f);
            urlText.setTextColor(getColor(R.color.primary));
            urlText.setTypeface(Typeface.MONOSPACE);
            urlText.setSingleLine(true);
            urlText.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            urlText.setLayoutParams(textParams);

            TextView deleteBtn = new TextView(this);
            deleteBtn.setText("\u00d7");
            deleteBtn.setTextSize(18f);
            deleteBtn.setTextColor(getColor(R.color.text_hint));
            deleteBtn.setPadding(dpToPx(12), 0, 0, 0);

            row.addView(urlText);
            row.addView(deleteBtn);

            urlText.setOnClickListener(v -> {
                urlInput.setText(entry);
                attemptConnect();
            });

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
