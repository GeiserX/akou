#!/bin/sh
# Writes what Hutch's fixed Info.plist table leaves out into a built app's Info.plist (docs/DESIGN.md
# section 9, TRAPS "Info.plist cannot carry the system-audio usage string"):
#
# - the two usage strings: without NSAudioCaptureUsageDescription macOS never asks for the System
#   Audio Recording grant, and the call channel records silence with no error;
# - CFBundleShortVersionString, copied from the CFBundleVersion Hutch writes, so Finder and the About
#   panel show the version;
# - LSMinimumSystemVersion 14.4 (MIN_MACOS in build-app.ts), so an older Mac refuses the app with its
#   own "requires macOS 14.4" dialog instead of opening it and failing at the first recording.
#
# The postBuild and postWrap hooks run this before each bundle is signed, so the signature covers the
# patched file.
#
#   scripts/patch-plist.sh path/to/akou.app      (or a path to an Info.plist)
#
# Exit 66 when there is no Info.plist, 70 when there is no CFBundleVersion to copy or a key is still
# missing afterwards.
set -eu

target="${1:?usage: patch-plist.sh APP_BUNDLE_OR_INFO_PLIST}"
case "$target" in
  *.plist) plist="$target" ;;
  *) plist="$target/Contents/Info.plist" ;;
esac
if [ ! -f "$plist" ]; then
  echo "patch-plist: no Info.plist at $plist" >&2
  exit 66
fi

MIC="akou records your microphone, on its own channel, during the calls you choose to record."
AUDIO="akou records the call audio your computer plays, on its own channel, during the calls you choose to record."
MIN_MACOS="14.4"

if ! VERSION=$(/usr/bin/plutil -extract CFBundleVersion raw "$plist" 2>/dev/null) || [ -z "$VERSION" ]; then
  echo "patch-plist: no CFBundleVersion in $plist to show as the version" >&2
  exit 70
fi

/usr/bin/plutil -replace NSMicrophoneUsageDescription -string "$MIC" "$plist"
/usr/bin/plutil -replace NSAudioCaptureUsageDescription -string "$AUDIO" "$plist"
/usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$plist"
/usr/bin/plutil -replace LSMinimumSystemVersion -string "$MIN_MACOS" "$plist"
/usr/bin/plutil -lint "$plist" >/dev/null

for key in NSMicrophoneUsageDescription NSAudioCaptureUsageDescription CFBundleShortVersionString LSMinimumSystemVersion; do
  if ! /usr/bin/plutil -extract "$key" raw "$plist" >/dev/null 2>&1; then
    echo "patch-plist: $key is still missing from $plist" >&2
    exit 70
  fi
done
echo "patch-plist: usage strings, version $VERSION and macOS $MIN_MACOS written to $plist"
