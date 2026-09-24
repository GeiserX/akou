#!/bin/sh
# Writes akou's two usage strings into a built app's Info.plist (docs/DESIGN.md section 9, TRAPS
# "Info.plist cannot carry the system-audio usage string"). Hutch writes Info.plist from a fixed
# table without NSAudioCaptureUsageDescription, and without it macOS never asks for the System Audio
# Recording grant: the call channel records silence with no error. The postWrap hook runs this before
# the bundle is signed, so the signature covers the patched file.
#
#   scripts/patch-plist.sh path/to/akou.app      (or a path to an Info.plist)
#
# Exit 66 when there is no Info.plist, 70 when a key is still missing afterwards.
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

/usr/bin/plutil -replace NSMicrophoneUsageDescription -string "$MIC" "$plist"
/usr/bin/plutil -replace NSAudioCaptureUsageDescription -string "$AUDIO" "$plist"
/usr/bin/plutil -lint "$plist" >/dev/null

for key in NSMicrophoneUsageDescription NSAudioCaptureUsageDescription; do
  if ! /usr/bin/plutil -extract "$key" raw "$plist" >/dev/null 2>&1; then
    echo "patch-plist: $key is still missing from $plist" >&2
    exit 70
  fi
done
echo "patch-plist: usage strings written to $plist"
