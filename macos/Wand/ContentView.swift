import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: ServerStore
    @State private var showSwitchSheet = false

    var body: some View {
        Group {
            if let serverURL = store.serverURL {
                WebContainerView(serverURL: serverURL, token: store.token)
                    .id(serverURL.absoluteString)
            } else {
                ConnectView()
            }
        }
        .sheet(isPresented: $showSwitchSheet) {
            ConnectView(isPresentedAsSheet: true) { showSwitchSheet = false }
        }
        .onReceive(NotificationCenter.default.publisher(for: .wandRequestSwitchServer)) { _ in
            showSwitchSheet = true
        }
    }
}
