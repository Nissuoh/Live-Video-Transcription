from __future__ import annotations

import unittest
from collections.abc import Sequence

from backend.config import Settings
from backend.interfaces import TTSProvider, TTSResult, TranslationInput, TranslationProvider
from backend.pipeline import TranslationPipeline
from backend.schemas import StreamChunk, StreamRequest, TranscriptItem


class FakeTranslator(TranslationProvider):
    def __init__(self) -> None:
        self.batch_sizes: list[int] = []
        self.single_calls = 0

    async def translate(
        self,
        text: str,
        *,
        duration_seconds: float,
        target_language: str = "de",
    ) -> str:
        self.single_calls += 1
        return f"translated {text}"

    async def translate_batch(
        self,
        items: Sequence[TranslationInput],
        *,
        target_language: str = "de",
    ) -> list[str]:
        self.batch_sizes.append(len(items))
        return [f"translated {item.text}" for item in items]


class FakeTTS(TTSProvider):
    async def synthesize(
        self,
        text: str,
        *,
        target_duration_seconds: float,
        target_language: str = "de",
        voice_gender: str = "male",
        voice_pitch: str = "normal",
    ) -> TTSResult:
        return TTSResult(
            audio_bytes=f"audio:{text}".encode("utf-8"),
            mime_type="audio/mpeg",
            suggested_playback_rate=1.0,
        )


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_uses_translation_batches_and_preserves_chunk_order(self) -> None:
        translator = FakeTranslator()
        pipeline = TranslationPipeline(
            translator=translator,
            tts=FakeTTS(),
            settings=Settings(
                auth_tokens="test-token",
                translation_batch_max_items=3,
                translation_batch_max_chars=500,
                translation_batch_max_duration_seconds=60,
            ),
        )
        request = StreamRequest(
            videoId="video",
            platform="youtube",
            token="test-token",
            transcript=[
                TranscriptItem(start=0, duration=2, text="one"),
                TranscriptItem(start=2, duration=2, text="two"),
                TranscriptItem(start=4, duration=2, text="three"),
                TranscriptItem(start=6, duration=2, text="four"),
            ],
        )
        chunks: list[StreamChunk] = []

        async def send_chunk(chunk: StreamChunk) -> None:
            chunks.append(chunk)

        await pipeline.stream(request, send_chunk)

        self.assertEqual(translator.batch_sizes, [3, 1])
        self.assertEqual(translator.single_calls, 0)
        self.assertEqual([chunk.start for chunk in chunks], [0, 2, 4, 6])
        self.assertEqual([chunk.end for chunk in chunks], [2, 4, 6, 8])


if __name__ == "__main__":
    unittest.main()
