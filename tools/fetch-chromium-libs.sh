#!/usr/bin/env bash
# User-space Chromium dependency provisioning for Debian 12 (bookworm) arm64,
# no root: exact bookworm versions are pinned so a newer trixie build (which
# requires GLIBC_2.38) can never be selected.
set -euo pipefail
POOL=http://deb.debian.org/debian/pool/main
DEBS=/tmp/chromium-libs/debs
ROOT=/tmp/chromium-libs/root
mkdir -p "$DEBS" "$ROOT"

# deb file name -> pool subdirectory
PKGS=(
  "n/nspr|libnspr4_4.35-1_arm64.deb"
  "n/nss|libnss3_3.87.1-1+deb12u2_arm64.deb"
  "a/atk1.0|libatk1.0-0_2.36.0-2_arm64.deb"
  "a/at-spi2-core|libatk-bridge2.0-0_2.46.0-5_arm64.deb"
  "a/at-spi2-core|libatspi2.0-0_2.46.0-5_arm64.deb"
  "d/dbus|libdbus-1-3_1.14.10-1~deb12u1_arm64.deb"
  "a/alsa-lib|libasound2_1.2.8-1+b1_arm64.deb"
  "libx/libxcomposite|libxcomposite1_0.4.6-1_arm64.deb"
  "libx/libxdamage|libxdamage1_1.1.6-1_arm64.deb"
  "libx/libxfixes|libxfixes3_5.0.3-2_arm64.deb"
  "libx/libxrandr|libxrandr2_1.5.2-2+b1_arm64.deb"
  "m/mesa|libgbm1_22.3.6-1+deb12u2_arm64.deb"
  "libx/libxkbcommon|libxkbcommon0_1.5.0-1_arm64.deb"
  "libx/libxi|libxi6_1.8-1+b1_arm64.deb"
  "libd/libdrm|libdrm2_2.4.114-1+b1_arm64.deb"
  "w/wayland|libwayland-server0_1.21.0-1_arm64.deb"
)

for entry in "${PKGS[@]}"; do
  subdir="${entry%%|*}"; fname="${entry##*|}"
  out="$DEBS/$fname"
  if [[ ! -f "$out" ]]; then
    echo "get $fname"
    curl -fsS --max-time 60 -o "$out" "$POOL/$subdir/$fname"
  fi
done

for deb in "$DEBS"/*.deb; do dpkg-deb -x "$deb" "$ROOT"; done
echo "OK: extracted into $ROOT"
