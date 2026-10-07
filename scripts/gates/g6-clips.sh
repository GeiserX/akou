#!/usr/bin/env bash
# ROADMAP G6, the speech clips: synthesizes the 24 sentences in g6-sentences.txt (one per line,
# s01 to s24) with macOS `say`, then converts each to raw 32-bit float mono, 16 kHz for
# g6-asr-speed.ts and 48 kHz for g6-live-latency.ts. No audio is committed; run this to make it.
#
#   scripts/gates/g6-clips.sh <out folder> [voice]
#
# Writes <out>/16k/sNN.f32 and <out>/48k/sNN.f32 (and keeps <out>/aiff/sNN.aiff). The voice
# defaults to Samantha (en_US). `say -o` writes a file and plays nothing. Needs macOS and ffmpeg.
set -euo pipefail
out="${1:?usage: g6-clips.sh <out folder> [voice]}"
voice="${2:-Samantha}"
list="$(dirname "$0")/g6-sentences.txt"
mkdir -p "$out/aiff" "$out/16k" "$out/48k"
n=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  n=$((n + 1))
  id=$(printf 's%02d' "$n")
  say -v "$voice" -o "$out/aiff/$id.aiff" "$line"
  for rate in 16000 48000; do
    ffmpeg -nostdin -loglevel error -y -i "$out/aiff/$id.aiff" -ac 1 -ar "$rate" -f f32le \
      "$out/$((rate / 1000))k/$id.f32"
  done
done <"$list"
echo "$n clips in $out (voice $voice)"
