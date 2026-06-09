from __future__ import annotations

import base64
from collections.abc import Awaitable, Callable

from .config import Settings
from .interfaces import TTSProvider, TranslationInput, TranslationProvider
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
        for batch in self._translation_batches(request.transcript):
            translations = await self._translator.translate_batch(
                [
                    TranslationInput(text=item.text, duration_seconds=item.duration)
                    for item in batch
                ],
                target_language=request.target_language,
            )
            if len(translations) != len(batch):
                raise ValueError("translation provider returned an unexpected batch size")
            for item, translated_text in zip(batch, translations, strict=True):
                chunk = await self._process_translated_item(
                    item,
                    translated_text=translated_text,
                    target_language=request.target_language,
                    voice_gender=request.voice_gender,
                    voice_pitch=request.voice_pitch,
                )
                await send_chunk(chunk)

    def _translation_batches(self, transcript: list[TranscriptItem]) -> list[list[TranscriptItem]]:
        batches: list[list[TranscriptItem]] = []
        current: list[TranscriptItem] = []
        current_chars = 0
        current_duration = 0.0

        for item in transcript:
            item_chars = len(item.text)
            would_exceed = (
                len(current) >= self._settings.translation_batch_max_items
                or current_chars + item_chars > self._settings.translation_batch_max_chars
                or current_duration + item.duration
                > self._settings.translation_batch_max_duration_seconds
            )
            if current and would_exceed:
                batches.append(current)
                current = []
                current_chars = 0
                current_duration = 0.0

            current.append(item)
            current_chars += item_chars
            current_duration += item.duration

        if current:
            batches.append(current)
        return batches

    async def _process_translated_item(
        self,
        item: TranscriptItem,
        *,
        translated_text: str,
        target_language: str,
        voice_gender: str,
        voice_pitch: str,
    ) -> StreamChunk:
        spoken_text = normalize_tts_pronunciation(
            translated_text,
            target_language=target_language,
            tts_provider=self._settings.tts_provider,
            enabled=self._settings.tts_pronunciation_enabled,
            mode=self._settings.tts_pronunciation_mode,
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
