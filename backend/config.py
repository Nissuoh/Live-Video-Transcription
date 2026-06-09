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
    translation_provider: Literal["openai", "deepl", "openrouter"] = "openai"
    tts_provider: Literal[
        "openai",
        "elevenlabs",
        "edge_tts",
        "gemini",
        "windows_sapi",
        "piper",
    ] = "openai"

    max_chunk_concurrency: int = Field(default=1, ge=1, le=16)
    max_transcript_items: int = Field(default=2000, ge=1, le=20000)
    max_text_chars_per_chunk: int = Field(default=4000, ge=1, le=20000)
    provider_timeout_seconds: float = Field(default=45.0, gt=0, le=300)
    provider_max_retries: int = Field(default=4, ge=0, le=5)
    provider_retry_base_delay_seconds: float = Field(default=1.0, gt=0, le=10)
    rate_limit_connections_per_minute: int = Field(default=30, ge=1, le=10000)
    rate_limit_chunks_per_minute: int = Field(default=3000, ge=1, le=100000)

    openai_api_key: SecretStr | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_translation_model: str = "gpt-4o-mini"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "coral"
    openai_tts_male_voice: str = "onyx"
    openai_tts_female_voice: str = "coral"
    openai_tts_response_format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = "mp3"
    openai_tts_instructions: str = (
        "Sprich klares, natuerliches Hochdeutsch mit ruhiger Synchronisationsgeschwindigkeit. "
        "Englische Akronyme, Agenturnamen und Tech-Begriffe wie CIA, FBI, NSA, AI, API, GPU, "
        "URL, VPN, USB, HTML und HTTPS werden auf Englisch ausgesprochen oder buchstabiert. "
        "Eigennamen und Produktnamen nicht eindeutschen."
    )
    openai_max_output_tokens: int = Field(default=220, ge=16, le=2000)
    openai_temperature: float = Field(default=0.2, ge=0, le=2)

    deepl_api_key: SecretStr | None = None
    deepl_api_base: str = "https://api.deepl.com"
    deepl_target_lang: str = "DE"

    openrouter_api_key: SecretStr | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "openai/gpt-4o-mini"
    openrouter_site_url: str | None = None
    openrouter_app_name: str = "Live Video Translation"
    openrouter_max_tokens: int = Field(default=220, ge=16, le=2000)
    openrouter_temperature: float = Field(default=0.2, ge=0, le=2)

    elevenlabs_api_key: SecretStr | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str = "eleven_multilingual_v2"
    elevenlabs_output_format: str = "mp3_44100_128"
    elevenlabs_language_code: str = "de"

    edge_tts_male_voice: str = "de-DE-ConradNeural"
    edge_tts_female_voice: str = "de-DE-KatjaNeural"
    edge_tts_default_voice: str = "de-DE-ConradNeural"
    edge_tts_rate: str = "+0%"
    edge_tts_volume: str = "+0%"
    edge_tts_pitch_normal: str = "+0Hz"
    edge_tts_pitch_low: str = "-25Hz"
    edge_tts_pitch_high: str = "+25Hz"

    gemini_api_key: SecretStr | None = None
    gemini_tts_model: str = "gemini-2.5-flash-tts"
    gemini_tts_male_voice: str = "Puck"
    gemini_tts_female_voice: str = "Kore"
    gemini_tts_sample_rate: int = Field(default=24000, ge=8000, le=48000)
    gemini_tts_instructions: str = (
        "Sprich klares, natuerliches Hochdeutsch. Englische Akronyme, Agenturnamen "
        "und Tech-Begriffe wie CIA, FBI, NSA, AI, API, GPU, URL, VPN, USB, HTML "
        "und HTTPS werden auf Englisch ausgesprochen oder buchstabiert. Eigennamen "
        "und Produktnamen nicht eindeutschen."
    )

    piper_exe_path: str | None = None
    piper_model_path: str | None = None
    piper_config_path: str | None = None
    piper_male_model_path: str | None = None
    piper_male_config_path: str | None = None
    piper_female_model_path: str | None = None
    piper_female_config_path: str | None = None
    piper_speaker_id: int | None = None
    piper_sentence_silence_seconds: float = Field(default=0.05, ge=0, le=2)
    piper_length_scale: float = Field(default=1.0, gt=0, le=3)
    piper_min_length_scale: float = Field(default=0.72, gt=0, le=3)
    piper_max_length_scale: float = Field(default=1.15, gt=0, le=3)
    piper_estimated_chars_per_second: float = Field(default=18.0, gt=1, le=60)
    piper_noise_scale: float = Field(default=0.667, ge=0, le=2)
    piper_noise_w: float = Field(default=0.8, ge=0, le=2)

    windows_sapi_voice: str | None = None
    windows_sapi_gender: Literal["male", "female", "neutral", "any"] = "male"
    windows_sapi_rate: int = Field(default=0, ge=-10, le=10)

    duration_guard_chars_per_second: float = Field(default=14.0, gt=1, le=40)
    tts_max_playback_rate: float = Field(default=1.35, ge=1.0, le=4.0)
    tts_pronunciation_enabled: bool = True
    tts_pronunciation_mode: Literal["auto", "phonetic", "none"] = "auto"
    tts_english_initialisms: str = (
        "ADHD,AGI,AI,API,AR,BIOS,CIA,CPU,CSS,CTO,FBI,FPS,GPU,HTML,HTTP,HTTPS,"
        "IT,JSON,LLM,ML,NATO,NSA,OS,PDF,RAM,REST,SQL,UI,UK,URL,US,USA,USB,"
        "UX,VPN,VR,XML"
    )

    @field_validator("openai_base_url", "deepl_api_base", "openrouter_base_url")
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

    @property
    def english_initialism_values(self) -> tuple[str, ...]:
        return tuple(
            value.strip().upper().replace(".", "")
            for value in self.tts_english_initialisms.split(",")
            if value.strip()
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
