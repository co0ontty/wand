#!/usr/bin/env swift
// Shared icon renderer. sync-brand-assets copies this and Android's geometry
// into each native repository so standalone builds do not depend on Wand's root.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let isIOS = true // Set per platform by sync-brand-assets.
let outputDir = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Wand/Assets.xcassets/AppIcon.appiconset"

struct BrandPath: Decodable { let fill: String; let d: String }
struct BrandLogo: Decodable {
    let viewport: CGFloat
    let inset: CGFloat
    let background: String
    let paths: [BrandPath]
}

let brandColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
func color(_ hex: String) -> CGColor {
    let value = UInt32(hex.dropFirst(), radix: 16)!
    return CGColor(colorSpace: brandColorSpace, components: [
        CGFloat((value >> 16) & 255) / 255,
        CGFloat((value >> 8) & 255) / 255,
        CGFloat(value & 255) / 255, 1,
    ])!
}

let sourceURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("wand-logo.json")
let logo = try JSONDecoder().decode(BrandLogo.self, from: Data(contentsOf: sourceURL))
let pattern = try NSRegularExpression(pattern: #"M(\d+),(\d+)h(\d+)v(\d+)h-(\d+)z"#)
let rectangles: [(CGRect, CGColor)] = logo.paths.flatMap { path in
    let text = path.d as NSString
    return pattern.matches(in: path.d, range: NSRange(location: 0, length: text.length)).map { match in
        let values = (1...5).map { CGFloat(Double(text.substring(with: match.range(at: $0)))!) }
        precondition(values[2] == values[4], "Invalid Android pixel rectangle")
        return (CGRect(x: values[0] + logo.inset, y: values[1] + logo.inset,
                       width: values[2], height: values[3]), color(path.fill))
    }
}
precondition(!rectangles.isEmpty, "Missing Android pixel-cat artwork")

func renderIcon(size: Int) -> CGImage {
    let alpha: CGImageAlphaInfo = isIOS ? .noneSkipLast : .premultipliedLast
    let ctx = CGContext(data: nil, width: size, height: size,
                        bitsPerComponent: 8, bytesPerRow: 0,
                        space: brandColorSpace, bitmapInfo: alpha.rawValue)!
    let edge = CGFloat(size)
    // iOS must be opaque and square (the OS masks it). macOS retains its icon
    // gutter and transparent rounded corners, without changing the cat artwork.
    let tile = CGRect(x: 0, y: 0, width: edge, height: edge)
        .insetBy(dx: isIOS ? 0 : edge * 0.04, dy: isIOS ? 0 : edge * 0.04)
    if !isIOS {
        ctx.addPath(CGPath(roundedRect: tile, cornerWidth: edge * 0.22,
                           cornerHeight: edge * 0.22, transform: nil))
        ctx.clip()
    }
    ctx.setFillColor(color(logo.background))
    ctx.fill(tile)
    ctx.translateBy(x: tile.minX, y: tile.maxY)
    ctx.scaleBy(x: tile.width / logo.viewport, y: -tile.height / logo.viewport)
    for (rect, fill) in rectangles {
        ctx.setFillColor(fill)
        ctx.fill(rect)
    }
    return ctx.makeImage()!
}

let specs: [(String, Int)] = isIOS ? [("icon_1024.png", 1024)] : [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
let directory = URL(fileURLWithPath: outputDir)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for (name, size) in specs {
    let url = directory.appendingPathComponent(name)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fatalError("Cannot create \(name)")
    }
    CGImageDestinationAddImage(dest, renderIcon(size: size), nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("Cannot write \(name)") }
    print("✓ \(name) (\(size)×\(size), Android pixel cat)")
}
