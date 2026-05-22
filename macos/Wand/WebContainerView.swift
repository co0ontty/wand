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

        // 直接同步触发 load。token 仅作为 query string 附加（wand 服务端识别 ?token=），
        // 不再依赖异步 cookie 注入流程。
        var loadURL = serverURL
        if let token, !token.isEmpty, var comps = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) {
            var items = comps.queryItems ?? []
            items.append(URLQueryItem(name: "token", value: token))
            comps.queryItems = items
            loadURL = comps.url ?? serverURL
        }
        NSLog("[Wand] loading initial URL: %@", loadURL.absoluteString)
        webView.load(URLRequest(url: loadURL))
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
