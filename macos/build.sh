#!/usr/bin/env bash
# 在 macOS 上构建 Wand.app（Universal Binary, arm64+x86_64），ad-hoc 签名，
# 然后用 hdiutil 打成 wand-v<VERSION>.dmg。
#
# 用法：
#   ./build.sh <version>            # 例如：./build.sh 1.16.0
#
# 输出：
#   build/Wand.app
#   dist/wand-v<version>.dmg

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ build.sh 只能在 macOS 上运行（当前系统 $(uname)）" >&2
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

echo "==> 生成图标 PNG（10 个尺寸）"
swift "$PROJECT_ROOT/scripts/generate-icons.swift" "$ICONSET_DIR"

echo "==> xcodebuild Universal Binary (arm64 + x86_64)"
xcodebuild \
  -project Wand.xcodeproj \
  -scheme Wand \
  -configuration Release \
  -derivedDataPath "$BUILD_DIR/dd" \
  -destination "generic/platform=macOS" \
  ARCHS="arm64 x86_64" \
  ONLY_ACTIVE_ARCH=NO \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$VERSION_CODE" \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  build

APP_SRC="$BUILD_DIR/dd/Build/Products/Release/Wand.app"
APP_DST="$BUILD_DIR/Wand.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "❌ 找不到产物 $APP_SRC" >&2
  exit 1
fi
cp -R "$APP_SRC" "$APP_DST"

echo "==> ad-hoc codesign (--deep --options runtime)"
codesign --sign - --force --deep --options runtime \
         --entitlements "$PROJECT_ROOT/Wand/Wand.entitlements" \
         "$APP_DST"
codesign --verify --strict --verbose=2 "$APP_DST"

echo "==> hdiutil 制作 DMG"
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP_DST" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

# 估算 DMG 大小（应用大小 + 20MB padding）
SIZE_KB=$(($(du -sk "$STAGING" | awk '{print $1}') + 20000))

DMG_OUT="$DIST_DIR/wand-v${VERSION}.dmg"
hdiutil create \
  -volname "Wand $VERSION" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  -size "${SIZE_KB}k" \
  -fs HFS+ \
  "$DMG_OUT"

echo ""
echo "✅ 完成"
echo "   .app: $APP_DST"
echo "   DMG : $DMG_OUT"
