#!/usr/bin/env bash
# Mitzo iOS — build, archive, and upload to TestFlight.
#
# Prerequisites:
#   1. Apple Developer account enrolled ($99/year)
#   2. com.mitzo.app registered in App Store Connect
#   3. App created in App Store Connect (Apps → +)
#   4. local.xcconfig with DEVELOPMENT_TEAM set
#   5. fastlane installed: gem install fastlane  (or brew install fastlane)
#   6. APPLE_ID env var set (your Apple ID email)
#   7. App-specific password for fastlane: https://appleid.apple.com
#      Set as FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD env var
#
# Usage:
#   ./scripts/deploy-testflight.sh              # full pipeline
#   ./scripts/deploy-testflight.sh --skip-build # archive + upload only (already built)

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "→ Building frontend + syncing to iOS..."
  cd frontend && npm run build:ios && cd ..
fi

echo "→ Archiving and uploading to TestFlight..."
cd frontend/ios

if command -v fastlane &>/dev/null; then
  fastlane beta
else
  echo ""
  echo "fastlane not installed. Install with:"
  echo "  gem install fastlane"
  echo "  # or"
  echo "  brew install fastlane"
  echo ""
  echo "Manual alternative:"
  echo "  1. Open Xcode: npx cap open ios  (from frontend/)"
  echo "  2. Product → Archive"
  echo "  3. Distribute App → TestFlight Internal Only"
  echo "  4. Upload"
  echo ""
  exit 1
fi

echo ""
echo "Done! Check App Store Connect for build processing status."
echo "https://appstoreconnect.apple.com"
