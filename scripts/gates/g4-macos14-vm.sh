#!/usr/bin/env bash
# ROADMAP G4, the macOS 14.2 or 14.3 clause, in a tart VM on an Apple silicon Mac: does the
# process tap the capture helper records the call with deliver audio on macOS 14.3? The answer
# decides whether the 14.4 floor (`MIN_MACOS` in scripts/build-app.ts) can drop.
#
#   TART_HOME=<folder on a disk with 80 GB free> scripts/gates/g4-macos14-vm.sh <akou-capture> [out folder]
#
# <akou-capture> is the shipping helper built on the host (`cargo build --release` in
# native/akou-capture). The VM is `ghcr.io/cirruslabs/macos-sonoma-vanilla:14.3` (override with
# IMAGE), a clean 14.3 whose user is admin, password admin, with SSH on. The first run pulls about
# 25 GB, and the clone takes about 50 GB under TART_HOME, so put TART_HOME on a disk with room.
# Needs tart, sshpass and ffmpeg on the host. The VM gets the host's audio output (tart's default),
# so its default output device is running when something plays, as on a real Mac.
#
# Two recordings of 12 s each, through the helper started over SSH with `--mic none --call system`:
#
# - tone: a 900 Hz tone (ffmpeg's sine source, about -21 dBFS RMS) plays for 6 s with `afplay`,
#   3 s in. Pass: the call channel's RMS over the whole file is above -60 dBFS.
# - silent (the positive control): nothing plays. The call channel must stay under -90 dBFS, so a
#   measure that reads every file as loud fails here.
#
# The gate passes when both hold. It fails without recording when the guest is not macOS 14.3.x,
# and fails when the helper exits non-zero in either recording, even if it left a file. A tone run that reads silent with a `warn open` line in its log
# usually means the system-audio prompt is waiting in the VM: run with VNC=1, connect to the
# address printed, allow the prompt once, and run again (TRAPS: one pending prompt blocks every tap).
#
# Writes <out>/verdict.json (with the reason), then whichever recordings and helper logs exist.
# Leaves the VM in place for a re-run; `tart delete akou-g4-macos14` removes it.
# tests/g4-macos14-vm.test.ts runs this script against stand-ins for tart, the guest and ffmpeg.
set -euo pipefail

helper="${1:?usage: g4-macos14-vm.sh <akou-capture> [out folder]}"
out="${2:-$PWD/g4-macos14}"
image="${IMAGE:-ghcr.io/cirruslabs/macos-sonoma-vanilla:14.3}"
vm=akou-g4-macos14
: "${TART_HOME:?set TART_HOME to a folder on a disk with 80 GB free}"
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
[ "${VNC:-0}" = 1 ] && run_args+=(--vnc) || run_args+=(--no-graphics)
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
[ "${VNC:-0}" = 1 ] && echo "g4-macos14-vm: VNC at vnc://$ip (admin, admin)"

# verdict.json, printed; exits 0 only on a pass. Recordings and logs are copied after it, so a
# helper that wrote nothing still leaves a verdict.
finish() {
  local verdict="$1" reason="$2" tone_rms="${3:-}" silent_rms="${4:-}"
  cat > "$out/verdict.json" <<EOF
{
  "gate": "G4, macOS 14.2 or 14.3",
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
# on stdin as the app stops it; the tone, if any, plays from a quarter of the way in. The helper's own exit status is the recording's: one that exits
# non-zero fails it, even when it left a file.
seconds="${RECORD_SECONDS:-12}"
record() {
  local name="$1" play="$2"
  ssh_vm "cd '$share_in_vm' && rm -f $name.opus $name.err &&
    { (sleep $seconds; echo stop) | ./akou-capture run --out $name.opus --mic none --call system 2> $name.err & capture=\$!; } &&
    sleep $((seconds / 4)) && { [ $play = yes ] && afplay tone.wav || true; } && wait \$capture"
}
failed=""
record tone yes || failed="$failed tone"
record silent no || failed="$failed silent"
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
