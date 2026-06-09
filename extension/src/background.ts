import {
  DEFAULT_BACKEND_WSS_URL,
  resolveBackendAccessToken,
  isAllowedBackendStreamUrl,
  resolveBackendWssUrl,
} from "./defaults.js";

(() => {
  type Platform = "youtube";

  interface TranscriptItem {
    start: number;
    duration: number;
    text: string;
  }

  interface StartStreamMessage {
    type: "startStream";
    videoId: string;
    platform: Platform;
    sourceLanguage: string;
    targetLanguage: string;
    voiceGender: VoiceGender;
    voicePitch: VoicePitch;
    preserveVoicePitch: boolean;
    transcript: TranscriptItem[];
  }

  interface StopStreamMessage {
    type: "stopStream";
  }

  type ClientMessage = StartStreamMessage | StopStreamMessage;

  interface StreamRequest {
    videoId: string;
    platform: Platform;
    token: string;
    sourceLanguage: string;
    targetLanguage: string;
    voiceGender: VoiceGender;
    voicePitch: VoicePitch;
    transcript: TranscriptItem[];
  }

  interface StreamChunk {
    start: number;
    end: number;
    audioBase64: string;
    suggestedPlaybackRate: number;
  }

  interface ExtensionConfig {
    authToken?: string;
    backendWssUrl?: string;
    autoTranslate?: boolean;
    sourceLanguage?: string;
    targetLanguage?: string;
    uiLanguage?: UiLanguage;
    voiceGender?: VoiceGender;
    voicePitch?: VoicePitch;
    preserveVoicePitch?: boolean;
  }

  type UiLanguage =
    | "system"
    | "en"
    | "de"
    | "fr"
    | "es"
    | "pt_BR"
    | "zh_CN"
    | "ja"
    | "ko"
    | "ar"
    | "hi"
    | "tr"
    | "pl"
    | "it";
  type VoiceGender = "male" | "female";
  type VoicePitch = "normal" | "high" | "low";

  interface StreamSession {
    socket: WebSocket;
    keepAliveIntervalId: number | null;
    port: chrome.runtime.Port;
  }

  const CONFIG_KEYS = [
    "authToken",
    "backendWssUrl",
    "autoTranslate",
    "sourceLanguage",
    "targetLanguage",
    "uiLanguage",
    "voiceGender",
    "voicePitch",
    "preserveVoicePitch",
  ] as const;
  const SUPPORTED_UI_LANGUAGES: readonly UiLanguage[] = [
    "system",
    "en",
    "de",
    "fr",
    "es",
    "pt_BR",
    "zh_CN",
    "ja",
    "ko",
    "ar",
    "hi",
    "tr",
    "pl",
    "it",
  ];
  const STREAM_PORT_NAME = "translation-stream";
  const KEEPALIVE_INTERVAL_MS = 20_000;
  const MAX_TRANSCRIPT_ITEMS = 2000;
  const MAX_TEXT_CHARS_PER_CHUNK = 4000;
  const FALLBACK_MESSAGES: Record<string, string> = {
    autoTranslationDisabledError: "Automatic translation is disabled.",
    backendUrlInvalidError: "Backend URL must use wss:// and point to /stream",
    invalidContentMessageError: "Invalid content script message",
    missingTokenError:
      "Missing backend access token. Open the extension options and save a token.",
    runtimeUnknownError: "Unknown runtime error",
    streamMessageUnsupportedError: "Unsupported content script message",
    unknownStreamError: "Unknown stream error",
    unsupportedMessageError: "Unsupported message",
    untrustedSenderError: "Untrusted sender",
  };
  const sessions = new Map<string, StreamSession>();

  void restrictStorageAccess();

  chrome.runtime.onInstalled.addListener(async () => {
    await restrictStorageAccess();
    const existing = (await chrome.storage.local.get([...CONFIG_KEYS])) as ExtensionConfig;
    const defaults: ExtensionConfig = {};
    if (typeof existing.authToken !== "string") {
      defaults.authToken = "";
    }
    if (typeof existing.backendWssUrl !== "string") {
      defaults.backendWssUrl = DEFAULT_BACKEND_WSS_URL;
    }
    if (typeof existing.autoTranslate !== "boolean") {
      defaults.autoTranslate = false;
    }
    if (typeof existing.sourceLanguage !== "string") {
      defaults.sourceLanguage = "en";
    }
    if (typeof existing.targetLanguage !== "string") {
      defaults.targetLanguage = "de";
    }
    if (typeof existing.uiLanguage !== "string") {
      defaults.uiLanguage = "system";
    }
    if (typeof existing.voiceGender !== "string") {
      defaults.voiceGender = "male";
    }
    if (typeof existing.voicePitch !== "string") {
      defaults.voicePitch = "normal";
    }
    if (typeof existing.preserveVoicePitch !== "boolean") {
      defaults.preserveVoicePitch = true;
    }
    if (Object.keys(defaults).length > 0) {
      await chrome.storage.local.set(defaults);
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    void handleRuntimeMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : localizedMessage("runtimeUnknownError"),
        });
      });
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== STREAM_PORT_NAME || !isTrustedYouTubeSender(port.sender)) {
      port.disconnect();
      return;
    }

    const sessionId = getSessionId(port.sender);
    port.onMessage.addListener((message: unknown) => {
      void handlePortMessage(sessionId, port, message).catch((error: unknown) => {
        safePost(port, {
          type: "streamError",
          error: error instanceof Error ? error.message : "Unknown stream error",
        });
        closeSession(sessionId, "message handling failed");
      });
    });
    port.onDisconnect.addListener(() => {
      closeSession(sessionId, "content script disconnected");
    });
  });

  async function restrictStorageAccess(): Promise<void> {
    if (typeof chrome.storage.local.setAccessLevel !== "function") {
      return;
    }
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }

  async function handleRuntimeMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> {
    if (!isRecord(message) || message.type !== "getRunState") {
      return { ok: false, error: localizedMessage("unsupportedMessageError") };
    }
    if (!isTrustedYouTubeSender(sender)) {
      return { ok: false, error: localizedMessage("untrustedSenderError") };
    }
    const config = (await chrome.storage.local.get([...CONFIG_KEYS])) as ExtensionConfig;
    const enabled = config.autoTranslate === true;
    const authToken = resolveBackendAccessToken(config.authToken);
    const backendWssUrl = resolveBackendWssUrl(config.backendWssUrl);
    const sourceLanguage =
      typeof config.sourceLanguage === "string" && config.sourceLanguage.trim().length > 0
        ? config.sourceLanguage.trim()
        : "en";
    const targetLanguage =
      typeof config.targetLanguage === "string" && config.targetLanguage.trim().length > 0
        ? config.targetLanguage.trim()
        : "de";
    const uiLanguage = parseUiLanguage(config.uiLanguage);
    const voiceGender = parseVoiceGender(config.voiceGender);
    const voicePitch = parseVoicePitch(config.voicePitch);
    const preserveVoicePitch = config.preserveVoicePitch !== false;
    return {
      ok: true,
      enabled,
      configured: enabled && authToken.length > 0 && isAllowedBackendStreamUrl(backendWssUrl),
      sourceLanguage,
      targetLanguage,
      uiLanguage,
      voiceGender,
      voicePitch,
      preserveVoicePitch,
    };
  }

  async function handlePortMessage(
    sessionId: string,
    port: chrome.runtime.Port,
    message: unknown,
  ): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new Error(localizedMessage("invalidContentMessageError"));
    }
    if (message.type === "stopStream") {
      closeSession(sessionId, "client requested stop");
      return;
    }
    if (message.type !== "startStream") {
      throw new Error(localizedMessage("streamMessageUnsupportedError"));
    }
    const startMessage = parseStartMessage(message);
    const config = await loadConfig();
    closeSession(sessionId, "replaced by new stream");
    openStream(sessionId, port, config, startMessage);
  }

  function openStream(
    sessionId: string,
    port: chrome.runtime.Port,
    config: Required<ExtensionConfig>,
    message: StartStreamMessage,
  ): void {
    const socket = new WebSocket(config.backendWssUrl);
    const session: StreamSession = {
      socket,
      keepAliveIntervalId: null,
      port,
    };
    sessions.set(sessionId, session);

    socket.addEventListener("open", () => {
      const request: StreamRequest = {
        videoId: message.videoId,
        platform: message.platform,
        token: config.authToken,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        voiceGender: config.voiceGender,
        voicePitch: config.voicePitch,
        transcript: normalizeTranscript(message.transcript),
      };
      socket.send(JSON.stringify(request));
      session.keepAliveIntervalId = globalThis.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "keepalive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
      safePost(port, { type: "streamOpen" });
    });

    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") {
          throw new Error("WebSocket message was not text JSON");
        }
        const chunk = parseStreamChunk(JSON.parse(event.data));
        safePost(port, { type: "streamChunk", chunk });
      } catch (error: unknown) {
        safePost(port, {
          type: "streamError",
          error: error instanceof Error ? error.message : localizedMessage("unknownStreamError"),
        });
      }
    });

    socket.addEventListener("close", (event) => {
      clearKeepAlive(session);
      sessions.delete(sessionId);
      safePost(port, {
        type: "streamClosed",
        code: event.code,
        reason: event.reason,
      });
    });

    socket.addEventListener("error", () => {
      safePost(port, { type: "streamError", error: "WebSocket connection failed" });
    });
  }

  function closeSession(sessionId: string, reason: string): void {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    clearKeepAlive(session);
    sessions.delete(sessionId);
    if (
      session.socket.readyState === WebSocket.CONNECTING ||
      session.socket.readyState === WebSocket.OPEN
    ) {
      session.socket.close(1000, reason);
    }
  }

  function clearKeepAlive(session: StreamSession): void {
    if (session.keepAliveIntervalId !== null) {
      globalThis.clearInterval(session.keepAliveIntervalId);
      session.keepAliveIntervalId = null;
    }
  }

  async function loadConfig(): Promise<Required<ExtensionConfig>> {
    const stored = (await chrome.storage.local.get([...CONFIG_KEYS])) as ExtensionConfig;
    const authToken = resolveBackendAccessToken(stored.authToken);
    const backendWssUrl = resolveBackendWssUrl(stored.backendWssUrl);
    if (stored.autoTranslate !== true) {
      throw new Error(localizedMessage("autoTranslationDisabledError"));
    }
    if (authToken.length === 0) {
      throw new Error(localizedMessage("missingTokenError"));
    }
    assertWssUrl(backendWssUrl);
    const sourceLanguage =
      typeof stored.sourceLanguage === "string" ? stored.sourceLanguage.trim() : "en";
    const targetLanguage =
      typeof stored.targetLanguage === "string" ? stored.targetLanguage.trim() : "de";
    const uiLanguage = parseUiLanguage(stored.uiLanguage);
    const voiceGender = parseVoiceGender(stored.voiceGender);
    const voicePitch = parseVoicePitch(stored.voicePitch);
    const preserveVoicePitch = stored.preserveVoicePitch !== false;
    return {
      authToken,
      backendWssUrl,
      autoTranslate: true,
      sourceLanguage: sourceLanguage || "en",
      targetLanguage: targetLanguage || "de",
      uiLanguage,
      voiceGender,
      voicePitch,
      preserveVoicePitch,
    };
  }

  function parseStartMessage(value: Record<string, unknown>): StartStreamMessage {
    const videoId = value.videoId;
    const platform = value.platform;
    const sourceLanguage = value.sourceLanguage;
    const targetLanguage = value.targetLanguage;
    const voiceGender = value.voiceGender;
    const voicePitch = value.voicePitch;
    const preserveVoicePitch = value.preserveVoicePitch;
    const transcript = value.transcript;
    if (
      typeof videoId !== "string" ||
      videoId.length === 0 ||
      platform !== "youtube" ||
      typeof sourceLanguage !== "string" ||
      typeof targetLanguage !== "string" ||
      (voiceGender !== "male" && voiceGender !== "female") ||
      (voicePitch !== "normal" && voicePitch !== "high" && voicePitch !== "low") ||
      typeof preserveVoicePitch !== "boolean" ||
      !Array.isArray(transcript)
    ) {
      throw new Error("Invalid startStream message");
    }
    return {
      type: "startStream",
      videoId,
      platform,
      sourceLanguage,
      targetLanguage,
      voiceGender,
      voicePitch,
      preserveVoicePitch,
      transcript: transcript.map(parseTranscriptItem),
    };
  }

  function parseTranscriptItem(value: unknown): TranscriptItem {
    if (!isRecord(value)) {
      throw new Error("Transcript item must be an object");
    }
    const { start, duration, text } = value;
    if (
      typeof start !== "number" ||
      typeof duration !== "number" ||
      typeof text !== "string" ||
      !Number.isFinite(start) ||
      !Number.isFinite(duration) ||
      start < 0 ||
      duration <= 0 ||
      text.trim().length === 0
    ) {
      throw new Error("Invalid transcript item");
    }
    return { start, duration, text };
  }

  function normalizeTranscript(transcript: TranscriptItem[]): TranscriptItem[] {
    return transcript.slice(0, MAX_TRANSCRIPT_ITEMS).map((item) => ({
      start: item.start,
      duration: item.duration,
      text: item.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS_PER_CHUNK),
    }));
  }

  function parseStreamChunk(value: unknown): StreamChunk {
    if (!isRecord(value)) {
      throw new Error("Stream chunk must be a JSON object");
    }
    const { start, end, audioBase64, suggestedPlaybackRate } = value;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof audioBase64 !== "string" ||
      typeof suggestedPlaybackRate !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(suggestedPlaybackRate) ||
      start < 0 ||
      end <= start ||
      audioBase64.length === 0
    ) {
      throw new Error("Invalid stream chunk shape");
    }
    return { start, end, audioBase64, suggestedPlaybackRate };
  }

  function assertWssUrl(value: string): void {
    if (!isAllowedBackendStreamUrl(value)) {
      throw new Error(localizedMessage("backendUrlInvalidError"));
    }
  }

  function parseVoiceGender(value: unknown): VoiceGender {
    return value === "female" ? "female" : "male";
  }

  function parseUiLanguage(value: unknown): UiLanguage {
    return typeof value === "string" && SUPPORTED_UI_LANGUAGES.includes(value as UiLanguage)
      ? (value as UiLanguage)
      : "system";
  }

  function parseVoicePitch(value: unknown): VoicePitch {
    if (value === "high" || value === "low") {
      return value;
    }
    return "normal";
  }

  function isTrustedYouTubeSender(sender: chrome.runtime.MessageSender | undefined): boolean {
    if (sender?.tab?.id === undefined || typeof sender.url !== "string") {
      return false;
    }
    try {
      const url = new URL(sender.url);
      return url.protocol === "https:" && url.hostname.endsWith("youtube.com");
    } catch {
      return false;
    }
  }

  function getSessionId(sender: chrome.runtime.MessageSender | undefined): string {
    const tabId = sender?.tab?.id ?? "unknown-tab";
    const frameId = sender?.frameId ?? 0;
    return `${tabId}:${frameId}`;
  }

  function safePost(port: chrome.runtime.Port, message: unknown): void {
    try {
      port.postMessage(message);
    } catch {
      // The content script can disconnect during YouTube SPA navigation.
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function localizedMessage(key: string): string {
    if (typeof chrome !== "undefined" && chrome.i18n?.getMessage !== undefined) {
      const localized = chrome.i18n.getMessage(key);
      if (localized.trim().length > 0) {
        return localized;
      }
    }
    return FALLBACK_MESSAGES[key] ?? key;
  }
})();
