import Foundation

/// Token-based login against wand 服务端 `/api/login`，对称 Android `ConnectActivity.testConnectionWithToken`。
///
/// 服务端不接受 `?token=` query 参数（`requireAuth` 只读 `wand_session` cookie），所以原生壳必须
/// 用 appToken 走一次 `/api/login`，拿到 `Set-Cookie: wand_session=...` 注入 `WKHTTPCookieStore`，
/// 然后 WebView 加载 SPA 时才会带着已认证的 cookie。
enum WandAuth {

    enum Failure: Error {
        case invalidURL
        case network(String)
        case unauthorized
        case rateLimited
        case server(Int)
        case noCookie

        var userMessage: String {
            switch self {
            case .invalidURL: return "无效的服务器地址"
            case .network(let m): return "无法连接到服务器：\(m)"
            case .unauthorized: return "认证失败，连接码可能已过期（密码已更改），请重新获取连接码"
            case .rateLimited: return "登录尝试次数过多，请稍后再试"
            case .server(let code): return "服务器返回异常状态码：\(code)"
            case .noCookie: return "服务器未返回 session cookie"
            }
        }
    }

    /// POST /api/login with `{ "appToken": ... }`，回调返回解析出的 `wand_session` cookie。
    /// 使用 `SelfSignedSession` 以放行自签名证书。
    static func loginWithToken(serverURL: URL,
                               appToken: String,
                               timeout: TimeInterval = 15,
                               completion: @escaping (Result<HTTPCookie, Failure>) -> Void) {
        guard let loginURL = URL(string: "/api/login", relativeTo: serverURL)?.absoluteURL else {
            completion(.failure(.invalidURL))
            return
        }

        var req = URLRequest(url: loginURL)
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            req.httpBody = try JSONSerialization.data(withJSONObject: ["appToken": appToken])
        } catch {
            completion(.failure(.network(error.localizedDescription)))
            return
        }

        let task = SelfSignedSession.shared.session.dataTask(with: req) { _, response, error in
            if let error {
                completion(.failure(.network(error.localizedDescription)))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(.failure(.network("无效响应")))
                return
            }
            switch http.statusCode {
            case 200:
                var headers: [String: String] = [:]
                for (key, value) in http.allHeaderFields {
                    if let k = key as? String, let v = value as? String { headers[k] = v }
                }
                let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: loginURL)
                if let cookie = cookies.first(where: { $0.name == "wand_session" }) {
                    completion(.success(cookie))
                } else {
                    completion(.failure(.noCookie))
                }
            case 401:
                completion(.failure(.unauthorized))
            case 429:
                completion(.failure(.rateLimited))
            default:
                completion(.failure(.server(http.statusCode)))
            }
        }
        task.resume()
    }
}
