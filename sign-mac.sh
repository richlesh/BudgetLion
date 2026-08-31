#!/bin/bash
# Manual deep-signing helper for local macOS builds.
# CI uses electron-builder's built-in signing; this is for hand-signing dist output.
set -e

IDENTITY="Developer ID Application: RICHARD A LESH (MMZ3Y97NTP)"
ENTITLEMENTS="entitlements.plist"

sign_app() {
  local APP="$1"
  [ -d "$APP" ] || return 0
  local FW="$APP/Contents/Frameworks"

  echo "=== Signing $APP ==="

  # 1. Sign all dylibs and .so files (includes better-sqlite3 native binding)
  find "$APP" \( -name "*.dylib" -o -name "*.so" -o -name "*.node" \) | while read -r f; do
    codesign --sign "$IDENTITY" --force --no-strict --timestamp "$f" 2>&1
  done

  # 2. Sign Electron Framework internals then the framework itself
  local EF="$FW/Electron Framework.framework"
  if [ -d "$EF" ]; then
    find "$EF/Versions/A/Libraries" -type f | while read -r f; do
      codesign --sign "$IDENTITY" --force --no-strict --timestamp "$f" 2>&1
    done
    codesign --sign "$IDENTITY" --force --no-strict --timestamp "$EF/Versions/A/Electron Framework" 2>&1
    codesign --sign "$IDENTITY" --force --no-strict --timestamp "$EF" 2>&1
  fi

  # 3. Sign other frameworks
  find "$FW" -name "*.framework" ! -path "*/Electron Framework.framework*" | while read -r f; do
    codesign --sign "$IDENTITY" --force --no-strict --timestamp "$f" 2>&1
  done

  # 4. Sign helper .app bundles
  for helper in "$FW/"*.app; do
    [ -d "$helper" ] || continue
    codesign --sign "$IDENTITY" --force --no-strict --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" "$helper" 2>&1
  done

  # 5. Sign the outer app
  codesign --sign "$IDENTITY" --force --no-strict --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" "$APP" 2>&1

  echo "Verifying $APP..."
  codesign --verify --deep --strict "$APP" && echo "OK" || echo "FAILED"
}

sign_app "dist/mac/BudgetLion.app"
sign_app "dist/mac-arm64/BudgetLion.app"
