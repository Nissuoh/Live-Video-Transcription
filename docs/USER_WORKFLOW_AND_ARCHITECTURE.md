# User Workflow And Architecture

## User Workflow

1. The user installs the Chrome extension.
2. The user opens YouTube and starts an English video with captions.
3. The user clicks the extension icon.
4. The popup shows:
   - API/Auth token.
   - Source language, rendered in the user's browser language.
   - Target language, rendered in the user's browser language.
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
- Localized popup/options UI through Chrome `_locales`.
- Localized language names through `Intl.DisplayNames`.

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
- Provider API keys: OpenAI, DeepL, ElevenLabs. These stay on the backend and are never shipped inside the extension.

Putting provider API keys directly into the extension would make billing, abuse control, and key protection weaker. It can be supported later as a bring-your-own-key mode, but it is a different product model.

## Backend URL Automation

For a public product, the backend WebSocket URL should be configured at build time in `extension/src/defaults.ts` through `DEFAULT_BACKEND_WSS_URL`.

When this value is set, the popup uses that backend automatically and hides the backend URL field. The user only enters the API/Auth token, chooses languages, and enables translation.

When this value is empty, the backend URL field remains visible for local development, staging, or tunnel-based testing.

## Provider Options

Translation and TTS are separate provider strategies:

- Translation: OpenAI, DeepL, or OpenRouter.
- TTS: OpenAI TTS or ElevenLabs.

OpenRouter can be used for text translation and compression. Speech synthesis still needs a TTS provider because OpenRouter chat completions return text, not synchronized speech audio for this pipeline.

## Language Display

The extension stores stable language codes such as `en` and `de`. It does not store translated display labels.

The popup renders language names through the browser's locale. For example, target language `de` is shown as `Deutsch` in a German browser, `German` in an English browser, `aleman` in a Spanish browser, and `allemand` in a French browser.

## Production Shape

The smooth product flow requires:

- Extension published in Chrome Web Store.
- Backend deployed at a stable `wss://` endpoint.
- User accounts or payment flow that issues auth tokens.
- Store listing and privacy policy that disclose caption processing.
- Reviewer test token and test backend URL.
