#!/usr/bin/env bash
# 一条命令跑完全部质量门，顺序与 .github/workflows/ci.yml 一致。
#
#   bash scripts/verify.sh
#
# 步骤：品牌资产生成 → 原生图标（有 swift 时）→ npm run check（三套 tsc + bundle + 预算）→ npm test。
# 干净检出直接可用；任一步失败即整体失败。CI 跑的是同一串步骤，本地与 CI 不会漂移。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] sync generated brand assets"
npm run sync:brand-assets

# iOS/macOS AppIcon PNG 是生成物（.gitignore），品牌一致性用例会读它们；非 macOS 没有 swift 就跳过。
if command -v swift >/dev/null 2>&1; then
  echo "==> [2/4] generate native app icons"
  swift ios/scripts/generate-icons.swift ios/Wand/Assets.xcassets/AppIcon.appiconset
  swift macos/scripts/generate-icons.swift macos/Wand/Assets.xcassets/AppIcon.appiconset
else
  echo "==> [2/4] skip native icons (no swift on this machine)"
fi

echo "==> [3/4] npm run check (tsc x3 + bundle + budget)"
npm run check

echo "==> [4/4] npm test"
npm test

echo "==> verify OK"
