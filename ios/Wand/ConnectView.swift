import SwiftUI

/// 连接界面：输入服务器地址（host:port，自动判别 http/https）或 wand 设置页生成的"连接码"。
/// 解析与可达性探测统一收敛到 `WandAuth.resolve`，错误就地内联展示。
/// 对称 macOS 的 ConnectView，去掉了 macOS-only 的窗口尺寸约束，sheet 用 iOS 风格。
struct ConnectView: View {
    @EnvironmentObject var store: ServerStore

    var isPresentedAsSheet: Bool = false
    var onDismiss: (() -> Void)? = nil

    @State private var input: String = ""
    @State private var error: String? = nil
    @State private var isConnecting = false
    @FocusState private var inputFocused: Bool

    private var trimmedInput: String {
        input.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                if isPresentedAsSheet {
                    sheetHeader
                    Rectangle().fill(Theme.border).frame(height: 1)
                }
                ScrollView {
                    VStack {
                        Spacer(minLength: 24)
                        card
                            .frame(maxWidth: 440)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 24)
                        Spacer(minLength: 24)
                    }
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { inputFocused = true }
        }
    }

    // MARK: - 区块

    private var sheetHeader: some View {
        HStack {
            Text("切换服务器")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(Theme.textPrimary)
            Spacer()
            Button("取消") { onDismiss?() }
                .foregroundColor(Theme.textSecondary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    private var card: some View {
        VStack(spacing: 22) {
            VStack(spacing: 14) {
                WandBrandMark(size: 64)
                VStack(spacing: 6) {
                    Text("连接到 Wand")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                    Text("粘贴设置页的连接码，或直接输入服务器地址")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }

            inputField

            if let error {
                errorBanner(error)
            }

            connectButton

            if !store.recentInputs.isEmpty {
                recentSection
            }

            footerHint
        }
    }

    private var inputField: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("连接码 / 服务器地址")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(Theme.textSecondary)

            HStack(spacing: 8) {
                Image(systemName: "link")
                    .font(.system(size: 14))
                    .foregroundColor(Theme.textSecondary)
                TextField("例如 192.168.1.10:7777 或粘贴连接码", text: $input)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15, design: .monospaced))
                    .foregroundColor(Theme.textPrimary)
                    .focused($inputFocused)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .submitLabel(.go)
                    .onSubmit { connect() }
                    .disabled(isConnecting)
                if !input.isEmpty {
                    Button { input = ""; error = nil } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundColor(Theme.textSecondary)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 13)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(inputFocused ? Theme.brand : Theme.border,
                            lineWidth: inputFocused ? 1.5 : 1)
            )
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundColor(Theme.danger)
            Text(message)
                .font(.system(size: 13))
                .foregroundColor(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.danger.opacity(0.1))
        )
    }

    private var connectButton: some View {
        Button(action: connect) {
            HStack(spacing: 8) {
                if isConnecting {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
                Text(isConnecting ? "连接中…" : "连接")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(WandPrimaryButtonStyle())
        .disabled(isConnecting || trimmedInput.isEmpty)
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("最近连接")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(Theme.textSecondary)
            VStack(spacing: 6) {
                ForEach(store.recentInputs, id: \.self) { raw in
                    recentRow(raw)
                }
            }
        }
    }

    private func recentRow(_ raw: String) -> some View {
        let info = recentDisplay(raw)
        return HStack(spacing: 8) {
            Image(systemName: info.isCode ? "qrcode" : "network")
                .font(.system(size: 13))
                .foregroundColor(Theme.textSecondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(info.text)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if info.isCode {
                    Text("🔑 已绑定连接码")
                        .font(.system(size: 11))
                        .foregroundColor(Theme.textSecondary)
                }
            }
            Spacer(minLength: 4)
            Button {
                store.removeRecent(raw)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Theme.textSecondary)
                    .padding(8)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { useRecent(raw) }
    }

    private var footerHint: some View {
        Text("在电脑端 Wand 的「设置 → 连接 App」里获取连接码")
            .font(.system(size: 12))
            .foregroundColor(Theme.textSecondary)
            .multilineTextAlignment(.center)
            .padding(.top, 2)
    }

    // MARK: - 逻辑

    private func connect() {
        let raw = trimmedInput
        guard !raw.isEmpty, !isConnecting else { return }
        isConnecting = true
        error = nil
        inputFocused = false

        WandAuth.resolve(rawInput: raw) { result in
            DispatchQueue.main.async {
                isConnecting = false
                switch result {
                case .success(let target):
                    store.addRecent(raw)
                    store.connect(serverURL: target.url, token: target.token)
                    onDismiss?()
                case .failure(let err):
                    error = err.userMessage
                }
            }
        }
    }

    private func useRecent(_ raw: String) {
        guard !isConnecting else { return }
        input = raw
        connect()
    }

    private func recentDisplay(_ raw: String) -> (text: String, isCode: Bool) {
        if let decoded = WandAuth.decodeConnectCode(raw) {
            return (decoded.url.absoluteString, true)
        }
        return (raw, false)
    }
}
