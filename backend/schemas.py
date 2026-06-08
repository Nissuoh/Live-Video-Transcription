from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TranscriptItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: float = Field(ge=0)
    duration: float = Field(gt=0, le=120)
    text: str = Field(min_length=1, max_length=4000)

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("text must not be blank")
        return normalized


class StreamRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    video_id: str = Field(alias="videoId", min_length=1, max_length=128)
    platform: Literal["youtube"]
    token: str = Field(min_length=1, max_length=4096)
    source_language: str = Field(default="en", alias="sourceLanguage", min_length=2, max_length=16)
    target_language: str = Field(default="de", alias="targetLanguage", min_length=2, max_length=16)
    transcript: list[TranscriptItem] = Field(min_length=1)

    @field_validator("source_language", "target_language")
    @classmethod
    def normalize_language_code(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("language code must not be blank")
        return normalized


class StreamChunk(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    start: float = Field(ge=0)
    end: float = Field(gt=0)
    audio_base64: str = Field(alias="audioBase64", min_length=1)
    suggested_playback_rate: float = Field(alias="suggestedPlaybackRate", ge=0.25, le=4.0)


class HealthResponse(BaseModel):
    status: Literal["ok"]
    translation_provider: str
    tts_provider: str
