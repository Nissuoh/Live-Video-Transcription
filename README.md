# Live Video Translation

## Struktur

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
|   |-- tsconfig.json
|   `-- src
|       |-- background.ts
|       |-- content.ts
|       |-- options.ts
|       `-- page-probe.ts
|-- docs
|-- .env.example
`-- requirements.txt
```

## Backend

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Fuer Produktion `REQUIRE_WSS=true` lassen und TLS/WSS am Reverse Proxy terminieren. Der Proxy muss `X-Forwarded-Proto=https` oder `wss` setzen.

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
npm run package
```

Danach den Ordner `extension` in `chrome://extensions` als unpacked extension laden oder `extension/webstore/live-video-translation.zip` fuer den Chrome Web Store verwenden.

Die Extension erwartet in `chrome.storage.local`:

```json
{
  "authToken": "token-aus-AUTH_TOKENS",
  "backendWssUrl": "wss://deine-domain.example/stream",
  "autoTranslate": true,
  "sourceLanguage": "en",
  "targetLanguage": "de"
}
```

Die Extension akzeptiert nur `wss://` URLs fuer das Backend. YouTube-Seite, aktuelles Video und Caption-Track werden automatisch erkannt; im Popup wird kein Video-Link eingegeben. Automatische Uebersetzung startet erst, wenn sie im Popup aktiviert und gueltig konfiguriert wurde.

Die UI nutzt Chrome `_locales` fuer statische Texte und `Intl.DisplayNames` fuer Sprachbezeichnungen. Dadurch wird `de` je nach Browser-Sprache als `Deutsch`, `German`, `aleman` oder entsprechend lokal angezeigt.

Siehe [docs/USER_WORKFLOW_AND_ARCHITECTURE.md](docs/USER_WORKFLOW_AND_ARCHITECTURE.md) fuer den vollstaendigen Nutzer- und Systemablauf.
