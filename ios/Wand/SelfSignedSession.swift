import Foundation

/// 共享的 URLSession，对自签名 HTTPS 证书（wand 默认 cert.ts 产出的）放行。
/// 对称 macOS 端，但去掉了 DMG 下载相关的 URLSessionDownloadDelegate（iOS 不做应用内更新）。
final class SelfSignedSession: NSObject, URLSessionDelegate {
    static let shared = SelfSignedSession()

    /// session.configuration.httpCookieStorage 的便捷别名 —— 给 WandAuth 在
    /// allHeaderFields 字典合并语义吃掉多份 Set-Cookie 时做兜底读取用。
    var cookieStorage: HTTPCookieStorage? { session.configuration.httpCookieStorage }

    lazy var session: URLSession = {
        // 用 ephemeral —— 它自带独立的内存 cookieStorage / URLCache，
        // 不会和系统 / 其他 App 的 .shared 存储互相污染。
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 600
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    // MARK: - URLSessionDelegate

    // 注意：completionHandler 不标 @MainActor。协议声明里带它，但标上后在这个
    // 非隔离同步方法里直接调用会变成 actor 隔离错误；不标只是 Swift 6 模式的
    // sendability 警告，Swift 5 下无害（macOS 端同款写法编译通过）。
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
