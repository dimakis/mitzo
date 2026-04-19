#!/usr/bin/env bash
# Mitzo iOS — build and open in Xcode for device deployment.
#
# Prerequisites:
#   1. Copy frontend/ios/local.xcconfig.example → frontend/ios/local.xcconfig
#   2. Set DEVELOPMENT_TEAM = <your 10-char Apple Team ID> in local.xcconfig
#   3. Register com.mitzo.app in App Store Connect (Identifiers → App IDs)
#   4. Enable Push Notifications capability on the App ID
#
# Usage:
#   ./scripts/build-ios.sh          # build + open Xcode
#   ./scripts/build-ios.sh --sync   # just sync (skip vite build)

set -euo pipefail

cd "$(dirname "$0")/../frontend"

if [[ "${1:-}" == "--sync" ]]; then
  echo "→ Syncing web assets to iOS project..."
  npx cap sync ios
else
  echo "→ Building frontend + syncing to iOS..."
  npm run build:ios
fi

echo "→ Opening Xcode..."
npx cap open ios

echo ""
echo "Next steps in Xcode:"
echo "  1. Select your iPhone as the build target"
echo "  2. Product → Run (⌘R)"
echo ""
echo "Verification checklist:"
echo "  [ ] App launches with Mitzo splash screen (dark background)"
echo "  [ ] Login with passphrase works"
echo "  [ ] Face ID / Touch ID prompt appears after first login"
echo "  [ ] Chat streaming works over Tailscale"
echo "  [ ] Haptic feedback on message send"
echo "  [ ] WS reconnects after backgrounding 30s"
echo "  [ ] Push notification fires when agent replies (app backgrounded)"
echo "  [ ] Status bar: light text on dark background"
echo "  [ ] Safe area clearance on notched devices"
