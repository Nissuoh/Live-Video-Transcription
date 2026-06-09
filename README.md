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

Empfohlen fuer natuerliches Deutsch mit englischen Begriffen:

```env
TTS_PROVIDER=edge_tts
EDGE_TTS_MALE_VOICE=de-DE-ConradNeural
EDGE_TTS_FEMALE_VOICE=de-DE-KatjaNeural
TTS_PRONUNCIATION_MODE=auto
```

`edge_tts` nutzt Microsofts Edge Neural Voices ohne separaten API-Key und ist fuer lokale Tests aktuell die beste sofort nutzbare Qualitaetsoption. Fuer Produktivbetrieb muss dieser externe Sprachdienst in der Datenschutzerklaerung offengelegt werden.

OpenAI TTS bleibt vorbereitet. Sobald dein OpenAI-Projekt Zugriff auf TTS-Modelle hat:

```env
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_MALE_VOICE=onyx
OPENAI_TTS_FEMALE_VOICE=coral
TTS_PRONUNCIATION_MODE=auto
```

Gemini TTS ist ebenfalls vorbereitet:

```env
TTS_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=gemini-2.5-flash-tts
GEMINI_TTS_MALE_VOICE=Puck
GEMINI_TTS_FEMALE_VOICE=Kore
TTS_PRONUNCIATION_MODE=auto
```

In diesen Modi bleiben Begriffe wie `CIA`, `FBI`, `NSA`, `AI`, `GPU`, `URL` und `VPN` im Text erhalten und werden durch die Neural-TTS-Modelle selbst ausgesprochen. Die phonetische Umschreibung wird automatisch nur fuer lokale TTS-Engines wie Piper oder Windows SAPI genutzt.

Alternativen:

```env
TRANSLATION_PROVIDER=deepl
TTS_PROVIDER=elevenlabs
```

Lokales Open-Source-TTS mit Piper unter Windows:

```powershell
.\scripts\install-piper-windows.ps1
```

Die ausgegebenen `PIPER_*` Pfade in `.env` eintragen und den Provider wechseln:

```env
TTS_PROVIDER=piper
PIPER_EXE_PATH=C:\...\Live Video Transcription\.runtime\piper\bin\piper\piper.exe
PIPER_MALE_MODEL_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-thorsten-medium\de_DE-thorsten-medium.onnx
PIPER_MALE_CONFIG_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-thorsten-medium\de_DE-thorsten-medium.onnx.json
PIPER_FEMALE_MODEL_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-eva_k-x_low\de_DE-eva_k-x_low.onnx
PIPER_FEMALE_CONFIG_PATH=C:\...\Live Video Transcription\.runtime\piper\voices\de_DE-eva_k-x_low\de_DE-eva_k-x_low.onnx.json
```

Piper laeuft lokal auf CPU und nutzt lokale ONNX-Stimmen. Die mitgelieferte lokale Empfehlung ist `de_DE-thorsten-medium` fuer maennlich und `de_DE-eva_k-x_low` fuer weiblich.

Vor der Sprachausgabe normalisiert das Backend haeufige englische Initialismen fuer lokale deutsche TTS-Stimmen. Dadurch werden Begriffe wie `C.I.A.`, `FBI`, `NSA`, `AI`, `GPU`, `URL` oder `VPN` mit Piper/Windows nicht als deutsche Woerter gelesen, sondern als englisch klingende Buchstabenfolge gesprochen. Die Liste ist ueber `TTS_ENGLISH_INITIALISMS` in `.env` erweiterbar; mit `TTS_PRONUNCIATION_ENABLED=false` kann die Normalisierung deaktiviert werden. `TTS_PRONUNCIATION_MODE=auto` deaktiviert diese Umschreibung automatisch fuer OpenAI, ElevenLabs, Edge TTS und Gemini.

OpenRouter als Text-Uebersetzer mit separatem TTS-Provider:

```env
TRANSLATION_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
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

Fuer den Produktmodus kann die Backend-URL in [extension/src/defaults.ts](extension/src/defaults.ts) als `DEFAULT_BACKEND_WSS_URL` gesetzt werden. Dann muss der Nutzer im Popup nur noch API/Auth-Token, Sprachwahl und Aktivierung bedienen. Ohne gesetzte Produkt-URL bleibt das Backend-Feld sichtbar, damit lokal oder mit einem Tunnel getestet werden kann.

Die UI nutzt Chrome `_locales` fuer statische Texte und `Intl.DisplayNames` fuer Sprachbezeichnungen. Dadurch wird `de` je nach Browser-Sprache als `Deutsch`, `German`, `aleman` oder entsprechend lokal angezeigt.

## Lokaler End-to-End-Test

1. `.env` anlegen oder bearbeiten.
2. Provider konfigurieren:

```env
AUTH_TOKENS=local-dev-token
TRANSLATION_PROVIDER=openai
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Oder OpenRouter fuer Text plus OpenAI TTS:

```env
AUTH_TOKENS=local-dev-token
TRANSLATION_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

3. Backend starten:

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

4. Lokale Extension bauen:

```powershell
cd extension
npm run local:unpacked
```

5. In `chrome://extensions` den Ordner `extension-unpacked` laden oder neu laden.
6. Im Popup `local-dev-token` eintragen, automatische Uebersetzung aktivieren und auf YouTube testen.

Siehe [docs/USER_WORKFLOW_AND_ARCHITECTURE.md](docs/USER_WORKFLOW_AND_ARCHITECTURE.md) fuer den vollstaendigen Nutzer- und Systemablauf.
