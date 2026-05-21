import Foundation

/// 调用 /api/macos-dmg-update 检查是否有新版本，对称 Android.checkForApkUpdate()。
final class UpdateChecker {
    enum Result {
        case noUpdate
        case available(latest: String, fileName: String, downloadUrl: String, size: Int64, source: String)
        case failed
    }

    let serverURL: URL
    let store: ServerStore

    init(serverURL: URL, store: ServerStore) {
        self.serverURL = serverURL
        self.store = store
    }

    func checkOnce(completion: @escaping (Result) -> Void) {
        let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        var comp = URLComponents(url: serverURL.appendingPathComponent("/api/macos-dmg-update"), resolvingAgainstBaseURL: false)
        comp?.queryItems = [URLQueryItem(name: "currentVersion", value: current)]
        guard let url = comp?.url else { completion(.failed); return }

        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let task = SelfSignedSession.shared.session.dataTask(with: req) { data, response, error in
            guard error == nil,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(.failed); return
            }
            let available = json["updateAvailable"] as? Bool ?? false
            guard available,
                  let latest = json["latestVersion"] as? String,
                  let downloadUrl = json["downloadUrl"] as? String,
                  !downloadUrl.isEmpty else {
                completion(.noUpdate); return
            }
            let fileName = (json["fileName"] as? String) ?? "wand-update.dmg"
            let size = (json["size"] as? Int64) ?? Int64(json["size"] as? Int ?? 0)
            let source = (json["source"] as? String) ?? "local"
            completion(.available(latest: latest, fileName: fileName, downloadUrl: downloadUrl, size: size, source: source))
        }
        task.resume()
    }
}
