import SwiftUI

@main
struct WandApp: App {
    @StateObject private var store = ServerStore.shared

    var body: some Scene {
        WindowGroup("Wand") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 1100, minHeight: 700)
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                Button("切换服务器…") {
                    NotificationCenter.default.post(name: .wandRequestSwitchServer, object: nil)
                }
                .keyboardShortcut(",", modifiers: [.command, .shift])
            }
        }
    }
}

extension Notification.Name {
    static let wandRequestSwitchServer = Notification.Name("WandRequestSwitchServer")
}
