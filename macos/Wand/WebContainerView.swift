import SwiftUI
import WebKit

struct WebContainerView: NSViewRepresentable {
    let serverURL: URL
    let token: String?

    func makeCoordinator() -> WebBridge {
        WebBridge()
    }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let userController = WKUserContentController()
        userController.add(context.coordinator, name: "wandNative")
        cfg.userContentController = userController
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        cfg.websiteDataStore = .default()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true

        // UA 标记：让前端识别这是 macOS 原生壳
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        if let existing = webView.value(forKey: "userAgent") as? String, !existing.isEmpty {
            webView.customUserAgent = existing + " WandApp/\(version) WandPlatform/macOS"
        } else {
            webView.customUserAgent = "Wand/\(version) WandApp/\(version) WandPlatform/macOS"
        }

        context.coordinator.attach(webView: webView, serverURL: serverURL)

        // 注入连接码 token 作为 cookie（如果有），并加载首页
        if let token, !token.isEmpty {
            let cookie = HTTPCookie(properties: [
                .domain: serverURL.host ?? "",
                .path: "/",
                .name: "wand_app_token",
                .value: token,
                .expires: Date(timeIntervalSinceNow: 365 * 24 * 3600),
            ])
            if let cookie {
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    webView.load(URLRequest(url: serverURL))
                }
            } else {
                webView.load(URLRequest(url: serverURL))
            }
        } else {
            webView.load(URLRequest(url: serverURL))
        }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
