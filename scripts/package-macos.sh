#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Run this packaging script on an Apple Silicon Mac." >&2
  exit 1
fi
npm run tauri build -- --bundles app
app="src-tauri/target/release/bundle/macos/DigiViewer.app"
# A linker-only signature is not sufficient for a downloadable .app bundle.
codesign --verify --deep --strict --verbose=2 "$app"
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
output="${1:-release/macos}"
mkdir -p "$output"
archive="$output/DigiViewer_${version}_mac_aarch64.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
verification_dir="$(mktemp -d)"
trap 'rm -rf "$verification_dir"' EXIT
ditto -x -k "$archive" "$verification_dir"
codesign --verify --deep --strict --verbose=2 "$verification_dir/DigiViewer.app"
(cd "$output" && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256")
echo "Created $archive (ad-hoc signed, not notarized; first launch requires user approval)."
