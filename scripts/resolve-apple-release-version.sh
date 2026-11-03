#!/usr/bin/env bash
set -euo pipefail

if [ "${GITHUB_REF}" != "${GITHUB_REF#refs/tags/}" ]; then
  TAG="${GITHUB_REF#refs/tags/}"
  VERSION="${TAG#v}"
else
  VERSION="$INPUT_VERSION"
fi
BUILD_STAMP="$(TZ=Asia/Shanghai date +%Y%m%d%H%M)"
if [[ "$VERSION" == *+* ]]; then
  ASSET_VERSION="${VERSION}.${BUILD_STAMP}"
else
  ASSET_VERSION="${VERSION}+${BUILD_STAMP}"
fi
echo "version=$VERSION" >> "$GITHUB_OUTPUT"
echo "build_stamp=$BUILD_STAMP" >> "$GITHUB_OUTPUT"
echo "asset_version=$ASSET_VERSION" >> "$GITHUB_OUTPUT"
echo "release_tag=v$VERSION" >> "$GITHUB_OUTPUT"
