from __future__ import annotations

import math
import asyncio
from typing import Any

import httpx

from .config import Settings
from .interfaces import TTSProvider, TTSResult, TranslationProvider


class ProviderConfigurationError(RuntimeError):
    pass


class ProviderRequestError(RuntimeError):
    pass


def _secret_value(value: Any, name: str) -> str:
    if value is None:
        raise ProviderConfigurationError(f"{name} is required for the selected provider")
    secret = value.get_secret_value() if hasattr(value, "get_secret_value") else str(value)
    if not secret.strip():
        raise ProviderConfigurationError(f"{name} must not be empty")
    return secret


def _clean_output(value: str) -> str:
    text = " ".join(value.strip().split())
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        text = text[1:-1].strip()
    if not text:
        raise ProviderRequestError("Provider returned empty text")
    return text


def _estimated_speech_seconds(text: str, chars_per_second: float) -> float:
    return max(0.25, len(text) / chars_per_second)


def _bounded_rate(value: float, maximum: float) -> float:
    if not math.isfinite(value):
        return 1.0
    return max(1.0, min(maximum, value))


def _duration_guard(text: str, duration_seconds: float, chars_per_second: float) -> str:
    max_chars = max(24, int(duration_seconds * chars_per_second))
    normalized = _clean_output(text)
    if len(normalized) <= max_chars:
        return normalized
    clipped = normalized[:max_chars].rsplit(" ", 1)[0].strip(" ,;:-")
    return clipped or normalized[:max_chars].strip()


async def _raise_for_provider_error(provider: str, response: httpx.Response) -> None:
    if response.is_success:
        return
    body = response.text[:1000]
    raise ProviderRequestError(
        f"{provider} request failed with HTTP {response.status_code}: {body}"
    )


async def _post_with_retries(
    provider: str,
    client: httpx.AsyncClient,
    settings: Settings,
    url: str,
    **kwargs: Any,
) -> httpx.Response:
    retry_statuses = {429, 500, 502, 503, 504}
    last_error: Exception | None = None
    for attempt in range(settings.provider_max_retries + 1):
        try:
            response = await client.post(url, **kwargs)
            if response.status_code not in retry_statuses or attempt >= settings.provider_max_retries:
                return response
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            last_error = exc
            if attempt >= settings.provider_max_retries:
                raise ProviderRequestError(f"{provider} request failed: {exc}") from exc
        await asyncio.sleep(settings.provider_retry_base_delay_seconds * (2**attempt))
    if last_error is not None:
        raise ProviderRequestError(f"{provider} request failed: {last_error}") from last_error
    raise ProviderRequestError(f"{provider} request failed after retries")


def _extract_openai_response_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return _clean_output(output_text)

    fragments: list[str] = []
    for output_item in payload.get("output", []):
        if not isinstance(output_item, dict):
            continue
        for content in output_item.get("content", []):
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if isinstance(text, str):
                fragments.append(text)
    if fragments:
        return _clean_output(" ".join(fragments))
    raise ProviderRequestError("OpenAI response did not contain text output")


class OpenAITranslator(TranslationProvider):
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client
        self._api_key = _secret_value(settings.openai_api_key, "OPENAI_API_KEY")

    async def translate(
        self,
        text: str,
        *,
        duration_seconds: float,
        target_language: str = "de",
    ) -> str:
        prompt = (
            "\u00dcbersetze ins Deutsche. "
            f"Komprimiere semantisch, sodass die Sprechdauer {duration_seconds:.2f} Sekunden "
            "nicht \u00fcberschreitet. Nur nackter Output."
        )
        response = await _post_with_retries(
            "OpenAI translation",
            self._client,
            self._settings,
            f"{self._settings.openai_base_url}/responses",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={
                "model": self._settings.openai_translation_model,
                "instructions": prompt,
                "input": [
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": text}],
                    }
                ],
                "temperature": self._settings.openai_temperature,
                "max_output_tokens": self._settings.openai_max_output_tokens,
            },
            timeout=self._settings.provider_timeout_seconds,
        )
        await _raise_for_provider_error("OpenAI translation", response)
        translated = _extract_openai_response_text(response.json())
        return _duration_guard(
            translated,
            duration_seconds,
            self._settings.duration_guard_chars_per_second,
        )


class DeepLTranslator(TranslationProvider):
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client
        self._api_key = _secret_value(settings.deepl_api_key, "DEEPL_API_KEY")

    async def translate(
        self,
        text: str,
        *,
        duration_seconds: float,
        target_language: str = "de",
    ) -> str:
        response = await _post_with_retries(
            "DeepL translation",
            self._client,
            self._settings,
            f"{self._settings.deepl_api_base}/v2/translate",
            headers={
                "Authorization": f"DeepL-Auth-Key {self._api_key}",
                "Content-Type": "application/json",
            },
            json={
                "text": [text],
                "target_lang": self._settings.deepl_target_lang,
            },
            timeout=self._settings.provider_timeout_seconds,
        )
        await _raise_for_provider_error("DeepL translation", response)
        payload = response.json()
        translations = payload.get("translations")
        if not isinstance(translations, list) or not translations:
            raise ProviderRequestError("DeepL response did not contain translations")
        translated = translations[0].get("text")
        if not isinstance(translated, str):
            raise ProviderRequestError("DeepL response did not contain translated text")
        return _duration_guard(
            translated,
            duration_seconds,
            self._settings.duration_guard_chars_per_second,
        )


class OpenAITTS(TTSProvider):
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client
        self._api_key = _secret_value(settings.openai_api_key, "OPENAI_API_KEY")

    async def synthesize(
        self,
        text: str,
        *,
        target_duration_seconds: float,
    ) -> TTSResult:
        estimated_seconds = _estimated_speech_seconds(
            text,
            self._settings.duration_guard_chars_per_second,
        )
        speed = _bounded_rate(
            estimated_seconds / max(target_duration_seconds, 0.25),
            self._settings.tts_max_playback_rate,
        )
        body: dict[str, Any] = {
            "model": self._settings.openai_tts_model,
            "voice": self._settings.openai_tts_voice,
            "input": text,
            "response_format": self._settings.openai_tts_response_format,
            "speed": speed,
        }
        if self._settings.openai_tts_instructions.strip():
            body["instructions"] = self._settings.openai_tts_instructions.strip()

        response = await _post_with_retries(
            "OpenAI TTS",
            self._client,
            self._settings,
            f"{self._settings.openai_base_url}/audio/speech",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json=body,
            timeout=self._settings.provider_timeout_seconds,
        )
        await _raise_for_provider_error("OpenAI TTS", response)
        return TTSResult(
            audio_bytes=response.content,
            mime_type=f"audio/{self._settings.openai_tts_response_format}",
            suggested_playback_rate=1.0,
        )


class ElevenLabsTTS(TTSProvider):
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client
        self._api_key = _secret_value(settings.elevenlabs_api_key, "ELEVENLABS_API_KEY")
        if not settings.elevenlabs_voice_id:
            raise ProviderConfigurationError("ELEVENLABS_VOICE_ID is required")

    async def synthesize(
        self,
        text: str,
        *,
        target_duration_seconds: float,
    ) -> TTSResult:
        voice_id = self._settings.elevenlabs_voice_id
        assert voice_id is not None
        response = await _post_with_retries(
            "ElevenLabs TTS",
            self._client,
            self._settings,
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            params={"output_format": self._settings.elevenlabs_output_format},
            headers={
                "xi-api-key": self._api_key,
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": self._settings.elevenlabs_model_id,
                "language_code": self._settings.elevenlabs_language_code,
            },
            timeout=self._settings.provider_timeout_seconds,
        )
        await _raise_for_provider_error("ElevenLabs TTS", response)
        estimated_seconds = _estimated_speech_seconds(
            text,
            self._settings.duration_guard_chars_per_second,
        )
        suggested_rate = _bounded_rate(
            estimated_seconds / max(target_duration_seconds, 0.25),
            self._settings.tts_max_playback_rate,
        )
        return TTSResult(
            audio_bytes=response.content,
            mime_type="audio/mpeg",
            suggested_playback_rate=suggested_rate,
        )


def build_translation_provider(
    settings: Settings,
    client: httpx.AsyncClient,
) -> TranslationProvider:
    if settings.translation_provider == "openai":
        return OpenAITranslator(settings, client)
    if settings.translation_provider == "deepl":
        return DeepLTranslator(settings, client)
    raise ProviderConfigurationError(f"Unsupported translation provider: {settings.translation_provider}")


def build_tts_provider(settings: Settings, client: httpx.AsyncClient) -> TTSProvider:
    if settings.tts_provider == "openai":
        return OpenAITTS(settings, client)
    if settings.tts_provider == "elevenlabs":
        return ElevenLabsTTS(settings, client)
    raise ProviderConfigurationError(f"Unsupported TTS provider: {settings.tts_provider}")
