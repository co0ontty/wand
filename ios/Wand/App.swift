import SwiftUI

/// iOS 版入口。对称 macOS 的 WandApp，但 iOS 没有菜单栏，所以"切换服务器"
/// 入口放在 ContentView 的悬浮按钮里（同样用 .wandRequestSwitchServer 通知驱动）。
@main
struct WandApp: App {
    @StateObject private var store = ServerStore.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}

extension Notification.Name {
    static let wandRequestSwitchServer = Notification.Name("WandRequestSwitchServer")
}
