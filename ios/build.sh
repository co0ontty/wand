#!/usr/bin/env bash
# 在 macOS 上构建 Wand iOS 壳，产出一个【未签名】的 .ipa。
#
# 为什么不签名：免费 Apple ID 方案下，签名是在【安装时】由 sideload 工具
# （AltStore / SideStore / Sideloadly）用你自己的 Apple ID 现场完成的——它会
# 把这个未签名 IPA 重新签上你的开发者证书 + 设备描述文件再装进手机。
# 所以这里只负责编译出干净的 app 包，签名交给安装工具。
#
# 用法：
#   ./build.sh <version>            # 例如：./build.sh 1.16.0
#
# 输出：
#   build/Wand.app
#   dist/wand-v<version>.ipa   （未签名，拖进 AltStore/Sideloadly 即可）

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ build.sh 只能在 macOS 上运行（当前系统 $(uname)），需要 Xcode 工具链" >&2
  exit 1
fi

VERSION="${1:?usage: build.sh <version> (例如 1.16.0)}"
# 数字 build 号：major*10000 + minor*100 + patch
VERSION_CODE=$(echo "$VERSION" | awk -F. '{patch=$3; sub(/[-+].*/, "", patch); printf "%d", $1*10000+$2*100+patch}')

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
BUILD_DIR="$PROJECT_ROOT/build"
DIST_DIR="$PROJECT_ROOT/dist"
ICONSET_DIR="$PROJECT_ROOT/Wand/Assets.xcassets/AppIcon.appiconset"

rm -rf "$BUILD_DIR" "$DIST_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

echo "==> 生成 App 图标（1024 单尺寸）"
swift "$PROJECT_ROOT/scripts/generate-icons.swift" "$ICONSET_DIR"

echo "==> xcodebuild（iphoneos，未签名）"
xcodebuild \
  -project Wand.xcodeproj \
  -scheme Wand \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath "$BUILD_DIR/dd" \
  -destination "generic/platform=iOS" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$VERSION_CODE" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

APP_SRC="$BUILD_DIR/dd/Build/Products/Release-iphoneos/Wand.app"
APP_DST="$BUILD_DIR/Wand.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "❌ 找不到产物 $APP_SRC" >&2
  exit 1
fi
cp -R "$APP_SRC" "$APP_DST"

echo "==> 打包未签名 IPA（Payload/Wand.app → zip）"
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/Payload"
cp -R "$APP_DST" "$STAGING/Payload/"

IPA_OUT="$DIST_DIR/wand-v${VERSION}.ipa"
# -X 不存额外属性，-q 安静；IPA 本质就是个 zip
( cd "$STAGING" && zip -qry "$IPA_OUT" Payload )

echo ""
echo "✅ 完成"
echo "   .app: $APP_DST"
echo "   IPA : $IPA_OUT  （未签名）"
echo ""
echo "下一步：用 AltStore / SideStore / Sideloadly 把这个 IPA 装进 iPhone，"
echo "        安装时它会用你的免费 Apple ID 现场签名。详见 README.md。"
