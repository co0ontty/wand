#!/usr/bin/env swift
// 用 CoreGraphics 在 macOS 上生成 AppIcon.appiconset 所需的 10 个 PNG。
// 风格：圆角方块 + 渐变背景 + 大写 "W"。零外部依赖，仅在 macOS 上能跑。

import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outputDir = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Wand/Assets.xcassets/AppIcon.appiconset"

let specs: [(name: String, px: Int)] = [
    ("icon_16x16.png",       16),
    ("icon_16x16@2x.png",    32),
    ("icon_32x32.png",       32),
    ("icon_32x32@2x.png",    64),
    ("icon_128x128.png",    128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png",    256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png",    512),
    ("icon_512x512@2x.png",1024),
]

func renderIcon(size: Int) -> CGImage? {
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: size, height: size,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }

    let rect = CGRect(x: 0, y: 0, width: size, height: size)
    let radius = CGFloat(size) * 0.22

    // Rounded rect mask
    ctx.beginPath()
    let path = CGPath(roundedRect: rect.insetBy(dx: CGFloat(size) * 0.04, dy: CGFloat(size) * 0.04),
                      cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.addPath(path)
    ctx.clip()

    // Gradient (top: deep purple → bottom: teal-ish)
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
    let fontSize = CGFloat(size) * 0.58
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

for spec in specs {
    guard let img = renderIcon(size: spec.px) else {
        FileHandle.standardError.write("Failed to render \(spec.name)\n".data(using: .utf8)!)
        exit(1)
    }
    let fileURL = dirURL.appendingPathComponent(spec.name)
    if !writePNG(image: img, to: fileURL) {
        FileHandle.standardError.write("Failed to write \(spec.name)\n".data(using: .utf8)!)
        exit(1)
    }
    print("✓ \(spec.name) (\(spec.px)x\(spec.px))")
}
