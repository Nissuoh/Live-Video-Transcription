# Privacy Policy

Last updated: June 9, 2026

Live Video Translation is a Chrome extension that translates available YouTube captions into synchronized AI-generated speech through a user-configured backend.

## Data Processed

The extension processes only the data required for this feature:

- The current YouTube video identifier.
- Available YouTube caption text, caption timing, and caption language metadata.
- Extension settings stored locally in Chrome extension storage, including backend WebSocket URL, API/Auth token, interface language, source language, target language, voice preferences, pitch-preservation preference, and automatic translation preference.

The extension does not collect YouTube video files, YouTube audio files, passwords, payment card data, emails, private messages, unrelated page content, mouse position, keyboard input, or browsing history outside the YouTube translation feature.

## How Data Is Used

Caption text and timestamps are sent over an encrypted `wss://` WebSocket connection to the backend configured by the user. The backend uses this data to translate captions and generate synchronized text-to-speech audio chunks.

The API/Auth token is used only to authorize access to the backend service.

The current YouTube video identifier is used only to associate transcript chunks with the active video translation session.

## Data Sharing

Depending on backend configuration, caption text may be sent to translation or text-to-speech providers such as OpenAI, DeepL, OpenRouter, ElevenLabs, Microsoft Edge neural text-to-speech, Google Gemini TTS, or locally configured Piper TTS to provide the requested translation and speech generation. Piper TTS runs locally on the backend host when selected.

The extension does not sell user data. User data is not transferred to third parties except as necessary to provide the user-facing translation and speech feature, comply with law, protect against abuse, or operate the configured backend service.

## Storage

The extension stores configuration locally in `chrome.storage.local`. Provider API keys for OpenAI, DeepL, OpenRouter, ElevenLabs, Gemini, Microsoft Edge neural text-to-speech, Piper, or other backend providers are not stored in the extension and must remain on the backend.

## Security

The extension requires secure WebSocket backend connections using `wss://`. It does not use remote JavaScript, remote WebAssembly, `eval`, or dynamically executed remote code.

## User Control

Users can enable or disable automatic translation from the extension popup. Users can edit or remove the backend URL and API/Auth token from the extension popup or options page. Removing the extension deletes locally stored extension settings from the browser.

## Limited Use

Use of user data is limited to providing and securing the YouTube caption translation and synchronized speech feature. User data is not used for advertising, creditworthiness, lending, or unrelated profiling.

## Contact

Support and privacy questions can be submitted through the project repository:

https://github.com/Nissuoh/Live-Video-Transcription/issues
