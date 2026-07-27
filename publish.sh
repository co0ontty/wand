#!/usr/bin/env bash
set -euo pipefail

# 从最新的 git tag 提取版本号（去掉 v 前缀）
TAG=$(git tag --sort=-v:refname --list 'v*' | head -1)
if [ -z "$TAG" ]; then
  echo "错误：没有找到 git tag"
  exit 1
fi

VERSION="${TAG#v}"

echo "==> 从 git tag 提取版本号: $TAG → $VERSION"

# 更新 package.json 中的 version
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "==> package.json version 已更新为 $VERSION"

# 客户端目录是 git submodule（wand-android / wand-macos / wand-ios），构建前确保已检出
echo "==> 同步客户端 submodule..."
git submodule update --init android macos ios

# 构建
echo "==> 开始构建..."
npm run build

# 编译 Android APK 并部署到生产目录
APK_DIR="$HOME/.wand/android"
mkdir -p "$APK_DIR"
echo "==> 编译 Android APK (v$VERSION)..."
(cd android && ./gradlew assembleDebug \
  -PAPP_VERSION_NAME="$VERSION")
cp android/app/build/outputs/apk/debug/app-debug.apk "$APK_DIR/wand-v${VERSION}.apk"
echo "==> APK 已部署到 $APK_DIR/wand-v${VERSION}.apk"

# 编译 macOS DMG（仅在 macOS 上能跑；非 macOS 跳过，由 GitHub Actions 在 push tag 时构建）
if [[ "$(uname)" == "Darwin" ]]; then
  DMG_DIR="$HOME/.wand/macos"
  mkdir -p "$DMG_DIR"
  echo "==> 编译 macOS DMG (v$VERSION)..."
  (cd macos && ./build.sh "$VERSION")
  cp "macos/dist/wand-v${VERSION}.dmg" "$DMG_DIR/wand-v${VERSION}.dmg"
  echo "==> DMG 已部署到 $DMG_DIR/wand-v${VERSION}.dmg"
else
  echo "==> 当前系统非 macOS，跳过 DMG 构建（push tag 后 GitHub Actions 会自动构建并发布到 Release）"
fi

# NPM 发布交给 GitHub Actions（push v* tag 触发 .github/workflows/npm-release.yml）。
# 本脚本只负责本地构建 + 把 APK/DMG 部署到 ~/.wand 供本地实例分发。
echo "==> 本地构建/部署完成。"
echo "==> NPM 发布请用：git tag v$VERSION && git push origin v$VERSION（CI 会自动 npm publish + 构建 APK/DMG 到 Release）"
