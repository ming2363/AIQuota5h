#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/AIQuota5h.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$ROOT/.build/module-cache"
SDK="${SDK:-$(xcrun --show-sdk-path)}"
SDK="$(cd "$SDK" && pwd -P)"
EXTRA=()
if [[ -z "${SWIFT_SDK_OVERLAY:-}" ]] \
  && xcrun swiftc --version | grep -q 'swiftlang-6.2.4.1.4 clang-1700.6.4.2' \
  && grep -q 'swiftlang-6.2.3.3.2 clang-1700.6.3.2' "$SDK/System/Library/Frameworks/Foundation.framework/Modules/Foundation.swiftmodule/arm64e-apple-macos.swiftinterface"; then
  python3 "$ROOT/scripts/make-sdk-overlay.py" "$SDK" "$ROOT/.build/sdk-overlay"
  SWIFT_SDK_OVERLAY="$ROOT/.build/sdk-overlay/overlay.yaml"
fi
if [[ -n "${SWIFT_SDK_OVERLAY:-}" ]]; then EXTRA+=(-vfsoverlay "$SWIFT_SDK_OVERLAY"); fi
xcrun swiftc -O -sdk "$SDK" -target "$(uname -m)-apple-macosx15.0" "${EXTRA[@]}" \
  -module-cache-path "$ROOT/.build/module-cache" \
  "$ROOT/macOS/"*.swift -o "$APP/Contents/MacOS/AIQuota5h"
cp "$ROOT/macOS/Info.plist" "$APP/Contents/Info.plist"
xcrun swiftc -sdk "$SDK" "${EXTRA[@]}" -module-cache-path "$ROOT/.build/module-cache" \
  "$ROOT/scripts/make-icon.swift" -o "$ROOT/.build/make-icon"
ICONSET="$ROOT/.build/AppIcon.iconset"
mkdir -p "$ICONSET"
"$ROOT/.build/make-icon" "$ROOT/.build/icon-1024.png"
for SIZE in 16 32 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$ROOT/.build/icon-1024.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE=$((SIZE * 2))
  sips -z "$DOUBLE" "$DOUBLE" "$ROOT/.build/icon-1024.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "已构建 $APP"
