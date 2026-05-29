import AppKit
import WebKit

/// JS → 原生消息处理 + 自签名证书 + WKWebView 委托。导航状态通过 `WebViewModel`
/// 驱动 SwiftUI 覆盖层（加载中 / 出错），不再用 NSAlert 打断用户。
final class WebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private let model: WebViewModel
    private weak var webView: WKWebView?
    private var serverURL: URL?
    private lazy var installer: DmgInstaller = DmgInstaller(server: ServerStore.shared)
    private var didKickOffAutoUpdate = false
    private var hasLoadedOnce = false

    init(model: WebViewModel) {
        self.model = model
    }

    func attach(webView: WKWebView, serverURL: URL) {
        self.webView = webView
        self.serverURL = serverURL
        self.model.webView = webView
        installer.serverURL = serverURL
    }

    /// 切换到错误覆盖层（主线程）。token 登录失败时由 WebViewRepresentable 调用。
    func fail(title: String, message: String, canRetry: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.model.phase = .failed(title: title, message: message, canRetry: canRetry)
        }
    }

    // MARK: - JS → Native

    func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let dict = msg.body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "downloadUpdate":
            let url = (dict["url"] as? String) ?? ""
            let fileName = (dict["fileName"] as? String) ?? "wand-update.dmg"
            let source = (dict["source"] as? String) ?? "local"
            installer.downloadAndMount(urlString: url, fileName: fileName, source: source, presentingWindow: webView?.window)
        default:
            break
        }
    }

    // MARK: - Self-signed HTTPS / Auth challenge

    /// 对自签名证书一律放行：只要是 HTTPS 的 server trust 类型，就用拿到的 trust 构造
    /// URLCredential 喂回去；否则走默认处理（http basic / digest 等服务端用不到的场景）。
    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        let method = space.authenticationMethod
        let host = space.host
        let port = space.port
        let proto = space.protocol ?? "?"

        if method == NSURLAuthenticationMethodServerTrust {
            if let trust = space.serverTrust {
                NSLog("[Wand] auth challenge: trust granted host=%@ port=%ld proto=%@", host, port, proto)
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                NSLog("[Wand] auth challenge: serverTrust nil host=%@ — falling back to default", host)
                completionHandler(.performDefaultHandling, nil)
            }
            return
        }

        NSLog("[Wand] auth challenge: non-ServerTrust method=%@ host=%@ — default handling", method, host)
        completionHandler(.performDefaultHandling, nil)
    }

    // MARK: - Navigation lifecycle / diagnostics

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        NSLog("[Wand] navigation start: %@", webView.url?.absoluteString ?? "?")
        // 仅首屏加载（或显式重试）显示加载层；会话中途的局部跳转不打扰用户。
        if !hasLoadedOnce {
            model.phase = .loading
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return } // 被新导航/reload 打断，不算错误
        let url = webView.url?.absoluteString ?? serverURL?.absoluteString ?? "?"
        NSLog("[Wand] provisional navigation FAILED url=%@ domain=%@ code=%ld reason=%@",
              url, ns.domain, ns.code, ns.localizedDescription)
        showLoadError(error: ns, url: url)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        NSLog("[Wand] navigation FAILED domain=%@ code=%ld reason=%@", ns.domain, ns.code, ns.localizedDescription)
        showLoadError(error: ns, url: webView.url?.absoluteString ?? serverURL?.absoluteString ?? "?")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        NSLog("[Wand] navigation committed: %@", webView.url?.absoluteString ?? "?")
    }

    private func showLoadError(error: NSError, url: String) {
        let message = """
        \(url)
        \(error.localizedDescription)（\(error.domain) #\(error.code)）

        请确认 wand 服务正在运行，并检查地址是否正确。
        """
        model.phase = .failed(title: "无法加载 wand 服务器", message: message, canRetry: true)
    }

    // MARK: - Lifecycle: 加载完成 + 启动后做一次自动更新检测

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[Wand] navigation finished: %@", webView.url?.absoluteString ?? "?")
        hasLoadedOnce = true
        model.phase = .ready

        guard !didKickOffAutoUpdate, let serverURL else { return }
        didKickOffAutoUpdate = true
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            UpdateChecker(serverURL: serverURL, store: ServerStore.shared).checkOnce { [weak self] result in
                guard case let .available(latest, fileName, downloadUrl, size, source) = result else { return }
                DispatchQueue.main.async {
                    self?.presentUpdateDialog(latest: latest, fileName: fileName, downloadUrl: downloadUrl, size: size, source: source)
                }
            }
        }
    }

    private func presentUpdateDialog(latest: String, fileName: String, downloadUrl: String, size: Int64, source: String) {
        guard let win = webView?.window else { return }
        let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let store = ServerStore.shared
        if store.skippedDmgVersion == latest { return }
        if store.downloadedDmgVersion == latest { return }

        let alert = NSAlert()
        alert.messageText = "Wand 发现新版本"
        var info = "当前版本：\(current)\n最新版本：\(latest)"
        if size > 0 { info += "\n文件大小：\(DmgInstaller.formatSize(size))" }
        info += "\n来源：\(source == "github" ? "GitHub Release" : "本地")"
        alert.informativeText = info
        alert.addButton(withTitle: "立即更新")
        alert.addButton(withTitle: "稍后提醒")
        alert.addButton(withTitle: "跳过此版本")
        alert.alertStyle = .informational

        alert.beginSheetModal(for: win) { [weak self] resp in
            switch resp {
            case .alertFirstButtonReturn:
                self?.installer.downloadAndMount(urlString: downloadUrl, fileName: fileName, source: source, presentingWindow: win, latestVersion: latest)
            case .alertThirdButtonReturn:
                store.skippedDmgVersion = latest
            default:
                break
            }
        }
    }
}
