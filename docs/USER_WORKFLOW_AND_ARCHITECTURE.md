# User Workflow And Architecture

## User Workflow

1. The user installs the Chrome extension.
2. The user opens YouTube and starts an English video with captions.
3. The user clicks the extension icon.
4. The popup shows:
   - API/Auth token.
   - Interface language.
   - Source language, rendered in the user's browser language.
   - Target language, rendered in the user's browser language.
   - Voice gender, pitch, and pitch preservation for YouTube speed changes.
   - Enable automatic translation on YouTube.
5. The user saves the settings.
6. The content script detects the current YouTube video and caption track automatically.
7. The extension sends caption text and timestamps to the configured backend over `wss://`.
8. The backend translates and creates TTS audio chunks.
9. The extension mutes the original YouTube audio only after the backend stream opens.
10. The extension plays translated speech through the browser audio output.

## What Runs In Chrome

Chrome runs the packaged extension JavaScript:

- Popup and options UI.
- YouTube content script.
- Main-world YouTube player probe.
- Manifest V3 service worker.
- Web Audio playback and synchronization.
- Localized popup/options UI through stored `uiLanguage` and bundled `_locales`.
- Localized language names through `Intl.DisplayNames`.
- Pitch-preserving Web Audio synchronization when YouTube playback speed changes.

Chrome does not run Python FastAPI code and does not host a Python server by itself.

## What Runs On The Backend

The backend runs outside Chrome:

- WebSocket `/stream`.
- Auth token validation.
- Rate limiting.
- Translation provider calls.
- TTS provider calls.
- Provider API keys.

For a public Chrome Web Store product, this backend should be a cloud service with a stable `wss://` domain. Users should not have to run a local server.

## Why Not Start A Local Server Automatically

A Chrome Web Store extension cannot silently install or start a Python process on the user's machine. The browser sandbox is designed to prevent that.

The only browser-supported way to talk to a local executable is Native Messaging. Native Messaging requires a separately installed native host application and OS-level registration. That adds installer complexity and a stronger permission/security review burden. It is not a good default for a consumer YouTube extension.

## API Key Meaning

There are two different keys:

- User-facing API/Auth token: entered in the extension popup. It authenticates the user to your backend.
- Provider API keys: OpenAI, DeepL, OpenRouter, ElevenLabs, Gemini, or other paid provider keys. These stay on the backend and are never shipped inside the extension.

Putting provider API keys directly into the extension would make billing, abuse control, and key protection weaker. It can be supported later as a bring-your-own-key mode, but it is a different product model.

## Backend URL Automation

For a public product, the backend WebSocket URL should be configured at build time in `extension/src/defaults.ts` through `DEFAULT_BACKEND_WSS_URL`.

When this value is set, the popup uses that backend automatically and hides the backend URL field. The user only enters the API/Auth token, chooses languages, and enables translation.

When this value is empty, the backend URL field remains visible for local development, staging, or tunnel-based testing.

## Provider Options

Translation and TTS are separate provider strategies:

- Translation: OpenAI, DeepL, or OpenRouter.
- TTS: Microsoft Edge neural TTS through `edge_tts`, OpenAI TTS, Google Gemini TTS, ElevenLabs, local Piper, or Windows SAPI.

OpenRouter can be used for text translation and compression. Speech synthesis still needs a TTS provider because OpenRouter chat completions return text, not synchronized speech audio for this pipeline.

The default local quality recommendation is `TTS_PROVIDER=edge_tts` because it gives natural German neural voices with stronger mixed German/English pronunciation without requiring a separate TTS API key. For production, disclose Microsoft Edge neural text-to-speech as an external backend subprocess if this provider remains active. OpenAI, Gemini, and ElevenLabs are configured by changing `TTS_PROVIDER` plus the matching backend API key variables.

## Language Display

The extension stores stable language codes such as `en` and `de`. It does not store translated display labels for source and target languages.

The popup, options UI, and YouTube status overlay store `uiLanguage` separately from source and target language. Current shipped UI languages are browser default, English, German, French, Spanish, Portuguese (Brazil), Chinese (Simplified), Japanese, Korean, Arabic, Hindi, Turkish, Polish, and Italian. Source and target language names are rendered through `Intl.DisplayNames` in the selected interface language where Chrome supports it.

## Playback Speed And Pitch

YouTube playback speed and translated speech speed stay synchronized. With `preserveVoicePitch=true`, the content script uses Chrome's native pitch-preserving media playback for sped-up translated chunks. This keeps a low or male voice from becoming artificially high or robotic at 1.25x, 1.5x, or 2x playback speed.

## Gemini 3.5 Live Translate Evaluation

Google documents `gemini-3.5-live-translate-preview` as a low-latency audio-to-audio Live API translation model with 70+ supported languages. It is relevant for a V2 architecture, but it is not compatible with the current V1 contract as a simple provider swap:

- V1 sends YouTube captions as text plus timestamps.
- Gemini 3.5 Live Translate accepts audio input only for translation.
- V1 needs exact caption timestamp alignment for YouTube playback.
- Live Translate is optimized for continuous speech-to-speech sessions and has preview limitations around voice consistency, language detection, background audio, and echo behavior.

Recommended path: keep V1 transcript-based for Chrome Web Store stability, then add a separate V2 backend stream mode for audio-to-audio translation after validating browser audio capture, YouTube policy constraints, server-side authentication, latency, and cost.

## Production Shape

The smooth product flow requires:

- Extension published in Chrome Web Store.
- Backend deployed at a stable `wss://` endpoint.
- User accounts or payment flow that issues auth tokens.
- Store listing and privacy policy that disclose caption processing.
- Reviewer test token and test backend URL.
- Production build-time backend URL in `extension/src/defaults.ts`, or a clearly documented user-configured backend flow.
- Production `WEBSOCKET_ALLOWED_ORIGINS` restricted to the published Chrome extension ID instead of `chrome-extension://*`.
