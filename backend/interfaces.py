from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


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


class TTSProvider(ABC):
    @abstractmethod
    async def synthesize(
        self,
        text: str,
        *,
        target_duration_seconds: float,
    ) -> TTSResult:
        """Return encoded speech audio for the translated text."""
