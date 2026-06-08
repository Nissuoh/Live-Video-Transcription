# Live Video Translation

## Struktur

```text
.
├── backend
│   ├── auth.py
│   ├── config.py
│   ├── interfaces.py
│   ├── main.py
│   ├── pipeline.py
│   ├── providers.py
│   └── schemas.py
├── extension
│   ├── manifest.json
│   ├── package.json
│   ├── tsconfig.json
│   └── src
│       ├── background.ts
│       └── content.ts
├── .env.example
└── requirements.txt
```

## Backend

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Für Produktion `REQUIRE_WSS=true` lassen und TLS/WSS am Reverse Proxy terminieren. Der Proxy muss `X-Forwarded-Proto=https` oder `wss` setzen.

Provider-Auswahl:

```env
TRANSLATION_PROVIDER=openai
TTS_PROVIDER=openai
```

Alternativen:

```env
TRANSLATION_PROVIDER=deepl
TTS_PROVIDER=elevenlabs
```

## Chrome Extension

```powershell
cd extension
npm install
npm run build
```

Danach den Ordner `extension` in `chrome://extensions` als unpacked extension laden. Die Extension erwartet in `chrome.storage.local`:

```json
{
  "authToken": "token-aus-AUTH_TOKENS",
  "backendWssUrl": "wss://deine-domain.example/stream"
}
```

Die Extension akzeptiert nur `wss://` URLs für das Backend.
