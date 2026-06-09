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
    transcriptFallback?: YouTubeTranscriptFallback;
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

  interface YouTubeTranscriptFallback {
    innertubeApiKey?: string;
    innertubeContext?: Record<string, unknown>;
    params?: string;
    videoId?: string;
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
  const AD_RETRY_DELAY_MS = 1000;
  const STATUS_COPY_RESET_MS = 1600;
  const STREAM_PORT_NAME = "translation-stream";
  const FALLBACK_MESSAGES: Record<string, string> = {
    adWaitingStatus: "Waiting for the YouTube ad to finish before starting translation.",
    captionsEmptyError: "The selected caption track is empty.",
    captionsUnavailableError: "No caption track is available for the selected language.",
    connectionClosedError: "Live translation connection closed unexpectedly.",
    copiedErrorButton: "Copied",
    copyErrorButton: "Copy error",
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
    private adRetryTimer: number | null = null;

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
      this.clearAdRetry();
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
      if (isYouTubeAdShowing(video)) {
        this.teardown();
        showStatus(localizedMessage("adWaitingStatus"), "info");
        this.scheduleAdRetry();
        return;
      }

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
      const pageVideoId = resolvePageVideoId();
      if (pageVideoId !== null && videoId !== pageVideoId) {
        this.teardown();
        showStatus(localizedMessage("adWaitingStatus"), "info");
        this.scheduleAdRetry();
        return;
      }
      if (this.activeVideoId === videoId) {
        return;
      }
      this.teardown();
      this.currentVideo = video;

      const sourceLanguage = runState.sourceLanguage;
      const targetLanguage = runState.targetLanguage;
      const tracks = chooseCaptionTracks(playerResponse, sourceLanguage);
      if (tracks.length === 0 && !hasInnertubeTranscriptFallback(playerResponse)) {
        showStatus(localizedMessage("captionsUnavailableError"), "error");
        return;
      }
      let transcript: TranscriptItem[];
      try {
        transcript = await fetchTranscriptWithFallback(tracks, playerResponse);
      } catch (error: unknown) {
        if (isYouTubeAdShowing(video)) {
          showStatus(localizedMessage("adWaitingStatus"), "info");
          this.scheduleAdRetry();
          return;
        }
        throw error;
      }
      if (transcript.length === 0) {
        showStatus(localizedMessage("captionsEmptyError"), "error");
        return;
      }
      this.activeVideoId = videoId;
      this.scheduler = new AudioChunkScheduler(video);
      this.openStream(videoId, transcript, sourceLanguage, targetLanguage);
    }

    private scheduleAdRetry(): void {
      this.clearAdRetry();
      this.adRetryTimer = window.setTimeout(() => {
        this.adRetryTimer = null;
        this.queueBootstrap();
      }, AD_RETRY_DELAY_MS);
    }

    private clearAdRetry(): void {
      if (this.adRetryTimer !== null) {
        window.clearTimeout(this.adRetryTimer);
        this.adRetryTimer = null;
      }
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
          max-width: min(420px, calc(100vw - 32px));
          max-height: min(45vh, 360px);
          overflow: auto;
          border: 1px solid #b8c1d1;
          border-radius: 6px;
          padding: 10px 12px;
          background: #ffffff;
          color: #172033;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
          font: 13px/1.4 Arial, sans-serif;
          pointer-events: auto;
        }
        .status[data-kind="error"] {
          border-color: #f0b8b3;
          color: #8f1d17;
        }
        .message {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 10px;
        }
        .actions[hidden] {
          display: none;
        }
        button {
          appearance: none;
          border: 1px solid #b8c1d1;
          border-radius: 5px;
          padding: 6px 9px;
          background: #f8fafc;
          color: #172033;
          cursor: pointer;
          font: 12px/1 Arial, sans-serif;
        }
        button:hover {
          background: #eef2f7;
        }
      `;
      const status = document.createElement("div");
      status.className = "status";
      status.id = "status";
      const messageElement = document.createElement("div");
      messageElement.className = "message";
      messageElement.id = "status-message";
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.id = "status-actions";
      const copyButton = document.createElement("button");
      copyButton.id = "copy-error";
      copyButton.type = "button";
      copyButton.addEventListener("click", () => {
        void copyStatusReport(copyButton.dataset.report ?? messageElement.textContent ?? "").then(
          () => {
            copyButton.textContent = localizedMessage("copiedErrorButton");
            window.setTimeout(() => {
              copyButton.textContent = localizedMessage("copyErrorButton");
            }, STATUS_COPY_RESET_MS);
          },
        );
      });
      actions.append(copyButton);
      status.append(messageElement, actions);
      shadow.append(style, status);
      document.documentElement.append(host);
    }
    const shadowStatus = host.shadowRoot?.getElementById("status");
    const shadowMessage = host.shadowRoot?.getElementById("status-message");
    const shadowActions = host.shadowRoot?.getElementById("status-actions");
    const shadowCopyButton = host.shadowRoot?.getElementById("copy-error");
    if (shadowStatus instanceof HTMLElement) {
      shadowStatus.dataset.kind = kind;
    }
    if (shadowMessage instanceof HTMLElement) {
      shadowMessage.textContent = message;
    }
    if (shadowActions instanceof HTMLElement) {
      shadowActions.hidden = kind !== "error";
    }
    if (shadowCopyButton instanceof HTMLButtonElement) {
      shadowCopyButton.textContent = localizedMessage("copyErrorButton");
      shadowCopyButton.dataset.report = buildStatusReport(message);
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
    return resolvePageVideoId();
  }

  function resolvePageVideoId(): string | null {
    const url = new URL(window.location.href);
    const watchVideoId = url.searchParams.get("v");
    if (watchVideoId !== null && watchVideoId.length > 0) {
      return watchVideoId;
    }
    const shortsMatch = /^\/shorts\/([^/?#]+)/.exec(url.pathname);
    return shortsMatch?.[1] ?? null;
  }

  function chooseCaptionTracks(
    playerResponse: YouTubePlayerResponse,
    preferredLanguage: string,
  ): CaptionTrack[] {
    const tracks =
      playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) {
      return [];
    }
    return uniqueTracks([
      ...tracks.filter(
        (track) => trackMatchesLanguage(track, preferredLanguage) && track.kind !== "asr",
      ),
      ...tracks.filter((track) => trackMatchesLanguage(track, preferredLanguage)),
      ...tracks.filter((track) => track.languageCode?.startsWith("en") && track.kind !== "asr"),
      ...tracks.filter((track) => track.kind !== "asr"),
      ...tracks.filter((track) => track.languageCode?.startsWith("en")),
      ...tracks,
    ]);
  }

  function uniqueTracks(tracks: CaptionTrack[]): CaptionTrack[] {
    const seen = new Set<string>();
    const result: CaptionTrack[] = [];
    for (const track of tracks) {
      const key = track.baseUrl;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(track);
    }
    return result;
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

  async function fetchTranscriptFromTracks(tracks: CaptionTrack[]): Promise<TranscriptItem[]> {
    const errors: string[] = [];
    for (const track of tracks) {
      try {
        const transcript = await fetchTranscript(track);
        if (transcript.length > 0) {
          return transcript;
        }
      } catch (error: unknown) {
        const language = track.languageCode ?? "unknown";
        const kind = track.kind ?? "manual";
        errors.push(
          `${language}/${kind}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    throw new Error(
      `Caption fetch failed for all tracks (${summarizeCaptionTracks(tracks)}): ${errors.join(
        " | ",
      )}`,
    );
  }

  async function fetchTranscriptWithFallback(
    tracks: CaptionTrack[],
    playerResponse: YouTubePlayerResponse,
  ): Promise<TranscriptItem[]> {
    let trackError: Error | null = null;
    if (tracks.length > 0) {
      try {
        return await fetchTranscriptFromTracks(tracks);
      } catch (error: unknown) {
        trackError = normalizeError(error);
      }
    }

    if (hasInnertubeTranscriptFallback(playerResponse)) {
      try {
        const transcript = await fetchInnertubeTranscript(playerResponse.transcriptFallback);
        if (transcript.length > 0) {
          return transcript;
        }
      } catch (error: unknown) {
        const fallbackError = normalizeError(error);
        if (trackError !== null) {
          throw new Error(
            `${trackError.message}; innertube transcript fallback failed: ${fallbackError.message}`,
          );
        }
        throw fallbackError;
      }
    }

    if (trackError !== null) {
      throw trackError;
    }
    return [];
  }

  function hasInnertubeTranscriptFallback(
    playerResponse: YouTubePlayerResponse,
  ): playerResponse is YouTubePlayerResponse & { transcriptFallback: YouTubeTranscriptFallback } {
    const fallback = playerResponse.transcriptFallback;
    return (
      fallback !== undefined &&
      typeof fallback.innertubeApiKey === "string" &&
      fallback.innertubeApiKey.length > 0 &&
      isRecord(fallback.innertubeContext) &&
      typeof fallback.params === "string" &&
      fallback.params.length > 0
    );
  }

  async function fetchInnertubeTranscript(
    fallback: YouTubeTranscriptFallback,
  ): Promise<TranscriptItem[]> {
    const apiKey = fallback.innertubeApiKey;
    const context = fallback.innertubeContext;
    const params = fallback.params;
    if (
      typeof apiKey !== "string" ||
      apiKey.length === 0 ||
      !isRecord(context) ||
      typeof params !== "string" ||
      params.length === 0
    ) {
      throw new Error("YouTube transcript fallback metadata is incomplete");
    }

    const errors: string[] = [];
    const endpoint = `/youtubei/v1/get_transcript?key=${encodeURIComponent(
      apiKey,
    )}&prettyPrint=false`;
    const paramsCandidates = uniqueStrings([params, safeDecodeURIComponent(params)]);
    for (const candidate of paramsCandidates) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            context,
            params: candidate,
            externalVideoId: fallback.videoId ?? resolvePageVideoId() ?? undefined,
          }),
        });
        const body = await response.text();
        if (!response.ok) {
          errors.push(`HTTP ${response.status}: ${body.slice(0, 240)}`);
          continue;
        }
        if (body.trim().length === 0) {
          errors.push("empty response");
          continue;
        }
        const transcript = parseInnertubeTranscript(JSON.parse(body));
        if (transcript.length > 0) {
          return transcript;
        }
        errors.push("response did not contain transcript segments");
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : "unknown error");
      }
    }
    throw new Error(`YouTube transcript panel fallback failed: ${errors.join("; ")}`);
  }

  async function fetchTranscript(track: CaptionTrack): Promise<TranscriptItem[]> {
    const errors: string[] = [];
    for (const format of ["json3", "srv3", "default", "vtt"] as const) {
      const url = new URL(track.baseUrl);
      if (format === "default") {
        url.searchParams.delete("fmt");
      } else {
        url.searchParams.set("fmt", format);
      }
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
            : format === "vtt"
              ? parseVttTranscript(body)
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

  function parseVttTranscript(vtt: string): TranscriptItem[] {
    const blocks = vtt
      .replace(/\r/g, "")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0 && !block.startsWith("WEBVTT"));
    const transcript: TranscriptItem[] = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim());
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) {
        continue;
      }
      const timing = lines[timingIndex];
      if (timing === undefined) {
        continue;
      }
      const [startRaw, endRaw] = timing.split("-->").map((part) => part.trim().split(/\s+/, 1)[0]);
      if (startRaw === undefined || endRaw === undefined) {
        continue;
      }
      const start = parseVttTime(startRaw);
      const end = parseVttTime(endRaw);
      const text = normalizeCaptionText(
        lines
          .slice(timingIndex + 1)
          .join(" ")
          .replace(/<[^>]+>/g, ""),
      );
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        text.length === 0
      ) {
        continue;
      }
      transcript.push({ start, duration: end - start, text });
    }
    return transcript;
  }

  function parseVttTime(value: string): number {
    const parts = value.split(":");
    const secondsPart = parts.pop();
    if (secondsPart === undefined) {
      return Number.NaN;
    }
    const seconds = Number(secondsPart.replace(",", "."));
    const minutes = Number(parts.pop() ?? "0");
    const hours = Number(parts.pop() ?? "0");
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return Number.NaN;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }

  function parseInnertubeTranscript(value: unknown): TranscriptItem[] {
    const fromSegments = findObjectsByKey(value, "transcriptSegmentRenderer")
      .map(parseInnertubeSegment)
      .filter((item): item is TranscriptItem => item !== null);
    if (fromSegments.length > 0) {
      return normalizeTranscriptDurations(fromSegments);
    }

    const fromCueGroups = findObjectsByKey(value, "transcriptCueGroupRenderer")
      .map(parseInnertubeCueGroup)
      .filter((item): item is TranscriptItem => item !== null);
    return normalizeTranscriptDurations(fromCueGroups);
  }

  function parseInnertubeSegment(value: unknown): TranscriptItem | null {
    if (!isRecord(value)) {
      return null;
    }
    const startMs = Number(value.startMs);
    const endMs = Number(value.endMs);
    const text = normalizeCaptionText(extractRunsText(value.snippet));
    if (!Number.isFinite(startMs) || startMs < 0 || text.length === 0) {
      return null;
    }
    const duration =
      Number.isFinite(endMs) && endMs > startMs ? (endMs - startMs) / 1000 : 0;
    return { start: startMs / 1000, duration, text };
  }

  function parseInnertubeCueGroup(value: unknown): TranscriptItem | null {
    if (!isRecord(value)) {
      return null;
    }
    const start = parseTimestampText(extractRunsText(value.formattedStartOffset));
    const cues = Array.isArray(value.cues) ? value.cues : [];
    const text = normalizeCaptionText(
      cues
        .map((cue) => {
          if (!isRecord(cue) || !isRecord(cue.transcriptCueRenderer)) {
            return "";
          }
          return extractRunsText(cue.transcriptCueRenderer.cue);
        })
        .join(" "),
    );
    if (!Number.isFinite(start) || start < 0 || text.length === 0) {
      return null;
    }
    return { start, duration: 0, text };
  }

  function normalizeTranscriptDurations(items: TranscriptItem[]): TranscriptItem[] {
    const sorted = items
      .filter((item) => item.text.length > 0 && Number.isFinite(item.start) && item.start >= 0)
      .sort((left, right) => left.start - right.start);
    return sorted.map((item, index) => {
      const next = sorted[index + 1];
      const inferredDuration =
        next !== undefined ? Math.max(0.25, next.start - item.start) : 2;
      return {
        start: item.start,
        duration: item.duration > 0 ? item.duration : inferredDuration,
        text: item.text,
      };
    });
  }

  function findObjectsByKey(value: unknown, key: string): unknown[] {
    const result: unknown[] = [];
    const visit = (current: unknown): void => {
      if (Array.isArray(current)) {
        for (const item of current) {
          visit(item);
        }
        return;
      }
      if (!isRecord(current)) {
        return;
      }
      const matching = current[key];
      if (matching !== undefined) {
        result.push(matching);
      }
      for (const child of Object.values(current)) {
        visit(child);
      }
    };
    visit(value);
    return result;
  }

  function extractRunsText(value: unknown): string {
    if (!isRecord(value)) {
      return "";
    }
    if (typeof value.simpleText === "string") {
      return value.simpleText;
    }
    if (!Array.isArray(value.runs)) {
      return "";
    }
    return value.runs
      .map((run) => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
      .join("");
  }

  function parseTimestampText(value: string): number {
    const parts = value.trim().split(":");
    if (parts.length === 0 || parts.length > 3) {
      return Number.NaN;
    }
    let seconds = 0;
    for (const part of parts) {
      const numeric = Number(part.replace(",", "."));
      if (!Number.isFinite(numeric) || numeric < 0) {
        return Number.NaN;
      }
      seconds = seconds * 60 + numeric;
    }
    return seconds;
  }

  function normalizeCaptionText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  function summarizeCaptionTracks(tracks: CaptionTrack[]): string {
    return (
      tracks
        .map((track) => `${track.languageCode ?? "unknown"}/${track.kind ?? "manual"}`)
        .join(", ") || "none"
    );
  }

  function uniqueStrings(values: Array<string | null>): string[] {
    return Array.from(
      new Set(values.filter((value): value is string => value !== null && value.length > 0)),
    );
  }

  function safeDecodeURIComponent(value: string): string | null {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
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

  function isYouTubeAdShowing(video?: HTMLVideoElement): boolean {
    const player = getMoviePlayerElement(video);
    if (player === null) {
      return false;
    }
    return (
      player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")
    );
  }

  function getMoviePlayerElement(video?: HTMLVideoElement): HTMLElement | null {
    const fromVideo = video?.closest("#movie_player");
    if (fromVideo instanceof HTMLElement) {
      return fromVideo;
    }
    const player = document.getElementById("movie_player");
    return player instanceof HTMLElement ? player : null;
  }

  function buildStatusReport(message: string): string {
    const video = document.querySelector("video");
    const player = getMoviePlayerElement(video instanceof HTMLVideoElement ? video : undefined);
    return [
      "Live Video Translation diagnostic report",
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `Page video ID: ${resolvePageVideoId() ?? "unknown"}`,
      `Ad showing: ${isYouTubeAdShowing(video instanceof HTMLVideoElement ? video : undefined)}`,
      `Player classes: ${player?.className.toString() ?? "unknown"}`,
      `Message: ${message}`,
    ].join("\n");
  }

  async function copyStatusReport(report: string): Promise<void> {
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(report);
        return;
      } catch {
        // Fall back to the legacy copy path below.
      }
    }
    const textArea = document.createElement("textarea");
    textArea.value = report;
    textArea.setAttribute("readonly", "true");
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.documentElement.append(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
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

  function normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(typeof error === "string" ? error : "unknown error");
  }

  new YouTubeTranslationController().start();
})();
