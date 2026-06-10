import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: ServerStore
    @State private var showSwitchSheet = false

    var body: some View {
        ZStack {
            // 全屏背景，避免 ConnectView/加载中状态露出空白
            Theme.background
                .ignoresSafeArea()
            if let serverURL = store.serverURL {
                WebContainerView(serverURL: serverURL, token: store.token)
                    .id(serverURL.absoluteString)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                // iOS 没有菜单栏，连接后用一个低调的悬浮按钮作为"切换服务器"入口。
                switchOverlayButton
            } else {
                ConnectView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $showSwitchSheet) {
            ConnectView(isPresentedAsSheet: true) { showSwitchSheet = false }
                .environmentObject(store)
        }
        .onReceive(NotificationCenter.default.publisher(for: .wandRequestSwitchServer)) { _ in
            showSwitchSheet = true
        }
    }

    /// 右上角安全区内的半透明小按钮，点击弹出切换服务器面板。
    /// 默认很淡，尽量不遮挡 wand 前端自身的 UI。
    private var switchOverlayButton: some View {
        VStack {
            HStack {
                Spacer()
                Button {
                    showSwitchSheet = true
                } label: {
                    Image(systemName: "server.rack")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(Theme.textSecondary)
                        .frame(width: 34, height: 34)
                        .background(
                            Circle().fill(Theme.surface.opacity(0.75))
                        )
                        .overlay(
                            Circle().stroke(Theme.border, lineWidth: 0.5)
                        )
                }
                .opacity(0.55)
                .padding(.trailing, 10)
                .padding(.top, 6)
            }
            Spacer()
        }
    }
}
