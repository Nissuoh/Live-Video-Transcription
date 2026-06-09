# Live Video Translation

Chrome Manifest V3 extension plus FastAPI WebSocket backend for translating available YouTube captions into synchronized AI-generated speech.

## Repository Structure

```text
.
|-- backend
|   |-- auth.py
|   |-- config.py
|   |-- interfaces.py
|   |-- main.py
|   |-- pipeline.py
|   |-- providers.py
|   `-- schemas.py
|-- extension
|   |-- _locales
|   |-- manifest.json
|   |-- package.json
|   |-- popup.html
|   |-- options.html
|   |-- tsconfig.json
|   `-- src
|       |-- background.ts
|       |-- content.ts
|       |-- defaults.ts
|       |-- options.ts
|       `-- page-probe.ts
|-- docs
|-- scripts
|-- .env.example
`-- requirements.txt
```

## Backend Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Keep `REQUIRE_WSS=true` in production and terminate TLS/WSS at the reverse proxy. The proxy must forward `X-Forwarded-Proto=https` or `wss`.

Provider selection is controlled through `.env`:

```env
TRANSLATION_PROVIDER=openai
TTS_PROVIDER=edge_tts
```

Recommended local quality setup for German speech with mixed English terms:

```env
TTS_PROVIDER=edge_tts
EDGE_TTS_MALE_VOICE=de-DE-ConradNeural
EDGE_TTS_FEMALE_VOICE=de-DE-KatjaNeural
TTS_PRONUNCIATION_MODE=auto
```

`edge_tts` uses Microsoft Edge neural voices and does not need a separate TTS API key. If this provider is used in production, disclose Microsoft Edge neural text-to-speech in the privacy policy.

OpenAI TTS is ready when the OpenAI project has TTS model access:

```env
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_MALE_VOICE=onyx
OPENAI_TTS_FEMALE_VOICE=coral
TTS_PRONUNCIATION_MODE=auto
```

Gemini TTS is also supported:

```env
TTS_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=gemini-2.5-flash-tts
GEMINI_TTS_MALE_VOICE=Puck
GEMINI_TTS_FEMALE_VOICE=Kore
TTS_PRONUNCIATION_MODE=auto
```

OpenRouter can be used for text translation and compression while a separate TTS provider generates audio:

```env
TRANSLATION_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
TTS_PROVIDER=edge_tts
```

Local open-source TTS with Piper on Windows:

```powershell
.\scripts\install-piper-windows.ps1
```

Copy the printed `PIPER_*` paths into `.env`:

```env
TTS_PROVIDER=piper
PIPER_EXE_PATH=C:\...\Live Video Transcription\.runtime\piper\bin\piper\piper.exe
PIPER_MALE_MODEL_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-thorsten-medium\de_DE-thorsten-medium.onnx
PIPER_MALE_CONFIG_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-thorsten-medium\de_DE-thorsten-medium.onnx.json
PIPER_FEMALE_MODEL_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-eva_k-x_low\de_DE-eva_k-x_low.onnx
PIPER_FEMALE_CONFIG_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-eva_k-x_low\de_DE-eva_k-x_low.onnx.json
```

The backend keeps provider API keys server-side. Do not put OpenAI, DeepL, OpenRouter, ElevenLabs, Gemini, or other provider keys into the extension package.

## Chrome Extension

```powershell
cd extension
npm install
npm run build
npm run package
```

Chrome Web Store upload artifact:

```text
extension/webstore/live-video-translation.zip
```

Local unpacked development build:

```powershell
cd extension
npm run local:unpacked
```

Load `extension-unpacked` in `chrome://extensions` only for local testing.

Stored extension configuration:

```json
{
  "authToken": "token-from-AUTH_TOKENS",
  "backendWssUrl": "wss://your-domain.example/stream",
  "autoTranslate": true,
  "sourceLanguage": "en",
  "targetLanguage": "de",
  "uiLanguage": "system",
  "voiceGender": "male",
  "voicePitch": "low",
  "preserveVoicePitch": true
}
```

The extension accepts production backends only over `wss://.../stream`. Local development may use `ws://127.0.0.1:8000/stream`.

The current YouTube page, video id, and caption track are detected automatically. The user does not paste a YouTube URL into the extension. Automatic translation starts only after the user saves a valid backend token and enables translation.

The popup and options UI support selectable interface language through `uiLanguage`. Current shipped UI languages are:

- Browser default
- English
- German
- French

Source and target language labels are rendered through `Intl.DisplayNames`, so language names match the selected interface language where the browser supports it.

`preserveVoicePitch` is enabled by default. When the user changes YouTube playback speed to 1.25x, 1.5x, or 2x, translated speech stays synchronized while the content script locally time-compresses audio so a low male voice does not become artificially high.

For a public production build, set `DEFAULT_BACKEND_WSS_URL` in [extension/src/defaults.ts](extension/src/defaults.ts). Then users only enter the backend access token, choose languages and voice settings, and enable translation.

## Local End-to-End Test

1. Create `.env` from `.env.example`.
2. Configure a backend auth token and providers:

```env
AUTH_TOKENS=local-dev-token
TRANSLATION_PROVIDER=openai
OPENAI_API_KEY=sk-...
TTS_PROVIDER=edge_tts
```

3. Start the backend:

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

4. Build the local extension:

```powershell
cd extension
npm run local:unpacked
```

5. Load `extension-unpacked` in `chrome://extensions`.
6. Open a YouTube video with captions.
7. Open the extension popup, save `local-dev-token`, enable automatic translation, and test playback.

See [docs/USER_WORKFLOW_AND_ARCHITECTURE.md](docs/USER_WORKFLOW_AND_ARCHITECTURE.md) for the full user and system workflow.
