import SwiftUI
import AppKit

/// Claude 品牌配色与复用样式。颜色随系统明暗自适应。
/// 品牌主色取 Anthropic Claude 的珊瑚橙（#D97757），背景用暖米白（#FAF9F5）。
enum Theme {
    private static func rgb(_ r: Double, _ g: Double, _ b: Double) -> NSColor {
        NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
    }

    /// 按当前外观（aqua / darkAqua）返回 light/dark 两套之一。
    private static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }

    private static func dynamicNS(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        }
    }

    // 品牌色（明暗下统一，便于辨识）
    static let brand = Color(red: 0.851, green: 0.467, blue: 0.341)        // #D97757
    static let brandStrong = Color(red: 0.741, green: 0.376, blue: 0.255)  // #BD6041

    // 表面 / 文本（自适应）
    static let background = dynamic(light: rgb(0.980, 0.976, 0.961), dark: rgb(0.137, 0.137, 0.129)) // #FAF9F5 / #232321
    static let surface = dynamic(light: rgb(1, 1, 1), dark: rgb(0.184, 0.184, 0.173))                 // #FFFFFF / #2F2F2C
    static let border = dynamic(light: rgb(0.894, 0.886, 0.851), dark: rgb(0.290, 0.290, 0.271))      // #E4E2D9 / #4A4A45
    static let textPrimary = dynamic(light: rgb(0.137, 0.133, 0.122), dark: rgb(0.957, 0.953, 0.933)) // #232220 / #F4F3EE
    static let textSecondary = dynamic(light: rgb(0.435, 0.427, 0.400), dark: rgb(0.655, 0.647, 0.616))
    static let danger = Color(red: 0.776, green: 0.231, blue: 0.184)       // #C63B2F

    /// WKWebView overscroll 区域底色，避免加载前/回弹时露出白底。
    static var nsBackground: NSColor {
        dynamicNS(light: rgb(0.980, 0.976, 0.961), dark: rgb(0.137, 0.137, 0.129))
    }
}

/// 实心珊瑚色主按钮，禁用态自动变淡。
struct WandPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Body(configuration: configuration)
    }

    struct Body: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.white)
                .padding(.vertical, 11)
                .padding(.horizontal, 18)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(isEnabled ? Theme.brand : Theme.brand.opacity(0.45))
                )
                .brightness(configuration.isPressed ? -0.06 : 0)
                .contentShape(Rectangle())
        }
    }
}

/// 描边次按钮，用于「重新连接 / 取消」等次要动作。
struct WandSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .medium))
            .foregroundColor(Theme.textPrimary)
            .padding(.vertical, 11)
            .padding(.horizontal, 18)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Theme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

/// 复用的品牌 logo：珊瑚渐变圆角方块 + 魔杖图标。
struct WandBrandMark: View {
    var size: CGFloat = 64

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Theme.brand, Theme.brandStrong],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: size, height: size)
                .shadow(color: Theme.brand.opacity(0.35), radius: size * 0.18, y: size * 0.06)
            Image(systemName: "wand.and.stars")
                .font(.system(size: size * 0.46, weight: .medium))
                .foregroundColor(.white)
        }
    }
}
