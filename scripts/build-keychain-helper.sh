#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: build-keychain-helper.sh <absolute-output-path> <Developer-ID-signing-identity>' >&2
  exit 2
fi
output_path=$1
signing_identity=$2
[[ "$output_path" = /* ]] || { echo 'Output path must be absolute' >&2; exit 2; }
[[ "$signing_identity" != '-' ]] || { echo 'Ad-hoc signing is not supported for installed helpers' >&2; exit 2; }
source_root=$(cd "$(dirname "$0")/.." && pwd)
module_cache=$(mktemp -d)
trap 'rm -rf "$module_cache"' EXIT
mkdir -p "$(dirname "$output_path")"
swiftc -O -module-cache-path "$module_cache" "$source_root/native/keychain-helper/main.swift" -o "$output_path"
codesign --force --options runtime --timestamp --identifier com.mitzo.keychain-helper --sign "$signing_identity" "$output_path"
codesign --verify --strict "$output_path"
echo 'Signed Keychain helper built. Configure its absolute path and Apple Developer Team ID in Mitzo.'
