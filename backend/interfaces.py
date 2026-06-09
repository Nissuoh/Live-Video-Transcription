from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TranslationInput:
    text: str
    duration_seconds: float


@dataclass(frozen=True, slots=True)
class TTSResult:
    audio_bytes: bytes
    mime_type: str
    suggested_playback_rate: float


class TranslationProvider(ABC):
    @abstractmethod
    async def translate(
        self,
        text: str,
        *,
        duration_seconds: float,
        target_language: str = "de",
    ) -> str:
        """Return translated, duration-aware text for a transcript chunk."""

    async def translate_batch(
        self,
        items: Sequence[TranslationInput],
        *,
        target_language: str = "de",
    ) -> list[str]:
        """Return translated, duration-aware text for multiple transcript chunks."""
        return [
            await self.translate(
                item.text,
                duration_seconds=item.duration_seconds,
                target_language=target_language,
            )
            for item in items
        ]


class TTSProvider(ABC):
    @abstractmethod
    async def synthesize(
        self,
        text: str,
        *,
        target_duration_seconds: float,
        target_language: str = "de",
        voice_gender: str = "male",
        voice_pitch: str = "normal",
    ) -> TTSResult:
        """Return encoded speech audio for the translated text."""
