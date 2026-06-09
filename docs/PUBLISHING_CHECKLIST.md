# Publishing Checklist

Use this checklist before publishing a Chrome Web Store version or a public GitHub release.

## GitHub

- Commit source code only.
- Do not commit `.env`, `.runtime/`, `logs/`, `extension-unpacked/`, `extension/dist/`, or `extension/webstore/`.
- Keep provider API keys only in backend runtime secrets:
  - `OPENAI_API_KEY`
  - `DEEPL_API_KEY`
  - `OPENROUTER_API_KEY`
  - `ELEVENLABS_API_KEY`
  - `GEMINI_API_KEY`
- Keep monetization/auth tokens only in backend runtime secrets:
  - `AUTH_TOKENS`
- `local-dev-token` is only a local development placeholder used by `npm run local:unpacked`.

## Backend Production

- Deploy the FastAPI backend behind TLS.
- Public WebSocket URL must be `wss://.../stream`.
- Set `REQUIRE_WSS=true`.
- Set `WEBSOCKET_ALLOWED_ORIGINS` to the final Chrome extension origin after Chrome assigns the extension ID.
- Replace comma-separated `AUTH_TOKENS` with account-issued user tokens before commercial launch.
- Add persistent usage accounting if the product is monetized.
- Keep logs free of raw caption text unless the privacy policy explicitly allows retention.
- Verify `/healthz` monitoring.

## TTS Provider

Current local quality default:

```env
TTS_PROVIDER=edge_tts
EDGE_TTS_MALE_VOICE=de-DE-ConradNeural
EDGE_TTS_FEMALE_VOICE=de-DE-KatjaNeural
TTS_PRONUNCIATION_MODE=auto
```

Provider alternatives:

- `TTS_PROVIDER=openai` with `OPENAI_API_KEY`, if the OpenAI project has TTS model access.
- `TTS_PROVIDER=gemini` with `GEMINI_API_KEY`.
- `TTS_PROVIDER=elevenlabs` with `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.
- `TTS_PROVIDER=piper` for local backend-hosted open-source TTS.
- `TTS_PROVIDER=windows_sapi` for Windows-only local development.

Disclose the active provider in the privacy policy. `edge_tts` uses Microsoft Edge neural text-to-speech as an external backend service.

## Chrome Extension Build

For local testing:

```powershell
cd extension
npm run local:unpacked
```

Load `extension-unpacked` only through `chrome://extensions` for development.

For Chrome Web Store:

```powershell
cd extension
npm run package
```

Upload:

```text
extension/webstore/live-video-translation.zip
```

Do not upload:

```text
extension-unpacked
```

## Chrome Web Store Before Submission

- Host the privacy policy at a public HTTPS URL.
- Provide reviewer test credentials:
  - Backend WSS URL.
  - Temporary auth token.
  - YouTube video with captions.
- Fill privacy data disclosures:
  - Website content.
  - Web browsing activity limited to current YouTube video context.
  - Authentication information.
  - User settings, including interface language, source/target language, voice, and pitch-preservation preferences.
- Remote code answer: `No remote code`.
- Permission justifications:
  - `storage`: stores backend URL, auth token, language, voice, and enablement settings.
  - YouTube host permission: reads current video metadata and caption tracks needed for the single translation purpose.
- Verify store screenshots are 1280x800 or 640x400 PNG/JPEG without alpha.

## Production Build Hardening

- If using one official backend, set `DEFAULT_BACKEND_WSS_URL` in `extension/src/defaults.ts`.
- If using one official backend, restrict manifest `connect-src` to that backend instead of broad `wss://*`.
- Keep `DEFAULT_BACKEND_ACCESS_TOKEN` empty for public builds unless you intentionally issue a non-secret public test token.
- Rebuild and re-run secret checks after changing defaults.
