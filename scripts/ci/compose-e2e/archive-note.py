"""The archive's half of the compose round trip (docs/ux/SERVER.md SV-T6).

Runs inside Telegram-Archive's own backup image, with its own code: it files one
voice note the way a backup does (a chat, a message, a downloaded media row and
the file under the media folder), then runs one transcription drain, which sends
the note to akou. It never drains again, so the only way the transcript row can
turn ``done`` afterwards is akou's signed callback reaching the viewer, which
stores it. Exits 0 when that happens with the spoken sentence, 1 otherwise.

It is the backup service's command in compose.e2e.yml; scripts/compose-e2e.sh runs it.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import shutil
import sys
import time
from datetime import datetime

import httpx

from src.config import Config
from src.db import close_database, get_adapter, init_database
from src.transcription import drain_transcriptions

CHAT = -1000000000001
MESSAGE = 1
ACCOUNT = 1
MEDIA = f"{CHAT}_{MESSAGE}_voice"
SPOKEN = "ask not what your country"
WAIT_S = 300
CALLBACK = "http://telegram-viewer:8000/api/transcriptions/callback"


async def tampered_refused(secret: str) -> bool:
    """The positive control: a delivery signed with the key's secret is accepted, and the same
    delivery with one byte of its body changed is refused, so the viewer's 204 above was earned by
    the signature and not given to anything that reaches the route. The control names a hash no
    row carries, so the genuine copy writes nothing."""
    key = base64.b64decode(secret.removeprefix("whsec_"))
    body = json.dumps(
        {
            "type": "transcription.completed",
            "data": {
                "job_id": "job_control",
                "status": "done",
                "text": "control",
                "metadata": {"content_hash": "0" * 64},
            },
        }
    ).encode()
    stamp = str(int(time.time()))

    async def post(msg_id: str, raw: bytes, signed: bytes) -> int:
        sig = base64.b64encode(hmac.new(key, f"{msg_id}.{stamp}.".encode() + signed, hashlib.sha256).digest()).decode()
        headers = {"webhook-id": msg_id, "webhook-timestamp": stamp, "webhook-signature": f"v1,{sig}"}
        async with httpx.AsyncClient(timeout=10) as client:
            return (await client.post(CALLBACK, content=raw, headers=headers)).status_code

    genuine = await post("msg_control_genuine", body, body)
    tampered = await post("msg_control_tampered", body.replace(b"control", b"contr0l", 1), body)
    print(f"control: genuine {genuine}, tampered {tampered}")
    return genuine == 204 and tampered == 401


async def main(note: str) -> int:
    config = Config()
    await init_database()
    db = await get_adapter()
    try:
        rel = f"{CHAT}/{MEDIA}.ogg"
        dest = os.path.join(config.media_path, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(note, dest)
        with open(dest, "rb") as f:
            content_hash = hashlib.sha256(f.read()).hexdigest()
        await db.upsert_chat({"id": CHAT, "type": "private", "title": "compose e2e"}, account_id=ACCOUNT)
        await db.insert_message(
            {"id": MESSAGE, "chat_id": CHAT, "text": "", "date": datetime(2026, 1, 1, 12), "raw_data": {}},
            account_id=ACCOUNT,
        )
        await db.insert_media(
            {
                "id": MEDIA,
                "message_id": MESSAGE,
                "chat_id": CHAT,
                "type": "voice",
                "file_path": rel,
                "downloaded": True,
                "duration": 12,
                "content_hash": content_hash,
                "download_date": datetime(2026, 1, 1, 12),
            },
            account_id=ACCOUNT,
        )

        stats = await drain_transcriptions(config, db, account_id=ACCOUNT)
        print(f"drain: {stats}")
        if stats.get("submitted") != 1:
            print("the archive did not submit the voice note as an akou job")
            return 1

        # No second drain: the event feed and the straggler poll never run, so a done row
        # can only come from the viewer's callback route.
        deadline = time.monotonic() + WAIT_S
        row = None
        while time.monotonic() < deadline:
            rows = await db.list_media_transcripts(MEDIA, account_id=ACCOUNT)
            row = rows[0] if rows else None
            if row and row["status"] not in ("queued", "running"):
                break
            await asyncio.sleep(1)
        if not row or row["status"] != "done":
            print(f"no transcript from the callback within {WAIT_S} s: {row and row['status']}")
            return 1
        heard = "".join(c for c in (row.get("text") or "").lower() if c.isalpha() or c == " ")
        print(f"callback stored: source={row.get('source')} job={row.get('job_id')} text={row.get('text')!r}")
        if row.get("source") != "akou" or not row.get("job_id"):
            print("the stored row did not come from an akou job")
            return 1
        if SPOKEN not in heard:
            print("the transcript is not the spoken sentence")
            return 1
        if not await tampered_refused(os.environ["TRANSCRIPTION_WEBHOOK_SECRET"]):
            print("the viewer did not refuse a tampered delivery while accepting a genuine one")
            return 1
        return 0
    finally:
        await close_database()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1])))
