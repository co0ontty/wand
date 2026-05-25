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
        cfg.websiteDataStore = .default()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground") // 避免首帧背景透出

        // UA 标记：让前端识别这是 macOS 原生壳
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 WandApp/\(version) WandPlatform/macOS"

        context.coordinator.attach(webView: webView, serverURL: serverURL)

        // 有 token：先调 /api/login 拿 session cookie 注入 WKHTTPCookieStore，再加载主页。
        // 对称 Android ConnectActivity.testConnectionWithToken → CookieManager.setCookie。
        // 服务端可能按 scheme 同时下发多份 cookie（__Host-wand_session / wand_session_local /
        // 兼容用的 wand_session），这里全部注入，浏览器请求时按 scheme 选合适的发送。
        // 没有 token：当成裸 URL，直接加载，由用户在 SPA 内部登录。
        let cookieStore = cfg.websiteDataStore.httpCookieStore
        if let token, !token.isEmpty {
            NSLog("[Wand] token-login before load: %@", serverURL.absoluteString)
            WandAuth.loginWithToken(serverURL: serverURL, appToken: token) { result in
                switch result {
                case .success(let cookies):
                    DispatchQueue.main.async {
                        let group = DispatchGroup()
                        for cookie in cookies {
                            group.enter()
                            cookieStore.setCookie(cookie) { group.leave() }
                        }
                        group.notify(queue: .main) {
                            NSLog("[Wand] %d cookie(s) injected, loading %@", cookies.count, serverURL.absoluteString)
                            webView.load(URLRequest(url: serverURL))
                        }
                    }
                case .failure(let err):
                    NSLog("[Wand] token-login FAILED: %@", err.userMessage)
                    DispatchQueue.main.async {
                        context.coordinator.presentAuthFailure(message: err.userMessage)
                    }
                }
            }
        } else {
            NSLog("[Wand] no token; loading %@ directly", serverURL.absoluteString)
            webView.load(URLRequest(url: serverURL))
        }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
