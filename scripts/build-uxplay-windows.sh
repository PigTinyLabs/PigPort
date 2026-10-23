#!/usr/bin/env bash
# Builds UxPlay, the AirPlay receiver PigPort uses to show an iPhone/iPad screen on Windows,
# and bundles it with the GStreamer pieces it needs into resources/airplay.
#
# Runs in an MSYS2 UCRT64 shell (see .github/workflows/build.yml), which provides the
# compiler, GStreamer, libplist and OpenSSL. UxPlay is GPLv3 and ships as a separate program
# that PigPort starts; its license and a source notice are bundled next to it.
#
# UxPlay 1.74 (pinned commit below) has its own mDNS responder on Windows, so neither the
# build nor the user's PC needs Apple Bonjour.
set -euo pipefail

UXPLAY_REPO=https://github.com/FDH2/UxPlay
UXPLAY_COMMIT=517cbb1240d9b9f69330c55b957cdd52b4175b2a
PREFIX=/ucrt64

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/resources/airplay"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet --filter=blob:none "$UXPLAY_REPO" "$work/src"
git -C "$work/src" checkout --quiet "$UXPLAY_COMMIT"
cmake -S "$work/src" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja -C "$work/build"

rm -rf "$out"
mkdir -p "$out/bin" "$out/lib/gstreamer-1.0" "$out/libexec/gstreamer-1.0"
cp "$work/build/uxplay.exe" "$out/bin/"
cp "$PREFIX/libexec/gstreamer-1.0/gst-plugin-scanner.exe" "$out/libexec/gstreamer-1.0/"

# Only the plugins a screen-mirroring session uses: H.264/H.265 video and AAC/ALAC audio
# decoding, Direct3D video output and WASAPI audio output.
plugins=(coreelements app typefindfunctions playback autodetect videoconvertscale videorate
         audioconvert audioresample volume libav videoparsersbad audioparsers d3d11 d3d12 wasapi directsound)
for plugin in "${plugins[@]}"; do
  file="$PREFIX/lib/gstreamer-1.0/libgst$plugin.dll"
  if [ -f "$file" ]; then cp "$file" "$out/lib/gstreamer-1.0/"; else echo "warning: GStreamer plugin $plugin not found"; fi
done

# Every DLL from the MSYS2 prefix that the programs and plugins load (ldd is transitive).
ldd "$out/bin/uxplay.exe" "$out/libexec/gstreamer-1.0/gst-plugin-scanner.exe" "$out"/lib/gstreamer-1.0/*.dll \
  | awk -v prefix="$PREFIX/" 'index($3, prefix) == 1 { print $3 }' | sort -u \
  | while read -r dll; do cp -n "$dll" "$out/bin/"; done

cp "$work/src/LICENSE" "$out/LICENSE-UxPlay.txt"
cat > "$out/SOURCE.txt" <<EOF
UxPlay (GPLv3) is a separate program bundled with PigPort to receive AirPlay screen
mirroring on Windows. PigPort runs it as an independent process.

UxPlay source: $UXPLAY_REPO/tree/$UXPLAY_COMMIT
License: GPLv3, see LICENSE-UxPlay.txt

The DLLs in bin/ and lib/gstreamer-1.0/ are unmodified builds from MSYS2 (UCRT64):
GStreamer and its plugins (LGPL), FFmpeg via gst-libav, libplist, OpenSSL and their
dependencies. Sources: https://packages.msys2.org and https://github.com/msys2/MINGW-packages
EOF

echo "Bundled AirPlay receiver into $out ($(du -sh "$out" | cut -f1))"
