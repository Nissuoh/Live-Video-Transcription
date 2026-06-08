from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: Literal["production", "development", "test"] = "production"
    require_wss: bool = True
    websocket_allowed_origins: str = (
        "https://www.youtube.com,https://youtube.com,https://m.youtube.com,chrome-extension://*"
    )

    auth_tokens: str = Field(min_length=1)
    translation_provider: Literal["openai", "deepl"] = "openai"
    tts_provider: Literal["openai", "elevenlabs"] = "openai"

    max_chunk_concurrency: int = Field(default=3, ge=1, le=16)
    max_transcript_items: int = Field(default=2000, ge=1, le=20000)
    max_text_chars_per_chunk: int = Field(default=4000, ge=1, le=20000)
    provider_timeout_seconds: float = Field(default=45.0, gt=0, le=300)
    provider_max_retries: int = Field(default=2, ge=0, le=5)
    provider_retry_base_delay_seconds: float = Field(default=0.4, gt=0, le=10)
    rate_limit_connections_per_minute: int = Field(default=30, ge=1, le=10000)
    rate_limit_chunks_per_minute: int = Field(default=3000, ge=1, le=100000)

    openai_api_key: SecretStr | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_translation_model: str = "gpt-4o-mini"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "coral"
    openai_tts_response_format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = "mp3"
    openai_tts_instructions: str = (
        "Sprich klares, natuerliches Deutsch mit ruhiger Synchronisationsgeschwindigkeit."
    )
    openai_max_output_tokens: int = Field(default=220, ge=16, le=2000)
    openai_temperature: float = Field(default=0.2, ge=0, le=2)

    deepl_api_key: SecretStr | None = None
    deepl_api_base: str = "https://api.deepl.com"
    deepl_target_lang: str = "DE"

    elevenlabs_api_key: SecretStr | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str = "eleven_multilingual_v2"
    elevenlabs_output_format: str = "mp3_44100_128"
    elevenlabs_language_code: str = "de"

    duration_guard_chars_per_second: float = Field(default=14.0, gt=1, le=40)
    tts_max_playback_rate: float = Field(default=1.35, ge=1.0, le=4.0)

    @field_validator("openai_base_url", "deepl_api_base")
    @classmethod
    def strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def auth_token_values(self) -> tuple[str, ...]:
        tokens = tuple(token.strip() for token in self.auth_tokens.split(",") if token.strip())
        if not tokens:
            raise ValueError("AUTH_TOKENS must contain at least one non-empty token")
        return tokens

    @property
    def allowed_origin_patterns(self) -> tuple[str, ...]:
        return tuple(
            origin.strip()
            for origin in self.websocket_allowed_origins.split(",")
            if origin.strip()
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
