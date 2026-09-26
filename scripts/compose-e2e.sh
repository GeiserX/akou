#!/usr/bin/env bash
# akou beside Telegram-Archive, from the compose files a user runs (docs/ux/SERVER.md SV-T6).
#
#   AKOU_VERSION=ci [MODELS=/path/to/models] scripts/compose-e2e.sh note.ogg
#
# Telegram-Archive's docker-compose.yml at TA_REF, akou's compose.akou.yml as shipped in
# examples/compose/telegram-archive, and the CI layer scripts/ci/compose-e2e/compose.e2e.yml go
# into a fresh folder. The script follows SERVER.md section 12.5's one-time setup: akou comes up
# with only AKOU_BEHIND_PROXY set, an admin password and a jobs key that lists telegram-viewer are
# made inside the container, and the key and its secret go into .env. Then the whole stack comes
# up. The archive's backup service files the voice note and runs one transcription drain with its
# own code; the script passes when the viewer has stored akou's transcript from the signed
# callback, and a tampered copy of a signed delivery was refused while a genuine one was taken.
#
# The image geiserx/akou:$AKOU_VERSION must exist locally or on Docker Hub. MODELS, when set, is a
# models folder to use instead of an empty one, so no job waits on a download.
set -euo pipefail

note=${1:?usage: AKOU_VERSION=... scripts/compose-e2e.sh note.ogg}
: "${AKOU_VERSION:?AKOU_VERSION names the geiserx/akou tag to run}"
# Telegram-Archive's main with its transcription client (its PR #484); the first release that
# carries it replaces both builds with its published images.
TA_REF=${TA_REF:-10c928ad82f52ec83a7271b75a34e68423682364}
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/akou-compose-e2e.XXXXXX")
echo "work folder: $work"

curl -fsSL --retry 3 -o "$work/docker-compose.yml" \
  "https://raw.githubusercontent.com/GeiserX/Telegram-Archive/$TA_REF/docker-compose.yml"
cp "$repo/examples/compose/telegram-archive/compose.akou.yml" "$work/"
cp "$repo/scripts/ci/compose-e2e/compose.e2e.yml" "$work/"
mkdir -p "$work/e2e"
cp "$repo/scripts/ci/compose-e2e/archive-note.py" "$work/e2e/"
cp "$note" "$work/e2e/note.ogg"
chmod -R a+rX "$work/e2e"
cd "$work"

# .env from .env.example, plus the pinned commit and the viewer's login, which Telegram-Archive's
# viewer requires. set_env fills a variable the way a person edits the file.
cp "$repo/examples/compose/telegram-archive/.env.example" .env
set_env() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm .env.bak && grep -q "^$1=$2\$" .env; }
set_env AKOU_VERSION "$AKOU_VERSION"
{
  echo "TA_REF=$TA_REF"
  echo "VIEWER_USERNAME=e2e"
  echo "VIEWER_PASSWORD=$(openssl rand -hex 16)"
  # The backup never logs in to Telegram here; empty, so compose does not warn on every call.
  printf 'TELEGRAM_API_ID=\nTELEGRAM_API_HASH=\nTELEGRAM_PHONE=\n'
} >> .env

dc() { docker compose -f docker-compose.yml -f compose.akou.yml -f compose.e2e.yml "$@"; }
logs() {
  dc ps -a || true
  for s in akou telegram-viewer telegram-backup; do
    echo "--- $s"
    dc logs --no-color --tail 100 "$s" || true
  done
}
finish() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then logs; fi
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap finish EXIT

dc build telegram-backup telegram-viewer

# SERVER.md 12.5, "Set it up once".
mkdir -p akou/data akou/models data
if [ -n "${MODELS:-}" ]; then
  rmdir akou/models
  ln -s "$MODELS" akou/models
fi
sudo chown 1000:1000 akou/data akou/models data
dc up -d akou
for _ in $(seq 60); do
  if curl -fsS http://127.0.0.1:8476/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8476/healthz
echo
openssl rand -hex 16 > password.txt
dc exec -T akou akou admin set-password < password.txt
dc exec -T akou akou keys create --name archive --scope jobs --callback-host telegram-viewer --json > key.json
set_env TRANSCRIPTION_API_KEY "$(jq -r .key key.json)"
set_env TRANSCRIPTION_WEBHOOK_SECRET "$(jq -r .secret key.json)"
rm key.json password.txt

# Telegram-Archive migrates its database when its backup image starts; once, before the viewer
# opens the same file, so the two never race to create it.
dc run --rm --no-deps telegram-backup true
# The viewer first, and answering, so akou's first delivery finds it rather than its 5 s retry.
dc up -d telegram-viewer
for _ in $(seq 60); do
  if curl -s -o /dev/null http://127.0.0.1:8000/; then break; fi
  sleep 1
done
dc up -d

# The backup service runs archive-note.py and exits with its answer.
code=$(docker wait "$(dc ps -a -q telegram-backup)")
dc logs --no-color telegram-backup
if [ "$code" != 0 ]; then
  echo "the archive's round trip failed (exit $code)"
  exit 1
fi
echo "compose round trip: the archive sent a voice note, akou transcribed it, the viewer stored it from the signed callback"
