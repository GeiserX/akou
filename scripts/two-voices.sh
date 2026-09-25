#!/usr/bin/env bash
# Generates tests/fixtures/two-voices.wav and .json, the speech the diarize CI smoke
# (scripts/diarize-smoke.ts) runs through the real Nemotron model: four sentences in two
# eSpeak NG voices taking turns, 0.8 s apart, 16 kHz mono 16-bit. The JSON holds where each
# sentence sits, in seconds. Synthetic speech, so the repository carries no recording.
#
# eSpeak NG 1.52 with its klatt voices, a low one and a high one: the model tells these two apart
# (two plainer voice pairs came out as one speaker), and hears one speaker when a single voice
# says all four sentences.
#
#   scripts/two-voices.sh [out-dir] [voice ...]      needs espeak-ng and ffmpeg
set -euo pipefail

out=${1:-"$(dirname "$0")/../tests/fixtures"}
shift || true
voices=("$@")
[ ${#voices[@]} -gt 0 ] || voices=("en-us+klatt2:25" "en-gb+klatt4:90")

sentences=(
  "Good morning everyone, thanks for joining the weekly planning call today."
  "Thanks. I finished the migration yesterday and the new cluster is already serving traffic."
  "Great. Can you write down the steps so the rest of the team can repeat them next week?"
  "Sure, I will put the notes in the shared folder before lunch and send you the link."
)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

inputs=()
filters=""
spans=""
at=0.8
for i in 0 1 2 3; do
  v=${voices[$((i % ${#voices[@]}))]}
  espeak-ng -v "${v%%:*}" -p "${v##*:}" -s 160 -w "$work/$i.wav" "${sentences[$i]}"
  ffmpeg -loglevel error -y -i "$work/$i.wav" -ar 16000 -ac 1 -c:a pcm_s16le "$work/r$i.wav"
  inputs+=(-i "$work/r$i.wav")
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/r$i.wav")
  end=$(echo "$at + $d" | bc -l)
  spans+=$(printf '%s[%g, %g]' "${spans:+, }" "$at" "$end")
  at=$(echo "$end + 0.8" | bc -l)
  filters+="[$i]apad=pad_dur=0.8[a$i];"
done

ffmpeg -loglevel error -y "${inputs[@]}" \
  -filter_complex "${filters}[a0][a1][a2][a3]concat=n=4:v=0:a=1,adelay=800" \
  -ar 16000 -ac 1 -c:a pcm_s16le -bitexact "$out/two-voices.wav"
printf '{ "sentences": [%s] }\n' "$spans" > "$out/two-voices.json"
echo "wrote $out/two-voices.wav and $out/two-voices.json"
