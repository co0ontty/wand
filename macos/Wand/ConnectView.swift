import SwiftUI

/// 连接界面：输入服务器 URL（http://host:port）或 wand 设置页生成的"连接码"。
struct ConnectView: View {
    @EnvironmentObject var store: ServerStore

    var isPresentedAsSheet: Bool = false
    var onDismiss: (() -> Void)? = nil

    @State private var input: String = ""
    @State private var error: String? = nil
    @State private var isConnecting = false

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 8) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.accent)
                Text("连接到 Wand")
                    .font(.title2.bold())
                Text("粘贴 Wand 设置页的连接码，或直接输入服务器地址")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("连接码 / 服务器地址")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TextEditor(text: $input)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 80)
                    .padding(8)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.secondary.opacity(0.4), lineWidth: 1)
                    )
                if let error {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
            }

            HStack {
                if isPresentedAsSheet {
                    Button("取消", role: .cancel) { onDismiss?() }
                }
                Spacer()
                Button(action: connect) {
                    if isConnecting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("连接")
                            .frame(minWidth: 80)
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(isConnecting || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(32)
        .frame(width: 480)
    }

    private func connect() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isConnecting = true
        error = nil

        // 连接码格式：base64(url#token)
        if let decoded = decodeConnectCode(trimmed) {
            store.connect(serverURL: decoded.url, token: decoded.token)
            onDismiss?()
            isConnecting = false
            return
        }

        // 否则当成裸 URL 处理
        var raw = trimmed
        if !raw.lowercased().hasPrefix("http://") && !raw.lowercased().hasPrefix("https://") {
            raw = "http://" + raw
        }
        guard let url = URL(string: raw), url.host != nil else {
            error = "无法识别的连接码或地址"
            isConnecting = false
            return
        }
        store.connect(serverURL: url, token: nil)
        onDismiss?()
        isConnecting = false
    }

    private func decodeConnectCode(_ code: String) -> (url: URL, token: String)? {
        guard let data = Data(base64Encoded: code),
              let s = String(data: data, encoding: .utf8),
              let hash = s.range(of: "#", options: .backwards) else { return nil }
        let urlPart = String(s[..<hash.lowerBound])
        let token = String(s[hash.upperBound...])
        guard let url = URL(string: urlPart), token.count >= 16 else { return nil }
        return (url, token)
    }
}
