#!/usr/bin/env bash
# Bump iOS version numbers in the Xcode project.
#
# Usage:
#   ./scripts/bump-ios-version.sh 1.1.0        # set marketing version
#   ./scripts/bump-ios-version.sh 1.1.0 5      # set marketing version + build number
#   ./scripts/bump-ios-version.sh --build       # increment build number only

set -euo pipefail

PBXPROJ="$(dirname "$0")/../frontend/ios/App/App.xcodeproj/project.pbxproj"

if [[ ! -f "$PBXPROJ" ]]; then
  echo "Error: project.pbxproj not found at $PBXPROJ" >&2
  exit 1
fi

current_marketing() {
  grep -m1 'MARKETING_VERSION' "$PBXPROJ" | sed 's/.*= *\(.*\);/\1/'
}

current_build() {
  grep -m1 'CURRENT_PROJECT_VERSION' "$PBXPROJ" | sed 's/.*= *\(.*\);/\1/'
}

if [[ "${1:-}" == "--build" ]]; then
  OLD_BUILD=$(current_build)
  NEW_BUILD=$((OLD_BUILD + 1))
  sed -i '' "s/CURRENT_PROJECT_VERSION = $OLD_BUILD;/CURRENT_PROJECT_VERSION = $NEW_BUILD;/g" "$PBXPROJ"
  echo "Build: $OLD_BUILD → $NEW_BUILD"
  echo "Marketing: $(current_marketing) (unchanged)"
  exit 0
fi

if [[ -z "${1:-}" ]]; then
  echo "Current version: $(current_marketing) ($(current_build))"
  echo ""
  echo "Usage:"
  echo "  $0 <version>         # e.g. 1.1.0"
  echo "  $0 <version> <build> # e.g. 1.1.0 5"
  echo "  $0 --build           # increment build number"
  exit 0
fi

NEW_VERSION="$1"
OLD_VERSION=$(current_marketing)
sed -i '' "s/MARKETING_VERSION = $OLD_VERSION;/MARKETING_VERSION = $NEW_VERSION;/g" "$PBXPROJ"
echo "Marketing: $OLD_VERSION → $NEW_VERSION"

if [[ -n "${2:-}" ]]; then
  NEW_BUILD="$2"
  OLD_BUILD=$(current_build)
  sed -i '' "s/CURRENT_PROJECT_VERSION = $OLD_BUILD;/CURRENT_PROJECT_VERSION = $NEW_BUILD;/g" "$PBXPROJ"
  echo "Build: $OLD_BUILD → $NEW_BUILD"
else
  OLD_BUILD=$(current_build)
  NEW_BUILD=$((OLD_BUILD + 1))
  sed -i '' "s/CURRENT_PROJECT_VERSION = $OLD_BUILD;/CURRENT_PROJECT_VERSION = $NEW_BUILD;/g" "$PBXPROJ"
  echo "Build: $OLD_BUILD → $NEW_BUILD (auto-incremented)"
fi
