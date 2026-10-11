"""SV-T4: akou's Wyoming listener as the `wyoming` package's client sees it.

Line 1 is the `info` answer to `describe`, as JSON. Line 2 is the transcript of the WAV, sent as
Home Assistant sends an utterance: `transcribe {language}`, `audio-start`, chunks, `audio-stop`.
The WAV must be in Home Assistant's fixed format, 16000 Hz, 16-bit, mono, since `wav_to_chunks`
sends the file's own format and anything else would test a path Home Assistant never takes.
Exits 2 when the WAV is in another format, 1 on an `error` event, on a connection that closes
first, or when it cannot connect.
"""

import argparse
import asyncio
import json
import sys
import wave

from wyoming.asr import Transcribe, Transcript
from wyoming.audio import wav_to_chunks
from wyoming.client import AsyncTcpClient
from wyoming.error import Error
from wyoming.info import Describe, Info


async def read_until(client: AsyncTcpClient, want: str):
    while True:
        event = await client.read_event()
        if event is None:
            sys.exit(f"the server closed the connection before {want}")
        if Error.is_type(event.type):
            err = Error.from_event(event)
            sys.exit(f"error {err.code}: {err.text}")
        if event.type == want:
            return event


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=10300)
    p.add_argument("--language", default=None)
    p.add_argument("--wav", required=True)
    a = p.parse_args()
    with wave.open(a.wav, "rb") as w:
        got = (w.getframerate(), w.getsampwidth(), w.getnchannels())
    if got != (16000, 2, 1):
        rate, width, channels = got
        print(
            f"{a.wav} is {rate} Hz, {width * 8}-bit, {channels} channels;"
            " Home Assistant sends 16000 Hz, 16-bit, mono",
            file=sys.stderr,
        )
        sys.exit(2)
    timeouts = {"connect_timeout": 10, "read_timeout": 600}
    async with AsyncTcpClient(a.host, a.port, **timeouts) as client:
        await client.write_event(Describe().event())
        info = Info.from_event(await read_until(client, "info"))
        print(json.dumps(info.to_dict()), flush=True)
    async with AsyncTcpClient(a.host, a.port, **timeouts) as client:
        await client.write_event(Transcribe(language=a.language).event())
        with wave.open(a.wav, "rb") as w:
            for event in wav_to_chunks(w, 1024, start_event=True, stop_event=True):
                await client.write_event(event.event())
        print(Transcript.from_event(await read_until(client, "transcript")).text, flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except OSError as e:
        sys.exit(f"cannot reach the Wyoming server: {e}")
