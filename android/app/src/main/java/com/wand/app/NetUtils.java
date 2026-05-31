package com.wand.app;

import java.net.HttpURLConnection;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 网络相关的共享工具。
 *
 * wand server 默认用自签名证书 (src/cert.ts), 浏览器侧靠 WebView 的
 * onReceivedSslError 放行; 而 APK 自己发起的 HttpURLConnection (更新检查 /
 * APK 下载 / 连接探测) 没有 WebView 兜底, 必须显式信任自签名链, 否则
 * 一律 SSLHandshakeException。这里集中处理, 供各 Activity 共用。
 */
final class NetUtils {

    private NetUtils() {}

    /**
     * 让传入的连接 (若为 HTTPS) 信任任意证书 + 跳过 hostname 校验。
     * 仅用于本工具自分发场景下连接用户自己的 wand server, 不用于公网请求。
     */
    static void trustSelfSigned(HttpURLConnection conn) throws Exception {
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
}
