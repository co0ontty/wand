import Foundation

/// Token-based login against wand 服务端 `/api/login`，与 macOS 端完全一致（纯 Foundation，跨平台共享逻辑）。
///
/// 服务端不接受 `?token=` query 参数（`requireAuth` 只读 cookie），所以原生壳必须
/// 用 appToken 走一次 `/api/login`，拿到 `Set-Cookie` 头里的 session cookie 注入 `WKHTTPCookieStore`，
/// 然后 WebView 加载 SPA 时才会带着已认证的 cookie。
///
/// 服务端按 scheme 发不同名字的 cookie（详见 src/auth.ts SESSION_COOKIE_*）：
///   - HTTPS：`__Host-wand_session` + 兼容 `wand_session`
///   - HTTP：`wand_session_local`
/// 这里按"任一即可"的策略匹配，以兼容服务端版本演进。
enum WandAuth {

    /// 服务端可能发送的所有 session cookie 名字。任一存在即视为登录成功。
    static let sessionCookieNames: Set<String> = [
        "__Host-wand_session",
        "wand_session_local",
        "wand_session",
    ]

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
                               completion: @escaping (Result<[HTTPCookie], Failure>) -> Void) {
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
                // 优先从 SelfSignedSession 自带的 cookieStorage 拿——URLSession 已经把
                // 所有 Set-Cookie 头都解析完丢进去，不会因 Set-Cookie 合并/覆盖丢失。
                // 兜底再从 header 解析一次（防止 cookieStorage 因 Secure 标记跨 scheme 被滤掉）。
                let storageCookies = SelfSignedSession.shared.cookieStorage?.cookies(for: loginURL) ?? []
                var headerFields: [String: String] = [:]
                for (key, value) in http.allHeaderFields {
                    if let k = key as? String, let v = value as? String { headerFields[k] = v }
                }
                let headerCookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: loginURL)
                // 用 name 去重合并两源
                var merged: [String: HTTPCookie] = [:]
                for c in storageCookies { merged[c.name] = c }
                for c in headerCookies where merged[c.name] == nil { merged[c.name] = c }
                let sessionCookies = merged.values.filter { sessionCookieNames.contains($0.name) }
                if !sessionCookies.isEmpty {
                    completion(.success(sessionCookies))
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

    // MARK: - 连接码解码

    /// 解码连接码：base64(url#token)。服务端用标准 base64（src/server.ts encodeConnectCode），
    /// 但用户从聊天/二维码界面复制时可能混入换行或空格，所以先剥掉所有空白再用
    /// `.ignoreUnknownCharacters` 容错。token 是 HMAC-SHA256 的 64 位 hex，长度足够。
    static func decodeConnectCode(_ code: String) -> (url: URL, token: String)? {
        let cleaned = code.components(separatedBy: .whitespacesAndNewlines).joined()
        guard !cleaned.isEmpty,
              let data = Data(base64Encoded: cleaned, options: .ignoreUnknownCharacters),
              let s = String(data: data, encoding: .utf8),
              let hash = s.range(of: "#", options: .backwards) else { return nil }
        let urlPart = String(s[..<hash.lowerBound])
        let token = String(s[hash.upperBound...])
        guard urlPart.lowercased().hasPrefix("http"),
              let url = URL(string: urlPart), url.host != nil,
              token.count >= 16 else { return nil }
        return (url, token)
    }

    // MARK: - 智能解析 + 连接

    /// 解析用户输入并验证可达性，得到最终要连接的目标。
    /// - 连接码：走 `/api/login` 校验 token（token 失效会立刻报"连接码已过期"）。
    /// - 裸地址：按 http→https 顺序探测 `/api/session-check`（wand 默认 HTTP，所以 http 优先），
    ///   命中即用该 scheme。
    struct ConnectTarget {
        let url: URL
        let token: String?
    }

    static func resolve(rawInput: String,
                        completion: @escaping (Result<ConnectTarget, Failure>) -> Void) {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { completion(.failure(.invalidURL)); return }

        if let decoded = decodeConnectCode(trimmed) {
            loginWithToken(serverURL: decoded.url, appToken: decoded.token) { result in
                switch result {
                case .success:
                    completion(.success(ConnectTarget(url: decoded.url, token: decoded.token)))
                case .failure(let err):
                    completion(.failure(err))
                }
            }
            return
        }

        let candidates = candidateURLs(from: trimmed)
        guard !candidates.isEmpty else { completion(.failure(.invalidURL)); return }
        probeSequential(candidates, index: 0, completion: completion)
    }

    /// 把裸输入展开成候选 URL：已带 scheme 则原样；否则 http 在前、https 在后。
    static func candidateURLs(from input: String) -> [URL] {
        var s = input
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty else { return [] }
        let lower = s.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            if let u = URL(string: s), u.host != nil { return [u] }
            return []
        }
        return ["http://\(s)", "https://\(s)"].compactMap { raw -> URL? in
            guard let u = URL(string: raw), u.host != nil else { return nil }
            return u
        }
    }

    private static func probeSequential(_ urls: [URL], index: Int,
                                        completion: @escaping (Result<ConnectTarget, Failure>) -> Void) {
        guard index < urls.count else {
            completion(.failure(.network("无法连接到服务器，请确认地址和端口，以及 wand 服务是否在运行")))
            return
        }
        let url = urls[index]
        probe(url: url) { reachable in
            if reachable {
                completion(.success(ConnectTarget(url: url, token: nil)))
            } else {
                probeSequential(urls, index: index + 1, completion: completion)
            }
        }
    }

    /// 用公开端点 `/api/session-check` 探测可达性（始终返回 200，不会污染失败登录计数）。
    static func probe(url: URL, timeout: TimeInterval = 6, completion: @escaping (Bool) -> Void) {
        guard let checkURL = URL(string: "/api/session-check", relativeTo: url)?.absoluteURL else {
            completion(false); return
        }
        var req = URLRequest(url: checkURL)
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let task = SelfSignedSession.shared.session.dataTask(with: req) { _, response, error in
            if error != nil { completion(false); return }
            // 200（公开探测）或 401（旧版服务把 /api 全锁了）都说明服务器可达。
            if let http = response as? HTTPURLResponse, http.statusCode == 200 || http.statusCode == 401 {
                completion(true)
            } else {
                completion(false)
            }
        }
        task.resume()
    }
}
