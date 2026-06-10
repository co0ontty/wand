#!/usr/bin/env swift
// 用 CoreGraphics 在 macOS 上生成 iOS AppIcon.appiconset 所需的单张 1024x1024 PNG。
// iOS 14+ 支持"单尺寸"应用图标（系统自动派生其余尺寸并加圆角 mask），
// 所以这里只产出一张铺满整个方形、不带 alpha 通道的图（iOS 图标禁止透明）。
// 风格对齐 macOS 端：渐变背景 + 大写 "W"。零外部依赖，仅在 macOS 上能跑。

import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outputDir = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Wand/Assets.xcassets/AppIcon.appiconset"

let size = 1024

func renderIcon(size: Int) -> CGImage? {
    let cs = CGColorSpaceCreateDeviceRGB()
    // iOS 图标不允许 alpha：用 noneSkipLast，整张铺满，不自己做圆角（系统会 mask）。
    guard let ctx = CGContext(data: nil, width: size, height: size,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: cs,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }

    // 渐变背景（top: 深紫 → bottom: 青蓝），铺满整个方形画布
    let colors = [CGColor(red: 0.34, green: 0.27, blue: 0.92, alpha: 1.0),
                  CGColor(red: 0.13, green: 0.61, blue: 0.85, alpha: 1.0)] as CFArray
    let locations: [CGFloat] = [0, 1]
    if let grad = CGGradient(colorsSpace: cs, colors: colors, locations: locations) {
        ctx.drawLinearGradient(grad,
                               start: CGPoint(x: 0, y: CGFloat(size)),
                               end: CGPoint(x: 0, y: 0),
                               options: [])
    }

    // "W" glyph
    let glyph = "W" as NSString
    let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = nsCtx
    let fontSize = CGFloat(size) * 0.56
    let font = NSFont.systemFont(ofSize: fontSize, weight: .heavy)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor.white.withAlphaComponent(0.95),
        .kern: -CGFloat(size) * 0.02,
    ]
    let bbox = glyph.size(withAttributes: attrs)
    let pt = NSPoint(x: (CGFloat(size) - bbox.width) / 2,
                     y: (CGFloat(size) - bbox.height) / 2 - CGFloat(size) * 0.02)
    glyph.draw(at: pt, withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()

    return ctx.makeImage()
}

func writePNG(image: CGImage, to url: URL) -> Bool {
    let type = UTType.png.identifier as CFString
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

let fm = FileManager.default
let dirURL = URL(fileURLWithPath: outputDir)
try? fm.createDirectory(at: dirURL, withIntermediateDirectories: true)

guard let img = renderIcon(size: size) else {
    FileHandle.standardError.write("Failed to render icon\n".data(using: .utf8)!)
    exit(1)
}
let fileURL = dirURL.appendingPathComponent("icon_1024.png")
if !writePNG(image: img, to: fileURL) {
    FileHandle.standardError.write("Failed to write icon_1024.png\n".data(using: .utf8)!)
    exit(1)
}
print("✓ icon_1024.png (1024x1024, no-alpha)")
