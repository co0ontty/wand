import SwiftUI
import WebKit

/// WebView 的加载状态，由 WebBridge（导航委托）更新，驱动 SwiftUI 覆盖层。
final class WebViewModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(title: String, message: String, canRetry: Bool)
    }

    @Published var phase: Phase = .loading
    /// WebBridge attach 时回填，供"重试"调用 reload()。
    weak var webView: WKWebView?

    func retry() {
        phase = .loading
        webView?.reload()
    }
}

/// 对外的容器视图：底层是 WKWebView，加载中/出错时盖上不透明的主题覆盖层，
/// 彻底消除旧版"加载白屏 + 生硬 NSAlert"的体验问题。
struct WebContainerView: View {
    let serverURL: URL
    let token: String?

    @EnvironmentObject private var store: ServerStore
    @StateObject private var model = WebViewModel()

    private var displayHost: String {
        if let host = serverURL.host {
            if let port = serverURL.port { return "\(host):\(port)" }
            return host
        }
        return serverURL.absoluteString
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            WebViewRepresentable(serverURL: serverURL, token: token, model: model)
            overlay
        }
    }

    @ViewBuilder private var overlay: some View {
        switch model.phase {
        case .loading:
            LoadingOverlay(host: displayHost)
        case .failed(let title, let message, let canRetry):
            ErrorOverlay(
                title: title,
                message: message,
                canRetry: canRetry,
                onRetry: { model.retry() },
                onReconnect: { store.disconnect() }
            )
        case .ready:
            EmptyView()
        }
    }
}

// MARK: - 覆盖层

private struct LoadingOverlay: View {
    let host: String

    var body: some View {
        ZStack {
            Theme.background
            VStack(spacing: 18) {
                WandBrandMark(size: 56)
                ProgressView()
                    .controlSize(.large)
                    .tint(Theme.brand)
                VStack(spacing: 4) {
                    Text("正在连接")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(Theme.textPrimary)
                    Text(host)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(Theme.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ErrorOverlay: View {
    let title: String
    let message: String
    let canRetry: Bool
    let onRetry: () -> Void
    let onReconnect: () -> Void

    var body: some View {
        ZStack {
            Theme.background
            VStack(spacing: 16) {
                ZStack {
                    Circle()
                        .fill(Theme.danger.opacity(0.12))
                        .frame(width: 62, height: 62)
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 26, weight: .medium))
                        .foregroundColor(Theme.danger)
                }
                Text(title)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(Theme.textPrimary)
                Text(message)
                    .font(.system(size: 12))
                    .foregroundColor(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    if canRetry {
                        Button(action: onRetry) {
                            Text("重试").frame(minWidth: 86)
                        }
                        .buttonStyle(WandPrimaryButtonStyle())
                    }
                    Button(action: onReconnect) {
                        Text("重新连接").frame(minWidth: 86)
                    }
                    .buttonStyle(WandSecondaryButtonStyle())
                }
                .padding(.top, 4)
            }
            .padding(40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - WKWebView 桥接

struct WebViewRepresentable: NSViewRepresentable {
    let serverURL: URL
    let token: String?
    let model: WebViewModel

    func makeCoordinator() -> WebBridge {
        WebBridge(model: model)
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
        webView.underPageBackgroundColor = Theme.nsBackground

        // UA 标记：让前端识别这是 macOS 原生壳
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 WandApp/\(version) WandPlatform/macOS"

        context.coordinator.attach(webView: webView, serverURL: serverURL)

        // 有 token：先调 /api/login 拿 session cookie 注入 WKHTTPCookieStore，再加载主页。
        // 服务端可能按 scheme 同时下发多份 cookie（__Host-wand_session / wand_session_local /
        // 兼容用的 wand_session），这里全部注入，浏览器请求时按 scheme 选合适的发送。
        // 没有 token：当成裸 URL（ConnectView 已探测过可达性），直接加载。
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
                    context.coordinator.fail(
                        title: "无法登录 wand 服务器",
                        message: err.userMessage,
                        canRetry: false
                    )
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
