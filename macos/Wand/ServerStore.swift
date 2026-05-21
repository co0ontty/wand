import Foundation
import Combine

/// 包装 UserDefaults，存连接的服务器、token、已下载/跳过的 DMG 版本。对称 Android 的 ServerStore.java。
final class ServerStore: ObservableObject {
    static let shared = ServerStore()

    private let defaults = UserDefaults.standard
    private let serverURLKey = "wand.serverURL"
    private let tokenKey = "wand.token"
    private let skippedVersionKey = "wand.skippedDmgVersion"
    private let downloadedVersionKey = "wand.downloadedDmgVersion"

    @Published private(set) var serverURL: URL?
    @Published private(set) var token: String?

    init() {
        if let s = defaults.string(forKey: serverURLKey), let u = URL(string: s) {
            self.serverURL = u
        }
        self.token = defaults.string(forKey: tokenKey)
    }

    func connect(serverURL: URL, token: String?) {
        self.serverURL = serverURL
        self.token = token
        defaults.set(serverURL.absoluteString, forKey: serverURLKey)
        if let token { defaults.set(token, forKey: tokenKey) }
        else { defaults.removeObject(forKey: tokenKey) }
    }

    func disconnect() {
        serverURL = nil
        token = nil
        defaults.removeObject(forKey: serverURLKey)
        defaults.removeObject(forKey: tokenKey)
    }

    var skippedDmgVersion: String? {
        get { defaults.string(forKey: skippedVersionKey) }
        set {
            if let v = newValue { defaults.set(v, forKey: skippedVersionKey) }
            else { defaults.removeObject(forKey: skippedVersionKey) }
        }
    }

    var downloadedDmgVersion: String? {
        get { defaults.string(forKey: downloadedVersionKey) }
        set {
            if let v = newValue { defaults.set(v, forKey: downloadedVersionKey) }
            else { defaults.removeObject(forKey: downloadedVersionKey) }
        }
    }
}
