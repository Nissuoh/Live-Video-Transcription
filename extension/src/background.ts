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
  }

  interface StreamSession {
    socket: WebSocket;
    keepAliveIntervalId: number | null;
    port: chrome.runtime.Port;
  }

  const CONFIG_KEYS = ["authToken", "backendWssUrl"] as const;
  const STREAM_PORT_NAME = "translation-stream";
  const KEEPALIVE_INTERVAL_MS = 20_000;
  const MAX_TRANSCRIPT_ITEMS = 2000;
  const MAX_TEXT_CHARS_PER_CHUNK = 4000;
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
      defaults.backendWssUrl = "";
    }
    if (Object.keys(defaults).length > 0) {
      await chrome.storage.local.set(defaults);
    }
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

  async function handlePortMessage(
    sessionId: string,
    port: chrome.runtime.Port,
    message: unknown,
  ): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new Error("Invalid content script message");
    }
    if (message.type === "stopStream") {
      closeSession(sessionId, "client requested stop");
      return;
    }
    if (message.type !== "startStream") {
      throw new Error("Unsupported content script message");
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
          error: error instanceof Error ? error.message : "Invalid stream chunk",
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
    const authToken = typeof stored.authToken === "string" ? stored.authToken.trim() : "";
    const backendWssUrl =
      typeof stored.backendWssUrl === "string" ? stored.backendWssUrl.trim() : "";
    if (authToken.length === 0) {
      throw new Error("Missing auth token. Open the extension options and save a token.");
    }
    assertWssUrl(backendWssUrl);
    return { authToken, backendWssUrl };
  }

  function parseStartMessage(value: Record<string, unknown>): StartStreamMessage {
    const videoId = value.videoId;
    const platform = value.platform;
    const transcript = value.transcript;
    if (
      typeof videoId !== "string" ||
      videoId.length === 0 ||
      platform !== "youtube" ||
      !Array.isArray(transcript)
    ) {
      throw new Error("Invalid startStream message");
    }
    return {
      type: "startStream",
      videoId,
      platform,
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
    const url = new URL(value);
    if (url.protocol !== "wss:") {
      throw new Error("Backend URL must use wss://");
    }
    if (!url.pathname.endsWith("/stream")) {
      throw new Error("Backend URL must point to /stream");
    }
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
})();
