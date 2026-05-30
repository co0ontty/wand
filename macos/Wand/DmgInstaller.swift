import AppKit
import Foundation

/// 下载 DMG → hdiutil 挂载 → 在 Finder 中打开 mountpoint，让用户拖拽到 Applications。
/// 与 Android 的 Intent.ACTION_VIEW APK 同思路：把"安装"这一步交回系统/用户决策。
final class DmgInstaller: NSObject, URLSessionDownloadDelegate {

    let store: ServerStore
    var serverURL: URL?

    private var session: URLSession!
    private var progressWindow: NSWindow?
    private var progressBar: NSProgressIndicator?
    private var progressText: NSTextField?
    private var currentTargetFile: URL?
    private var currentLatestVersion: String?
    private weak var hostWindow: NSWindow?
    private var lastUiUpdate: TimeInterval = 0

    init(server: ServerStore) {
        self.store = server
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForResource = 600
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    func downloadAndMount(urlString: String, fileName: String, source: String,
                          presentingWindow: NSWindow?, latestVersion: String? = nil) {
        guard !urlString.isEmpty else {
            presentError(message: "下载地址为空", on: presentingWindow)
            return
        }
        let safeFileName = fileName.isEmpty ? "wand-update.dmg" : fileName

        // 拼绝对 URL（如果服务端给的是 /macos/download）
        let fullURL: URL?
        if urlString.lowercased().hasPrefix("http://") || urlString.lowercased().hasPrefix("https://") {
            fullURL = URL(string: urlString)
        } else if let base = serverURL {
            fullURL = URL(string: urlString, relativeTo: base)?.absoluteURL
        } else {
            fullURL = URL(string: urlString)
        }
        guard let target = fullURL else {
            presentError(message: "无效下载地址：\(urlString)", on: presentingWindow)
            return
        }

        // 准备保存路径
        let supportDir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Wand", isDirectory: true)) ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        currentTargetFile = supportDir.appendingPathComponent(safeFileName)
        currentLatestVersion = latestVersion
        hostWindow = presentingWindow

        DispatchQueue.main.async { self.presentProgress(on: presentingWindow, fileName: safeFileName) }

        var req = URLRequest(url: target)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let task = session.downloadTask(with: req)
        task.resume()
    }

    // MARK: - URLSessionDelegate

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

    // MARK: - URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData _: Int64, totalBytesWritten t: Int64, totalBytesExpectedToWrite e: Int64) {
        let now = Date().timeIntervalSince1970
        if now - lastUiUpdate < 0.05 && t != e { return }
        lastUiUpdate = now
        DispatchQueue.main.async {
            if e > 0 {
                let pct = Double(t) / Double(e)
                self.progressBar?.isIndeterminate = false
                self.progressBar?.doubleValue = pct * 100
                self.progressText?.stringValue = "\(Int(pct * 100))%  \(Self.formatSize(t)) / \(Self.formatSize(e))"
            } else {
                self.progressBar?.isIndeterminate = true
                self.progressBar?.startAnimation(nil)
                self.progressText?.stringValue = Self.formatSize(t)
            }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let dest = currentTargetFile else { return }
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.moveItem(at: location, to: dest)
        } catch {
            DispatchQueue.main.async {
                self.dismissProgress()
                self.presentError(message: "保存 DMG 失败：\(error.localizedDescription)", on: self.hostWindow)
            }
            return
        }
        if let v = currentLatestVersion { store.downloadedDmgVersion = v }
        DispatchQueue.main.async {
            self.dismissProgress()
            self.mountAndReveal(dmgPath: dest.path)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        DispatchQueue.main.async {
            self.dismissProgress()
            self.presentError(message: "下载失败：\(error.localizedDescription)", on: self.hostWindow)
        }
    }

    // MARK: - hdiutil mount

    private func mountAndReveal(dmgPath: String) {
        let mountpoint = NSTemporaryDirectory() + "wand-dmg-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: mountpoint, withIntermediateDirectories: true)

        let attach = Process()
        attach.launchPath = "/usr/bin/hdiutil"
        attach.arguments = ["attach", "-nobrowse", "-noverify", "-noautoopen",
                            "-mountpoint", mountpoint, dmgPath]
        let pipe = Pipe()
        attach.standardError = pipe
        attach.standardOutput = pipe
        do {
            try attach.run()
            attach.waitUntilExit()
        } catch {
            presentError(message: "hdiutil 启动失败：\(error.localizedDescription)", on: hostWindow)
            return
        }
        guard attach.terminationStatus == 0 else {
            let stderr = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            presentError(message: "挂载 DMG 失败 (exit \(attach.terminationStatus))\n\(stderr)", on: hostWindow)
            return
        }
        // Finder 打开挂载点，提示用户拖拽到 Applications
        NSWorkspace.shared.open(URL(fileURLWithPath: mountpoint))
        showInstallHint(on: hostWindow)
    }

    private func showInstallHint(on window: NSWindow?) {
        let alert = NSAlert()
        alert.messageText = "DMG 已挂载"
        alert.informativeText = "Finder 中已显示新版 Wand。把 Wand.app 拖拽到 Applications 文件夹覆盖旧版即可完成更新。\n\n升级后请重新打开 Wand。"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好的")
        if let window {
            alert.beginSheetModal(for: window) { _ in }
        } else {
            alert.runModal()
        }
    }

    // MARK: - Progress UI

    private func presentProgress(on window: NSWindow?, fileName: String) {
        let host: NSView = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 110))

        let label = NSTextField(labelWithString: "正在下载 \(fileName)…")
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.frame = NSRect(x: 16, y: 70, width: 328, height: 18)
        host.addSubview(label)

        let bar = NSProgressIndicator(frame: NSRect(x: 16, y: 42, width: 328, height: 16))
        bar.isIndeterminate = true
        bar.style = .bar
        bar.startAnimation(nil)
        host.addSubview(bar)
        self.progressBar = bar

        let text = NSTextField(labelWithString: "…")
        text.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        text.textColor = .secondaryLabelColor
        text.frame = NSRect(x: 16, y: 18, width: 328, height: 16)
        host.addSubview(text)
        self.progressText = text

        let panel = NSPanel(contentRect: host.bounds,
                            styleMask: [.titled, .closable],
                            backing: .buffered,
                            defer: false)
        panel.title = "Wand 更新"
        panel.contentView = host
        panel.isReleasedWhenClosed = false
        panel.center()
        progressWindow = panel
        if let window {
            window.beginSheet(panel) { _ in }
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private func dismissProgress() {
        if let win = progressWindow {
            if let parent = win.sheetParent {
                parent.endSheet(win)
            } else {
                win.close()
            }
        }
        progressWindow = nil
        progressBar = nil
        progressText = nil
    }

    private func presentError(message: String, on window: NSWindow?) {
        let alert = NSAlert()
        alert.messageText = "下载失败"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好的")
        if let window {
            alert.beginSheetModal(for: window) { _ in }
        } else {
            alert.runModal()
        }
    }

    // MARK: - Format helper

    static func formatSize(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024.0) }
        return String(format: "%.1f MB", Double(bytes) / (1024.0 * 1024.0))
    }
}
