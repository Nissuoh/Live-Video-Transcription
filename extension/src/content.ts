(() => {
  type Platform = "youtube";

  interface TranscriptItem {
    start: number;
    duration: number;
    text: string;
  }

  interface StreamRequest {
    videoId: string;
    platform: Platform;
    sourceLanguage: string;
    targetLanguage: string;
    transcript: TranscriptItem[];
  }

  interface StreamChunk {
    start: number;
    end: number;
    audioBase64: string;
    suggestedPlaybackRate: number;
  }

  interface RunStateResponse {
    ok: boolean;
    enabled?: boolean;
    configured?: boolean;
    sourceLanguage?: string;
    targetLanguage?: string;
    error?: string;
  }

  interface YouTubePlayerResponse {
    videoDetails?: {
      videoId?: string;
    };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: CaptionTrack[];
      };
    };
  }

  interface CaptionTrack {
    baseUrl: string;
    languageCode?: string;
    name?: {
      simpleText?: string;
      runs?: Array<{ text?: string }>;
    };
    kind?: string;
    vssId?: string;
  }

  interface YouTubeTimedTextResponse {
    events?: TimedTextEvent[];
  }

  interface TimedTextEvent {
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string }>;
  }

  interface DecodedAudioChunk {
    start: number;
    end: number;
    playbackRate: number;
    buffer: AudioBuffer;
  }

  const SCHEDULE_AHEAD_SECONDS = 0.2;
  const LATE_TOLERANCE_SECONDS = 0.35;
  const STALE_CHUNK_SECONDS = 30;
  const STREAM_PORT_NAME = "translation-stream";
  const FALLBACK_MESSAGES: Record<string, string> = {
    captionsEmptyError: "The selected caption track is empty.",
    captionsUnavailableError: "No caption track is available for the selected language.",
    connectionClosedError: "Live translation connection closed unexpectedly.",
    disabledStatus:
      "Live Video Translation is ready. Open the extension, enter your token, enable translation, and save.",
    metadataError: "Could not read the current YouTube video metadata.",
    notConfiguredStatus:
      "Live translation is enabled but not configured. Open the extension popup.",
    preparingAudioStatus: "Live translation is preparing audio.",
    videoIdError: "Could not identify the current YouTube video.",
  };

  class AudioChunkScheduler {
    private readonly video: HTMLVideoElement;
    private readonly chunks = new Map<number, DecodedAudioChunk>();
    private readonly scheduledKeys = new Set<number>();
    private readonly activeSources = new Map<AudioBufferSourceNode, number>();
    private audioContext: AudioContext | null = null;
    private gainNode: GainNode | null = null;
    private animationFrameId: number | null = null;

    constructor(video: HTMLVideoElement) {
      this.video = video;
      this.video.addEventListener("play", this.onPlaybackResumed);
      this.video.addEventListener("pause", this.onPlaybackInterrupted);
      this.video.addEventListener("seeking", this.onPlaybackInterrupted);
      this.video.addEventListener("ratechange", this.onRateChanged);
    }

    async addChunk(chunk: StreamChunk): Promise<void> {
      const context = this.getAudioContext();
      const audioData = base64ToArrayBuffer(chunk.audioBase64);
      const buffer = await context.decodeAudioData(audioData);
      this.chunks.set(chunk.start, {
        start: chunk.start,
        end: chunk.end,
        playbackRate: chunk.suggestedPlaybackRate,
        buffer,
      });
      this.startLoop();
    }

    dispose(): void {
      if (this.animationFrameId !== null) {
        window.cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.stopActiveSources();
      this.chunks.clear();
      this.scheduledKeys.clear();
      this.video.removeEventListener("play", this.onPlaybackResumed);
      this.video.removeEventListener("pause", this.onPlaybackInterrupted);
      this.video.removeEventListener("seeking", this.onPlaybackInterrupted);
      this.video.removeEventListener("ratechange", this.onRateChanged);
    }

    private readonly onPlaybackResumed = (): void => {
      void this.getAudioContext().resume();
      this.startLoop();
    };

    private readonly onPlaybackInterrupted = (): void => {
      this.stopActiveSources();
      this.scheduledKeys.clear();
    };

    private readonly onRateChanged = (): void => {
      for (const [source, chunkRate] of this.activeSources) {
        source.playbackRate.value = Math.max(0.25, Math.min(4, this.video.playbackRate * chunkRate));
      }
    };

    private getAudioContext(): AudioContext {
      if (this.audioContext === null) {
        this.audioContext = new AudioContext();
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1;
        this.gainNode.connect(this.audioContext.destination);
      }
      return this.audioContext;
    }

    private startLoop(): void {
      if (this.animationFrameId === null) {
        this.animationFrameId = window.requestAnimationFrame(this.tick);
      }
    }

    private readonly tick = (): void => {
      this.animationFrameId = null;
      this.scheduleDueChunks();
      if (this.chunks.size > 0) {
        this.animationFrameId = window.requestAnimationFrame(this.tick);
      }
    };

    private scheduleDueChunks(): void {
      if (this.video.paused || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      const currentTime = this.video.currentTime;
      for (const [key, chunk] of Array.from(this.chunks.entries()).sort(
        ([left], [right]) => left - right,
      )) {
        if (chunk.end < currentTime - STALE_CHUNK_SECONDS) {
          this.chunks.delete(key);
          this.scheduledKeys.delete(key);
          continue;
        }
        if (this.scheduledKeys.has(key)) {
          continue;
        }
        if (chunk.start <= currentTime + SCHEDULE_AHEAD_SECONDS) {
          if (chunk.end <= currentTime - LATE_TOLERANCE_SECONDS) {
            this.scheduledKeys.add(key);
            continue;
          }
          this.scheduleChunk(key, chunk, currentTime);
        }
      }
    }

    private scheduleChunk(key: number, chunk: DecodedAudioChunk, currentTime: number): void {
      const context = this.getAudioContext();
      const gainNode = this.gainNode;
      if (gainNode === null) {
        return;
      }
      void context.resume();
      const source = context.createBufferSource();
      source.buffer = chunk.buffer;
      source.playbackRate.value = Math.max(
        0.25,
        Math.min(4, this.video.playbackRate * chunk.playbackRate),
      );
      source.connect(gainNode);
      source.onended = () => {
        this.activeSources.delete(source);
      };

      const offset = Math.max(0, currentTime - chunk.start);
      const startDelay = Math.max(0, chunk.start - currentTime);
      const when = context.currentTime + startDelay;
      this.activeSources.set(source, chunk.playbackRate);
      this.scheduledKeys.add(key);
      source.start(when, offset);
    }

    private stopActiveSources(): void {
      for (const source of this.activeSources.keys()) {
        try {
          source.stop();
        } catch {
          // Source nodes can already be stopped by the browser.
        }
      }
      this.activeSources.clear();
    }
  }

  class YouTubeTranslationController {
    private activeVideoId: string | null = null;
    private port: chrome.runtime.Port | null = null;
    private scheduler: AudioChunkScheduler | null = null;
    private currentVideo: HTMLVideoElement | null = null;
    private previousMuted: boolean | null = null;
    private navigationTimer: number | null = null;

    start(): void {
      this.queueBootstrap();
      window.addEventListener("yt-navigate-finish", this.queueBootstrap);
      window.addEventListener("pageshow", this.queueBootstrap);
      window.addEventListener("popstate", this.queueBootstrap);
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if (isRecord(message) && message.type === "lvtSettingsUpdated") {
          this.queueBootstrap();
        }
      });
    }

    private readonly queueBootstrap = (): void => {
      if (this.navigationTimer !== null) {
        window.clearTimeout(this.navigationTimer);
      }
      this.navigationTimer = window.setTimeout(() => {
        this.navigationTimer = null;
        void this.bootstrap().catch((error: unknown) => {
          showStatus(formatErrorStatus(error), "error");
          console.warn("[Live Video Translation]", error);
        });
      }, 500);
    };

    private async bootstrap(): Promise<void> {
      const runState = await getRunState();
      if (!runState.enabled) {
        this.teardown();
        showStatus(localizedMessage("disabledStatus"), "info");
        return;
      }
      if (!runState.configured) {
        this.teardown();
        showStatus(localizedMessage("notConfiguredStatus"), "error");
        return;
      }

      const video = await waitForVideo();
      const playerResponse = await extractPlayerResponse();
      if (playerResponse === null) {
        this.teardown();
        showStatus(localizedMessage("metadataError"), "error");
        return;
      }
      const videoId = resolveVideoId(playerResponse);
      if (videoId === null) {
        this.teardown();
        showStatus(localizedMessage("videoIdError"), "error");
        return;
      }
      if (this.activeVideoId === videoId) {
        return;
      }
      this.teardown();
      this.activeVideoId = videoId;
      this.currentVideo = video;

      const sourceLanguage = runState.sourceLanguage;
      const targetLanguage = runState.targetLanguage;
      const track = chooseCaptionTrack(playerResponse, sourceLanguage);
      if (track === null) {
        showStatus(localizedMessage("captionsUnavailableError"), "error");
        return;
      }
      const transcript = await fetchTranscript(track);
      if (transcript.length === 0) {
        showStatus(localizedMessage("captionsEmptyError"), "error");
        return;
      }
      this.scheduler = new AudioChunkScheduler(video);
      this.openStream(videoId, transcript, sourceLanguage, targetLanguage);
    }

    private openStream(
      videoId: string,
      transcript: TranscriptItem[],
      sourceLanguage: string,
      targetLanguage: string,
    ): void {
      const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
      this.port = port;
      port.onMessage.addListener((message: unknown) => {
        void this.handleWorkerMessage(message).catch((error: unknown) => {
          console.error("[Live Video Translation]", error);
        });
      });
      port.onDisconnect.addListener(() => {
        this.port = null;
      });
      const request: StreamRequest = {
        videoId,
        platform: "youtube",
        sourceLanguage,
        targetLanguage,
        transcript,
      };
      port.postMessage({ type: "startStream", ...request });
    }

    private async handleWorkerMessage(message: unknown): Promise<void> {
      if (!isRecord(message) || typeof message.type !== "string") {
        throw new Error("Invalid background message");
      }
      if (message.type === "streamError") {
        const error = typeof message.error === "string" ? message.error : "Stream error";
        this.restoreMutedState();
        showStatus(error, "error");
        return;
      }
      if (message.type === "streamClosed") {
        if (message.code !== 1000) {
          this.restoreMutedState();
          console.error("[Live Video Translation] WebSocket closed", message);
          showStatus(localizedMessage("connectionClosedError"), "error");
        }
        return;
      }
      if (message.type === "streamOpen") {
        this.muteCurrentVideo();
        showStatus(localizedMessage("preparingAudioStatus"), "info");
        return;
      }
      if (message.type !== "streamChunk") {
        return;
      }
      const scheduler = this.scheduler;
      if (scheduler === null) {
        return;
      }
      const chunk = parseStreamChunk(message.chunk);
      await scheduler.addChunk(chunk);
      hideStatus();
    }

    private teardown(): void {
      this.activeVideoId = null;
      if (this.port !== null) {
        this.port.postMessage({ type: "stopStream" });
        this.port.disconnect();
        this.port = null;
      }
      if (this.scheduler !== null) {
        this.scheduler.dispose();
        this.scheduler = null;
      }
      this.restoreMutedState();
      this.currentVideo = null;
    }

    private muteCurrentVideo(): void {
      if (this.currentVideo === null) {
        return;
      }
      if (this.previousMuted === null) {
        this.previousMuted = this.currentVideo.muted;
      }
      this.currentVideo.muted = true;
    }

    private restoreMutedState(): void {
      if (this.currentVideo !== null && this.previousMuted !== null) {
        this.currentVideo.muted = this.previousMuted;
      }
      this.previousMuted = null;
    }
  }

  async function getRunState(): Promise<
    Required<Pick<RunStateResponse, "enabled" | "configured" | "sourceLanguage" | "targetLanguage">>
  > {
    try {
      const response = (await chrome.runtime.sendMessage({ type: "getRunState" })) as RunStateResponse;
      if (!response.ok) {
        return { enabled: false, configured: false, sourceLanguage: "en", targetLanguage: "de" };
      }
      return {
        enabled: response.enabled === true,
        configured: response.configured === true,
        sourceLanguage:
          typeof response.sourceLanguage === "string" && response.sourceLanguage.length > 0
            ? response.sourceLanguage
            : "en",
        targetLanguage:
          typeof response.targetLanguage === "string" && response.targetLanguage.length > 0
            ? response.targetLanguage
            : "de",
      };
    } catch {
      return { enabled: false, configured: false, sourceLanguage: "en", targetLanguage: "de" };
    }
  }

  function showStatus(message: string, kind: "info" | "error"): void {
    let host = document.getElementById("lvt-status-host");
    if (host === null) {
      host = document.createElement("div");
      host.id = "lvt-status-host";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          pointer-events: none;
        }
        .status {
          max-width: min(360px, calc(100vw - 32px));
          border: 1px solid #b8c1d1;
          border-radius: 6px;
          padding: 10px 12px;
          background: #ffffff;
          color: #172033;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
          font: 13px/1.4 Arial, sans-serif;
        }
        .status[data-kind="error"] {
          border-color: #f0b8b3;
          color: #8f1d17;
        }
      `;
      const status = document.createElement("div");
      status.className = "status";
      status.id = "status";
      shadow.append(style, status);
      document.documentElement.append(host);
    }
    const shadowStatus = host.shadowRoot?.getElementById("status");
    if (shadowStatus instanceof HTMLElement) {
      shadowStatus.dataset.kind = kind;
      shadowStatus.textContent = message;
    }
  }

  function hideStatus(): void {
    document.getElementById("lvt-status-host")?.remove();
  }

  async function extractPlayerResponse(): Promise<YouTubePlayerResponse | null> {
    const fromPage = await requestPlayerResponseFromPage();
    return fromPage ?? extractInitialPlayerResponseFromScripts();
  }

  function requestPlayerResponseFromPage(): Promise<YouTubePlayerResponse | null> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 1000);

      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.source !== window || !isRecord(event.data)) {
          return;
        }
        if (
          event.data.source !== "lvt-page-probe" ||
          event.data.type !== "playerResponse" ||
          event.data.requestId !== requestId
        ) {
          return;
        }
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        resolve(parsePlayerResponse(event.data.playerResponse));
      };

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          source: "lvt-content",
          type: "readPlayerResponse",
          requestId,
        },
        window.location.origin,
      );
    });
  }

  function extractInitialPlayerResponseFromScripts(): YouTubePlayerResponse | null {
    for (const script of Array.from(document.scripts)) {
      const source = script.textContent ?? "";
      if (!source.includes("ytInitialPlayerResponse")) {
        continue;
      }
      const json = extractBalancedJson(source, "ytInitialPlayerResponse");
      if (json === null) {
        continue;
      }
      try {
        return parsePlayerResponse(JSON.parse(json));
      } catch {
        continue;
      }
    }
    return null;
  }

  function parsePlayerResponse(value: unknown): YouTubePlayerResponse | null {
    if (!isRecord(value)) {
      return null;
    }
    return value as YouTubePlayerResponse;
  }

  function extractBalancedJson(source: string, marker: string): string | null {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }
    const startIndex = source.indexOf("{", markerIndex);
    if (startIndex < 0) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < source.length; index += 1) {
      const char = source[index];
      if (char === undefined) {
        return null;
      }
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return source.slice(startIndex, index + 1);
        }
      }
    }
    return null;
  }

  function resolveVideoId(playerResponse: YouTubePlayerResponse): string | null {
    const fromResponse = playerResponse.videoDetails?.videoId;
    if (typeof fromResponse === "string" && fromResponse.length > 0) {
      return fromResponse;
    }
    const url = new URL(window.location.href);
    return url.searchParams.get("v");
  }

  function chooseCaptionTrack(
    playerResponse: YouTubePlayerResponse,
    preferredLanguage: string,
  ): CaptionTrack | null {
    const tracks =
      playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) {
      return null;
    }
    return (
      tracks.find(
        (track) => trackMatchesLanguage(track, preferredLanguage) && track.kind !== "asr",
      ) ??
      tracks.find((track) => trackMatchesLanguage(track, preferredLanguage)) ??
      tracks.find((track) => track.languageCode?.startsWith("en") && track.kind !== "asr") ??
      tracks.find((track) => track.kind !== "asr") ??
      tracks.find((track) => track.languageCode?.startsWith("en")) ??
      tracks[0] ??
      null
    );
  }

  function trackMatchesLanguage(track: CaptionTrack, languageCode: string): boolean {
    const trackCode = track.languageCode?.toLowerCase();
    const preferredCode = languageCode.toLowerCase();
    if (trackCode === undefined || preferredCode.length === 0) {
      return false;
    }
    return (
      trackCode === preferredCode ||
      trackCode.startsWith(`${preferredCode}-`) ||
      preferredCode.startsWith(`${trackCode}-`)
    );
  }

  async function fetchTranscript(track: CaptionTrack): Promise<TranscriptItem[]> {
    const errors: string[] = [];
    for (const format of ["json3", "srv3"] as const) {
      const url = new URL(track.baseUrl);
      url.searchParams.set("fmt", format);
      try {
        const response = await fetch(url.toString(), { credentials: "include" });
        if (!response.ok) {
          errors.push(`${format} HTTP ${response.status}`);
          continue;
        }
        const body = await response.text();
        if (body.trim().length === 0) {
          errors.push(`${format} response was empty`);
          continue;
        }
        const transcript =
          format === "json3"
            ? parseJsonTranscript(JSON.parse(body) as YouTubeTimedTextResponse)
            : parseXmlTranscript(body);
        if (transcript.length > 0) {
          return transcript;
        }
        errors.push(`${format} response did not contain transcript text`);
      } catch (error: unknown) {
        errors.push(
          `${format} parse failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    throw new Error(`Caption fetch failed: ${errors.join("; ")}`);
  }

  function parseJsonTranscript(timedText: YouTubeTimedTextResponse): TranscriptItem[] {
    const events = timedText.events ?? [];
    const transcript: TranscriptItem[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined || event.tStartMs === undefined || event.segs === undefined) {
        continue;
      }
      const text = event.segs
        .map((segment) => segment.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length === 0) {
        continue;
      }
      const nextStartMs = events[index + 1]?.tStartMs;
      const durationMs =
        event.dDurationMs ??
        (nextStartMs !== undefined ? Math.max(250, nextStartMs - event.tStartMs) : 2000);
      transcript.push({
        start: event.tStartMs / 1000,
        duration: durationMs / 1000,
        text,
      });
    }
    return transcript;
  }

  function parseXmlTranscript(xml: string): TranscriptItem[] {
    const document = new DOMParser().parseFromString(xml, "text/xml");
    if (document.querySelector("parsererror") !== null) {
      throw new Error("caption XML was invalid");
    }

    const legacyTextTranscript = parseLegacyTextNodes(document);
    if (legacyTextTranscript.length > 0) {
      return legacyTextTranscript;
    }
    return parseSrv3ParagraphNodes(document);
  }

  function parseLegacyTextNodes(document: Document): TranscriptItem[] {
    return Array.from(document.querySelectorAll("text"))
      .map((node) => {
        const start = Number(node.getAttribute("start"));
        const duration = Number(node.getAttribute("dur") ?? "2");
        const text = normalizeCaptionText(node.textContent ?? "");
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(duration) ||
          start < 0 ||
          duration <= 0 ||
          text.length === 0
        ) {
          return null;
        }
        return { start, duration, text };
      })
      .filter((item): item is TranscriptItem => item !== null);
  }

  function parseSrv3ParagraphNodes(document: Document): TranscriptItem[] {
    const paragraphs = Array.from(document.querySelectorAll("p"));
    const transcript: TranscriptItem[] = [];
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      if (paragraph === undefined) {
        continue;
      }
      const startMs = Number(paragraph.getAttribute("t"));
      const explicitDurationMs = Number(paragraph.getAttribute("d"));
      const nextStartMs = Number(paragraphs[index + 1]?.getAttribute("t"));
      const durationMs = Number.isFinite(explicitDurationMs)
        ? explicitDurationMs
        : Number.isFinite(nextStartMs)
          ? Math.max(250, nextStartMs - startMs)
          : 2000;
      const segments = Array.from(paragraph.querySelectorAll("s"));
      const text = normalizeCaptionText(
        segments.length > 0
          ? segments.map((segment) => segment.textContent ?? "").join("")
          : paragraph.textContent ?? "",
      );
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(durationMs) ||
        startMs < 0 ||
        durationMs <= 0 ||
        text.length === 0
      ) {
        continue;
      }
      transcript.push({
        start: startMs / 1000,
        duration: durationMs / 1000,
        text,
      });
    }
    return transcript;
  }

  function normalizeCaptionText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  function parseStreamChunk(value: unknown): StreamChunk {
    if (!isRecord(value)) {
      throw new Error("Stream chunk must be a JSON object");
    }
    const start = value.start;
    const end = value.end;
    const audioBase64 = value.audioBase64;
    const suggestedPlaybackRate = value.suggestedPlaybackRate;
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

  function base64ToArrayBuffer(value: string): ArrayBuffer {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  async function waitForVideo(): Promise<HTMLVideoElement> {
    const existing = document.querySelector("video");
    if (existing instanceof HTMLVideoElement) {
      return existing;
    }
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timed out waiting for YouTube video element"));
      }, 15000);
      const observer = new MutationObserver(() => {
        const video = document.querySelector("video");
        if (video instanceof HTMLVideoElement) {
          window.clearTimeout(timeoutId);
          observer.disconnect();
          resolve(video);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
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

  function formatErrorStatus(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return `Live Video Translation: ${error.message}`;
    }
    return "Live Video Translation could not start on this YouTube page.";
  }

  new YouTubeTranslationController().start();
})();
