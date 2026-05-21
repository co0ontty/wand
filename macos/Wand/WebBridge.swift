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

    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }

    // MARK: - Lifecycle: 启动后做一次自动更新检测

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
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
