#!/usr/bin/env bash
# The macOS 14.2 or 14.3 run, the clause ROADMAP G4 had until 2026-10-10, in a tart VM on an
# Apple silicon Mac: does the process tap the capture helper records the call with deliver audio
# on macOS 14.3? The answer decides whether the 14.4 floor (`MIN_MACOS` in scripts/build-app.ts) can drop.
#
#   TART_HOME=<folder on a disk with 60 GB free> scripts/gates/g4-macos14-vm.sh <akou-capture> [out folder]
#
# <akou-capture> is the shipping helper built on the host (`cargo build --release` in
# native/akou-capture). IMAGE is a tart VM of a clean macOS 14.3, `akou-sonoma-14.3` by default:
# user admin, password admin, logged in at boot, with Remote Login on. The
# `ghcr.io/cirruslabs/macos-sonoma-vanilla:14.3` image does not do: despite its tag it boots macOS
# 14.4 (23E214), so this script refuses it. Build the VM once from Apple's restore image for 14.3
# (build 23D56), about 15 GB to download and 50 GB on disk under TART_HOME:
#
#   tart create --from-ipsw <UniversalMac_14.3_23D56_Restore.ipsw> akou-sonoma-14.3
#   tart run --vnc-experimental akou-sonoma-14.3
#
# then, in the window: Setup Assistant with account admin/admin (skip the Apple ID, Location,
# Analytics, Screen Time and Siri), and Remote Login on in System Settings, Sharing. Over SSH after
# that: log-in at boot as admin, sleep off, and automatic updates off so the guest stays 14.3
# (`softwareupdate --schedule off` and the AutomaticDownload, AutomaticCheckEnabled and
# AutomaticallyInstallMacOSUpdates keys of com.apple.SoftwareUpdate set to false). Each run clones
# IMAGE into akou-g4-macos14. Needs tart, sshpass and ffmpeg on the host. The VM gets the host's
# audio output (tart's default), so its default output device is running when something plays, as
# on a real Mac: mute the host's output before a run.
#
# Two recordings of 12 s each, through the helper with `--mic none --call system`:
#
# - tone: a 900 Hz tone (ffmpeg's sine source, about -21 dBFS RMS) plays for 6 s with `afplay`,
#   3 s in. Pass: the call channel's RMS over the whole file is above -60 dBFS.
# - silent (the positive control): nothing plays. The call channel must stay under -90 dBFS, so a
#   measure that reads every file as loud fails here.
#
# The gate passes when both hold. It fails without recording when the guest is not macOS 14.3.x,
# and fails when the helper exits non-zero in either recording, even if it left a file. The first
# run on a fresh clone shows a permission prompt for Terminal in the VM ("record your system audio"
# on the first run seen, "access the microphone" on the next) and fails with "did not finish": run
# with VNC=1, open the vnc:// address tart prints (the VM's own screen, on this Mac's loopback; from
# another Mac, an ssh tunnel to that port), click Allow, and run again (TRAPS: one pending prompt
# blocks every tap, and `afplay` with it).
#
# Writes <out>/verdict.json (with the reason), then whichever recordings and helper logs exist.
# Leaves the VM in place for a re-run, so the Allow holds; `tart delete akou-g4-macos14` removes it.
# tests/g4-macos14-vm.test.ts runs this script against stand-ins for tart, the guest and ffmpeg.
set -euo pipefail

helper="${1:?usage: g4-macos14-vm.sh <akou-capture> [out folder]}"
out="${2:-$PWD/g4-macos14}"
image="${IMAGE:-akou-sonoma-14.3}"
vm=akou-g4-macos14
: "${TART_HOME:?set TART_HOME to a folder on a disk with 60 GB free}"
for tool in tart sshpass ffmpeg; do
  command -v "$tool" >/dev/null || { echo "g4-macos14-vm: $tool is not installed" >&2; exit 69; }
done
[ -x "$helper" ] || { echo "g4-macos14-vm: $helper is not an executable" >&2; exit 64; }

share="$out/share"
# Where tart mounts that folder inside the guest; a test of this script points it at the share.
share_in_vm="${SHARE_IN_VM:-/Volumes/My Shared Files/akou}"
mkdir -p "$share"
cp "$helper" "$share/akou-capture"
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=900:sample_rate=48000:duration=6" \
  -ac 2 "$share/tone.wav"

tart list --quiet | grep -qx "$vm" || tart clone "$image" "$vm"
run_args=(--dir="akou:$share")
# --vnc-experimental is Virtualization.framework's own VNC server: it needs nothing in the guest.
[ "${VNC:-0}" = 1 ] && run_args+=(--vnc-experimental) || run_args+=(--no-graphics)
tart run "${run_args[@]}" "$vm" &
tart_pid=$!
trap 'tart stop "$vm" >/dev/null 2>&1 || true; kill "$tart_pid" 2>/dev/null || true' EXIT

ip="$(tart ip --wait 180 "$vm")"
ssh_vm() {
  sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "admin@$ip" "$@"
}
for _ in $(seq 60); do ssh_vm true 2>/dev/null && break; sleep 2; done
macos="$(ssh_vm sw_vers -productVersion)"
echo "g4-macos14-vm: the VM runs macOS $macos"
[ "${VNC:-0}" = 1 ] && echo "g4-macos14-vm: the VM's screen is the vnc:// address tart printed above"

# verdict.json, printed; exits 0 only on a pass. Recordings and logs are copied after it, so a
# helper that wrote nothing still leaves a verdict.
finish() {
  local verdict="$1" reason="$2" tone_rms="${3:-}" silent_rms="${4:-}"
  cat > "$out/verdict.json" <<EOF
{
  "gate": "G4, macOS 14.3",
  "image": "$image",
  "macos": "$macos",
  "tone_call_rms_dbfs": "$tone_rms",
  "silent_call_rms_dbfs": "$silent_rms",
  "verdict": "$verdict",
  "reason": "$reason"
}
EOF
  for f in "$share"/*.opus "$share"/*.err; do if [ -e "$f" ]; then cp "$f" "$out/"; fi; done
  cat "$out/verdict.json"
  [ "$verdict" = pass ]
  exit
}

# The question is about 14.3: any other guest answers nothing, whatever the image tag says.
case "$macos" in
  14.3 | 14.3.*) ;;
  *) finish fail "the VM runs macOS ${macos:-(unknown)}, not 14.3" ;;
esac

# One recording in the VM: the helper for 12 s (RECORD_SECONDS, which the test shortens), stopped
# on stdin as the app stops it; the tone, if any, plays from a quarter of the way in. The helper's
# own exit status is the recording's: one that exits non-zero fails it, even when it left a file.
#
# The recording runs in Terminal in the guest's console session, opened over SSH, not in the SSH
# session itself. macOS asks the process responsible for the helper for system-audio access. Over
# SSH that is sshd-keygen-wrapper, which macOS never asks: the tap opens and delivers digital zeros,
# with no prompt and no error. From Terminal, macOS shows "Terminal would like access to record your
# system audio" once, and after Allow the tap delivers the audio.
#
# The helper writes to a folder on the guest's own disk and the file is copied to the share after:
# it syncs its file with F_FULLFSYNC, which tart's shared folder refuses ("Inappropriate ioctl for
# device"), so a recording made straight onto the share never starts. Its stdout carries the live
# audio frames, which nothing here reads.
seconds="${RECORD_SECONDS:-12}"
timeout="${RECORD_TIMEOUT:-$((seconds * 2 + 30))}"
record() {
  local name="$1" play="$2"
  cat > "$share/$name.command" <<EOF
#!/bin/bash
cd "$share_in_vm" || exit 70
rm -f $name.opus $name.err
rec=\$(mktemp -d)
(sleep $seconds; echo stop) | ./akou-capture run --out "\$rec/$name.opus" --mic none --call system > /dev/null 2> $name.err &
capture=\$!
sleep $((seconds / 4)); if [ $play = yes ]; then afplay tone.wav || true; fi
wait \$capture; rc=\$?
if [ -e "\$rec/$name.opus" ]; then cp "\$rec/$name.opus" .; fi
rm -r "\${rec:?}"; echo \$rc > $name.rc
EOF
  chmod +x "$share/$name.command"
  rm -f "${share:?}/${name:?}.rc"
  ssh_vm "open -a Terminal '$share_in_vm/$name.command'"
  # The .rc file is the recording's exit status, read from the share on the host.
  for _ in $(seq "$timeout"); do [ -s "$share/$name.rc" ] && break; sleep 1; done
  if [ ! -s "$share/$name.rc" ]; then
    # By process name: a full command-line match (-f) also hits this script, whose arguments
    # name the helper, wherever host and guest are one machine (procps pkill spares only itself).
    ssh_vm "pkill -x akou-capture; pkill -x afplay" >/dev/null 2>&1 || true
    return 124
  fi
  return "$(cat "$share/$name.rc")"
}
failed="" stuck=""
for run in "tone yes" "silent no"; do
  read -r name play <<< "$run"
  rc=0
  record "$name" "$play" || rc=$?
  if [ "$rc" = 124 ]; then stuck="$stuck $name"; elif [ "$rc" != 0 ]; then failed="$failed $name"; fi
done
[ -z "$stuck" ] || finish fail "the recording did not finish in:$stuck (a permission prompt for Terminal is probably waiting in the VM: run with VNC=1, allow it, and run again)"
[ -z "$failed" ] || finish fail "the helper exited non-zero in:$failed (see the .err logs)"

# The call channel (right) RMS over the whole file, in dBFS; -inf for digital silence.
rms() {
  ffmpeg -nostats -i "$share/$1.opus" -af "pan=mono|c0=c1,astats=measure_overall=RMS_level:measure_perchannel=none" \
    -f null - 2>&1 | awk '/RMS level dB/ {print $NF}' | tail -1
}
tone_rms="$(rms tone)"
silent_rms="$(rms silent)"
verdict="$(awk -v t="$tone_rms" -v s="$silent_rms" 'BEGIN {
  tone = (t == "-inf" || t == "") ? -999 : t + 0
  quiet = (s == "-inf") ? -999 : (s == "" ? 0 : s + 0)
  print (tone > -60 && quiet < -90) ? "pass" : "fail"
}')"
finish "$verdict" "tone above -60 dBFS and silence under -90 dBFS on the call channel" "$tone_rms" "$silent_rms"
