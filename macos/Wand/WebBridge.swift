import AppKit
import WebKit

/// JS → 原生消息处理 + 自签名证书 + WKWebView 委托。对称 Android NotificationBridge / downloadUpdate。
final class WebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private weak var webView: WKWebView?
    private var serverURL: URL?
    private lazy var installer: DmgInstaller = DmgInstaller(server: ServerStore.shared)
    private var didKickOffAutoUpdate = false

    func attach(webView: WKWebView, serverURL: URL) {
        self.webView = webView
        self.serverURL = serverURL
        installer.serverURL = serverURL
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
    /// 加入 NSLog 方便用户报问题时定位"到底是 challenge 没触发，还是 trust 拿不到"。
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
                NSLog("[Wand] auth challenge: trust granted host=%@ port=%ld proto=%@",
                      host, port, proto)
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                NSLog("[Wand] auth challenge: serverTrust nil host=%@ — falling back to default", host)
                completionHandler(.performDefaultHandling, nil)
            }
            return
        }

        NSLog("[Wand] auth challenge: non-ServerTrust method=%@ host=%@ — default handling",
              method, host)
        completionHandler(.performDefaultHandling, nil)
    }

    // MARK: - Navigation lifecycle / diagnostics

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        NSLog("[Wand] navigation start: %@", webView.url?.absoluteString ?? "?")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        let url = webView.url?.absoluteString ?? "?"
        NSLog("[Wand] provisional navigation FAILED url=%@ domain=%@ code=%ld reason=%@",
              url, ns.domain, ns.code, ns.localizedDescription)
        showLoadError(error: ns, url: url)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        NSLog("[Wand] navigation FAILED domain=%@ code=%ld reason=%@",
              ns.domain, ns.code, ns.localizedDescription)
        showLoadError(error: ns, url: webView.url?.absoluteString ?? "?")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        NSLog("[Wand] navigation committed: %@", webView.url?.absoluteString ?? "?")
    }

    private func showLoadError(error: NSError, url: String) {
        DispatchQueue.main.async { [weak self] in
            guard let win = self?.webView?.window else { return }
            let alert = NSAlert()
            alert.messageText = "无法加载 wand 服务器"
            alert.informativeText = """
            URL: \(url)
            错误: \(error.localizedDescription)
            (\(error.domain) #\(error.code))

            请确认 wand 服务正在运行，并检查地址是否正确。
            """
            alert.alertStyle = .warning
            alert.addButton(withTitle: "重新连接")
            alert.addButton(withTitle: "重试")
            alert.beginSheetModal(for: win) { resp in
                if resp == .alertFirstButtonReturn {
                    ServerStore.shared.disconnect()
                } else {
                    self?.webView?.reload()
                }
            }
        }
    }

    /// /api/login 失败（token 失效 / 网络问题）时调用，提示用户重新连接。
    /// makeNSView 阶段 webView 可能还没挂到 window 上，所以做了无 window 的兜底。
    func presentAuthFailure(message: String) {
        DispatchQueue.main.async { [weak self] in
            let alert = NSAlert()
            alert.messageText = "无法登录 wand 服务器"
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "重新连接")
            alert.addButton(withTitle: "稍后")
            let handle: (NSApplication.ModalResponse) -> Void = { resp in
                if resp == .alertFirstButtonReturn {
                    ServerStore.shared.disconnect()
                }
            }
            if let win = self?.webView?.window {
                alert.beginSheetModal(for: win, completionHandler: handle)
            } else {
                handle(alert.runModal())
            }
        }
    }

    // MARK: - Lifecycle: 启动后做一次自动更新检测

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[Wand] navigation finished: %@", webView.url?.absoluteString ?? "?")
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
