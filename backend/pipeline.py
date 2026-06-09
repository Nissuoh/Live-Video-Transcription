from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable

from .config import Settings
from .interfaces import TTSProvider, TranslationProvider
from .pronunciation import normalize_tts_pronunciation
from .schemas import StreamChunk, StreamRequest, TranscriptItem


SendChunk = Callable[[StreamChunk], Awaitable[None]]


class TranslationPipeline:
    def __init__(
        self,
        *,
        translator: TranslationProvider,
        tts: TTSProvider,
        settings: Settings,
    ) -> None:
        self._translator = translator
        self._tts = tts
        self._settings = settings

    async def stream(self, request: StreamRequest, send_chunk: SendChunk) -> None:
        item_count = len(request.transcript)
        worker_count = min(self._settings.max_chunk_concurrency, item_count)
        work_queue: asyncio.Queue[tuple[int, TranscriptItem, str, str, str] | None] = asyncio.Queue()
        result_queue: asyncio.Queue[tuple[int, StreamChunk | None, BaseException | None]] = (
            asyncio.Queue()
        )

        for index, item in enumerate(request.transcript):
            work_queue.put_nowait(
                (index, item, request.target_language, request.voice_gender, request.voice_pitch)
            )
        for _ in range(worker_count):
            work_queue.put_nowait(None)

        workers = [
            asyncio.create_task(self._worker(work_queue, result_queue))
            for _ in range(worker_count)
        ]

        completed = 0
        next_index = 0
        pending_chunks: dict[int, StreamChunk] = {}
        try:
            while completed < item_count:
                index, chunk, error = await result_queue.get()
                completed += 1
                if error is not None:
                    raise error
                assert chunk is not None
                pending_chunks[index] = chunk
                while next_index in pending_chunks:
                    await send_chunk(pending_chunks.pop(next_index))
                    next_index += 1
        finally:
            for worker in workers:
                if not worker.done():
                    worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

    async def _worker(
        self,
        work_queue: asyncio.Queue[tuple[int, TranscriptItem, str, str, str] | None],
        result_queue: asyncio.Queue[tuple[int, StreamChunk | None, BaseException | None]],
    ) -> None:
        while True:
            work = await work_queue.get()
            if work is None:
                return
            index, item, target_language, voice_gender, voice_pitch = work
            try:
                chunk = await self._process_item(
                    item,
                    target_language=target_language,
                    voice_gender=voice_gender,
                    voice_pitch=voice_pitch,
                )
            except BaseException as exc:
                await result_queue.put((index, None, exc))
            else:
                await result_queue.put((index, chunk, None))

    async def _process_item(
        self,
        item: TranscriptItem,
        *,
        target_language: str,
        voice_gender: str,
        voice_pitch: str,
    ) -> StreamChunk:
        translated_text = await self._translator.translate(
            item.text,
            duration_seconds=item.duration,
            target_language=target_language,
        )
        spoken_text = normalize_tts_pronunciation(
            translated_text,
            target_language=target_language,
            enabled=self._settings.tts_pronunciation_enabled,
            english_initialisms=self._settings.english_initialism_values,
        )
        speech = await self._tts.synthesize(
            spoken_text,
            target_duration_seconds=item.duration,
            target_language=target_language,
            voice_gender=voice_gender,
            voice_pitch=voice_pitch,
        )
        audio_base64 = base64.b64encode(speech.audio_bytes).decode("ascii")
        return StreamChunk(
            start=item.start,
            end=item.start + item.duration,
            audioBase64=audio_base64,
            suggestedPlaybackRate=speech.suggested_playback_rate,
        )
