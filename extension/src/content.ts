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
    token: string;
    transcript: TranscriptItem[];
  }

  interface StreamChunk {
    start: number;
    end: number;
    audioBase64: string;
    suggestedPlaybackRate: number;
  }

  interface ExtensionSettings {
    authToken: string;
    backendWssUrl: string;
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
  const CONFIG_KEYS = ["authToken", "backendWssUrl"] as const;

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
    private socket: WebSocket | null = null;
    private scheduler: AudioChunkScheduler | null = null;
    private navigationTimer: number | null = null;

    start(): void {
      this.queueBootstrap();
      window.addEventListener("yt-navigate-finish", this.queueBootstrap);
      window.addEventListener("pageshow", this.queueBootstrap);
      window.addEventListener("popstate", this.queueBootstrap);
    }

    private readonly queueBootstrap = (): void => {
      if (this.navigationTimer !== null) {
        window.clearTimeout(this.navigationTimer);
      }
      this.navigationTimer = window.setTimeout(() => {
        this.navigationTimer = null;
        void this.bootstrap().catch((error: unknown) => {
          console.error("[Live Video Translation]", error);
        });
      }, 500);
    };

    private async bootstrap(): Promise<void> {
      const video = await waitForVideo();
      const playerResponse = extractInitialPlayerResponse();
      if (playerResponse === null) {
        throw new Error("ytInitialPlayerResponse was not found");
      }
      const videoId = resolveVideoId(playerResponse);
      if (videoId === null) {
        throw new Error("YouTube video id was not found");
      }
      if (this.activeVideoId === videoId) {
        return;
      }
      this.teardown();
      this.activeVideoId = videoId;

      const track = chooseCaptionTrack(playerResponse);
      if (track === null) {
        throw new Error("No YouTube caption track is available for this video");
      }
      const transcript = await fetchTranscript(track);
      if (transcript.length === 0) {
        throw new Error("Caption track did not contain transcript items");
      }
      const settings = await loadSettings();
      video.muted = true;
      this.scheduler = new AudioChunkScheduler(video);
      this.openStream(settings, videoId, transcript);
    }

    private openStream(
      settings: ExtensionSettings,
      videoId: string,
      transcript: TranscriptItem[],
    ): void {
      const socket = new WebSocket(settings.backendWssUrl);
      this.socket = socket;
      socket.addEventListener("open", () => {
        const request: StreamRequest = {
          videoId,
          platform: "youtube",
          token: settings.authToken,
          transcript,
        };
        socket.send(JSON.stringify(request));
      });
      socket.addEventListener("message", (event) => {
        void this.handleStreamMessage(event.data).catch((error: unknown) => {
          console.error("[Live Video Translation]", error);
        });
      });
      socket.addEventListener("close", (event) => {
        if (event.code !== 1000) {
          console.error(
            "[Live Video Translation] WebSocket closed",
            event.code,
            event.reason,
          );
        }
      });
      socket.addEventListener("error", () => {
        console.error("[Live Video Translation] WebSocket error");
      });
    }

    private async handleStreamMessage(data: unknown): Promise<void> {
      const scheduler = this.scheduler;
      if (scheduler === null) {
        return;
      }
      if (typeof data !== "string") {
        throw new Error("WebSocket message was not text JSON");
      }
      const chunk = parseStreamChunk(JSON.parse(data));
      await scheduler.addChunk(chunk);
    }

    private teardown(): void {
      if (this.socket !== null) {
        this.socket.close(1000, "Navigated away");
        this.socket = null;
      }
      if (this.scheduler !== null) {
        this.scheduler.dispose();
        this.scheduler = null;
      }
    }
  }

  function extractInitialPlayerResponse(): YouTubePlayerResponse | null {
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
        return JSON.parse(json) as YouTubePlayerResponse;
      } catch {
        continue;
      }
    }
    return null;
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

  function chooseCaptionTrack(playerResponse: YouTubePlayerResponse): CaptionTrack | null {
    const tracks =
      playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) {
      return null;
    }
    return (
      tracks.find((track) => track.languageCode?.startsWith("en") && track.kind !== "asr") ??
      tracks.find((track) => track.kind !== "asr") ??
      tracks.find((track) => track.languageCode?.startsWith("en")) ??
      tracks[0] ??
      null
    );
  }

  async function fetchTranscript(track: CaptionTrack): Promise<TranscriptItem[]> {
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");
    const response = await fetch(url.toString(), { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Caption fetch failed with HTTP ${response.status}`);
    }
    const timedText = (await response.json()) as YouTubeTimedTextResponse;
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

  async function loadSettings(): Promise<ExtensionSettings> {
    const stored = (await chrome.storage.local.get([...CONFIG_KEYS])) as Partial<ExtensionSettings>;
    const authToken = typeof stored.authToken === "string" ? stored.authToken.trim() : "";
    const backendWssUrl =
      typeof stored.backendWssUrl === "string" ? stored.backendWssUrl.trim() : "";
    if (authToken.length === 0) {
      throw new Error("Missing authToken in chrome.storage.local");
    }
    assertWssUrl(backendWssUrl);
    return { authToken, backendWssUrl };
  }

  function assertWssUrl(value: string): void {
    const url = new URL(value);
    if (url.protocol !== "wss:") {
      throw new Error("backendWssUrl must use the wss:// protocol");
    }
    if (!url.pathname.endsWith("/stream")) {
      throw new Error("backendWssUrl must point to the /stream endpoint");
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

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  new YouTubeTranslationController().start();
})();
