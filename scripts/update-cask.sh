#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: update-cask.sh <version> <tap_dir>}"
TAP_DIR="${2:?usage: update-cask.sh <version> <tap_dir>}"

ARM_DMG="Cinch_${VERSION}_aarch64.dmg"
INTEL_DMG="Cinch_${VERSION}_x64.dmg"
RELEASE_BASE="https://github.com/cinchcli/desktop/releases/download/desktop-v${VERSION}"

curl -fsSL -o "/tmp/${ARM_DMG}"   "${RELEASE_BASE}/${ARM_DMG}"
curl -fsSL -o "/tmp/${INTEL_DMG}" "${RELEASE_BASE}/${INTEL_DMG}"

ARM_SHA=$(shasum -a 256 "/tmp/${ARM_DMG}"   | cut -d' ' -f1)
INTEL_SHA=$(shasum -a 256 "/tmp/${INTEL_DMG}" | cut -d' ' -f1)

CASK_FILE="${TAP_DIR}/Casks/cinch-desktop.rb"
sed -i.bak \
  -e "s/^  version \".*\"/  version \"${VERSION}\"/" \
  -e "s/arm:   \"[a-zA-Z0-9_]*\"/arm:   \"${ARM_SHA}\"/" \
  -e "s/intel: \"[a-zA-Z0-9_]*\"/intel: \"${INTEL_SHA}\"/" \
  "${CASK_FILE}"
rm "${CASK_FILE}.bak"

echo "Updated cinch-desktop.rb to ${VERSION}"
echo "  arm:   ${ARM_SHA}"
echo "  intel: ${INTEL_SHA}"
