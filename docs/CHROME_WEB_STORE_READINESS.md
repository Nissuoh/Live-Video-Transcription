# Chrome Web Store Readiness

This document tracks non-code work that must be completed before submitting the extension.

## Store Listing

- Single purpose: "Automatically translate available YouTube captions into synchronized AI-generated German speech through the user's configured backend."
- Category: Accessibility or Productivity.
- Description must explicitly say:
  - The extension only runs on YouTube pages.
  - It reads the current YouTube video id and available caption track.
  - It sends caption text and timestamps to the configured backend over WSS.
  - It mutes the original video only after automatic translation is enabled and the backend connection opens.
  - It does not download YouTube video or audio.
- Screenshots required:
  - Popup configuration.
  - YouTube page with the small status message.
  - Optional backend architecture diagram.
- Test instructions for reviewers:
  - Provide a temporary test token.
  - Provide a production `wss://.../stream` backend URL.
  - Provide a YouTube video URL with captions enabled.
  - Explain that no video URL is entered in the extension; the current tab is detected automatically.
  - Explain that the default language flow is English captions to German speech and that language names are rendered in the reviewer's browser language.

## Privacy Fields

- Data types to disclose:
  - Website content: caption text and timestamps from the active YouTube video.
  - Web browsing activity: current YouTube video id/page context, only for the user-facing translation feature.
  - Authentication information: extension auth token stored locally in `chrome.storage.local`.
- User-facing popup controls:
  - Backend WSS URL only when no build-time backend default is configured.
  - API/Auth token.
  - Source and target language selection.
  - Automatic translation opt-in toggle.
- Permissions justification:
  - `storage`: stores backend WSS URL, auth token, and enablement preference locally.
  - `host_permissions` for YouTube: reads the active YouTube video metadata and caption track required for translation.
- Remote code declaration:
  - Select "No remote code".
  - The backend performs server-side translation/TTS operations but does not send executable code to the extension.

## Backend Operations

- Deploy behind TLS with a stable `wss://` endpoint.
- Configure `WEBSOCKET_ALLOWED_ORIGINS` for production extension IDs instead of `chrome-extension://*`.
- Replace `AUTH_TOKENS` with account-based tokens before public launch.
- Add persistent usage accounting for monetization; current rate limits are in-memory protection, not billing.
- Keep provider API keys only on the backend.
- Configure structured logs without storing raw caption text unless your privacy policy explicitly permits it.
- Add uptime monitoring for `/healthz`.

## Legal And UX

- Publish a working privacy policy URL before submission.
- Publish support contact details.
- Disclose that generated speech is AI-generated.
- Confirm that the product does not claim endorsement by YouTube, Google, OpenAI, DeepL, or ElevenLabs.
- Verify YouTube Terms and target-market copyright constraints with counsel before broad commercial launch.
