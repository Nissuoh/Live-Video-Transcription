# Privacy Policy Draft

This draft must be reviewed and hosted on a public HTTPS URL before Chrome Web Store submission.

## Data Collected

Live Video Translation processes the following data only to provide synchronized translated speech for YouTube videos:

- Current YouTube video identifier.
- Available YouTube caption text, caption timing, and caption language metadata.
- Extension configuration stored locally: backend WebSocket URL, auth token, and automatic translation preference.

The extension does not collect YouTube video files, YouTube audio files, passwords, payment card data, emails, or unrelated page content.

## How Data Is Used

Caption text and timestamps are sent over `wss://` to the backend configured by the user. The backend uses selected translation and text-to-speech providers to generate German speech audio chunks and streams those chunks back to the browser.

The auth token is used only to authorize access to the backend service.

## Data Sharing

The backend may transmit caption text to the configured translation and text-to-speech providers, such as OpenAI, DeepL, or ElevenLabs, depending on backend configuration. No executable code is sent from these providers to the extension.

## Storage

The extension stores configuration locally in Chrome extension storage. Provider API keys are never stored in the extension and must remain on the backend.

## Security

The extension requires `wss://` for backend communication. It does not use remote scripts, `eval`, or dynamically executed remote code.

## User Control

Users can enable or disable automatic translation from the extension popup. Removing the extension deletes locally stored extension settings from the browser.

## Contact

Add support email or support website before publication.
