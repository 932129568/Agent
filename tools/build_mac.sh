#!/usr/bin/env bash
# v1.9.0 M7 · macOS 构建签名公证流水线（理论支持——macOS 真机执行）
# 用法：bash tools/build_mac.sh [--no-sign] [--no-notarize]
# 前置：Xcode CLT + Python 3.11+（arm64）+ pip install -r requirements-mac.txt
#       （pywebview[cocoa] / pyinstaller / Pillow / send2trash）
# 未签名降级路径：--no-sign --no-notarize → 见
#       deliverables/dev-plan/mac-unsigned-fallback.md（Gatekeeper Open Anyway）
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(cat VERSION)
IDENTITY="${MAC_SIGN_IDENTITY:-Developer ID Application: YOUR NAME (TEAMID)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-harbor-notary}"   # notarytool 凭据 profile
SIGN=1; NOTARIZE=1
for arg in "$@"; do
  case "$arg" in
    --no-sign) SIGN=0 ;;
    --no-notarize) NOTARIZE=0 ;;
  esac
done

echo "[1/7] 图标资产：harbor-icon.png → build/Harbor.icns"
mkdir -p build
if command -v iconutil >/dev/null 2>&1; then
  mkdir -p build/iconset
  for size in 16 32 64 128 256 512; do
    sips -z $size $size harbor-icon.png --out "build/iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size*2)) $((size*2)) harbor-icon.png --out "build/iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns build/iconset -o build/Harbor.icns
else
  echo "  （iconutil 不可用——放行：spec 对缺失 icns 容忍由 PyInstaller 报错显式化）"
fi

echo "[2/7] 版本纪律断言（M7.9）：CFBundleShortVersionString == VERSION"
grep -q "CFBundleShortVersionString': APP_VERSION" Harbor-mac.spec \
  || { echo "R1 失败：spec 版本注入键漂移"; exit 1; }
echo "  VERSION=$VERSION ✓"

echo "[3/7] PyInstaller（arm64）"
pyinstaller Harbor-mac.spec --noconfirm --clean

echo "[4/7] codesign 由内而外（M7.4：find Mach-O → 逐个签 → 整体签）"
APP="dist/Harbor.app"
if [ "$SIGN" = "1" ]; then
  find "$APP" -type f \( -name '*.dylib' -o -perm +111 \) \
    -exec codesign --force --timestamp --options runtime \
      --sign "$IDENTITY" {} \;
  codesign --force --timestamp --options runtime \
    --entitlements tools/mac-entitlements.plist \
    --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP" && echo "  签名校验 ✓"
else
  echo "  跳过签名（未签名降级路径——Gatekeeper Open Anyway 引导）"
fi

echo "[5/7] notarytool 公证（M7.6：ZIP 提交 + wait + stapler）"
if [ "$NOTARIZE" = "1" ] && [ "$SIGN" = "1" ]; then
  ditto -c -k --keepParent "$APP" "dist/Harbor.zip"
  xcrun notarytool submit "dist/Harbor.zip" --profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP" && echo "  公证装订 ✓"
  rm -f "dist/Harbor.zip"
else
  echo "  跳过公证（未签名/显式跳过）"
fi

echo "[6/7] DMG 制作（M7.7：hdiutil 拖拽安装布局）"
# 复核修正：dmgroot 从不清理——上次残留 Harbor.app 时 cp -R 发生嵌套复制
# （Harbor.app/Harbor.app），DMG 内是旧版+嵌套新版
rm -rf build/dmgroot
mkdir -p build/dmgroot
cp -R "$APP" build/dmgroot/
ln -sfn /Applications build/dmgroot/Applications
hdiutil create -volname "Harbor $VERSION" \
  -srcfolder build/dmgroot -ov -format UDZO \
  "dist/Harbor-${VERSION}.dmg"

echo "[7/7] 出口校验（M7.10）"
if [ "$SIGN" = "1" ]; then
  spctl --assess --type execute "$APP" && echo "  spctl ✓"
fi
hdiutil attach -readonly -nobrowse "dist/Harbor-${VERSION}.dmg" -mountpoint /tmp/harbor_dmg
ls /tmp/harbor_dmg/Harbor.app >/dev/null && echo "  DMG 挂载安装布局 ✓"
hdiutil detach /tmp/harbor_dmg >/dev/null

echo "完成：dist/Harbor-${VERSION}.dmg（VERSION=$VERSION）"
