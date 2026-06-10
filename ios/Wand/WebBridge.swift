import UIKit
import WebKit

/// JS → 原生消息处理 + 自签名证书 + WKWebView 委托。导航状态通过 `WebViewModel`
/// 驱动 SwiftUI 覆盖层（加载中 / 出错）。对称 macOS 的 WebBridge，但去掉了应用内
/// 自动更新（DmgInstaller / UpdateChecker / NSAlert）——iOS 自签名应用无法自我安装更新。
final class WebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private let model: WebViewModel
    private weak var webView: WKWebView?
    private var serverURL: URL?
    private var hasLoadedOnce = false

    init(model: WebViewModel) {
        self.model = model
    }

    func attach(webView: WKWebView, serverURL: URL) {
        self.webView = webView
        self.serverURL = serverURL
        self.model.webView = webView
    }

    /// 切换到错误覆盖层（主线程）。token 登录失败时由 WebViewRepresentable 调用。
    func fail(title: String, message: String, canRetry: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.model.phase = .failed(title: title, message: message, canRetry: canRetry)
        }
    }

    // MARK: - JS → Native

    /// 前端可能发 downloadUpdate 等消息；iOS 端没有应用内更新通道，统一忽略，
    /// 仅保留通道以兼容前端共用代码，不报错。
    func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let dict = msg.body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        default:
            NSLog("[Wand] ignored native message type=%@ (no-op on iOS)", type)
        }
    }

    // MARK: - Self-signed HTTPS / Auth challenge

    /// 对自签名证书一律放行：只要是 HTTPS 的 server trust 类型，就用拿到的 trust 构造
    /// URLCredential 喂回去；否则走默认处理。
    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        let method = space.authenticationMethod
        let host = space.host

        if method == NSURLAuthenticationMethodServerTrust {
            if let trust = space.serverTrust {
                NSLog("[Wand] auth challenge: trust granted host=%@", host)
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[Wand] navigation finished: %@", webView.url?.absoluteString ?? "?")
        hasLoadedOnce = true
        model.phase = .ready
    }
}
