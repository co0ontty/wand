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

# 发布
echo "==> 发布 @co0ontty/wand@$VERSION 到 NPM..."
npm publish --access public

echo "==> 发布完成！"
