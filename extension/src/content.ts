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
    voiceGender: VoiceGender;
    voicePitch: VoicePitch;
    preserveVoicePitch: boolean;
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
    voiceGender?: string;
    voicePitch?: string;
    preserveVoicePitch?: boolean;
    uiLanguage?: string;
    error?: string;
  }

  interface RunState {
    enabled: boolean;
    configured: boolean;
    sourceLanguage: string;
    targetLanguage: string;
    voiceGender: VoiceGender;
    voicePitch: VoicePitch;
    preserveVoicePitch: boolean;
    uiLanguage: string;
  }

  type VoiceGender = "male" | "female";
  type VoicePitch = "normal" | "high" | "low";

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
    audioUrl: string;
  }

  interface ActiveMediaElement {
    audio: HTMLAudioElement;
    sourceNode: MediaElementAudioSourceNode;
    timerId: number | null;
  }

  interface StatusAction {
    label: string;
    onClick: () => void | Promise<void>;
  }

  const SCHEDULE_AHEAD_SECONDS = 0.2;
  const LATE_TOLERANCE_SECONDS = 2;
  const STALE_CHUNK_SECONDS = 30;
  const TRANSCRIPT_LOOKBACK_SECONDS = 0.75;
  const STREAM_LOOKAHEAD_SECONDS = 120;
  const STREAM_REFRESH_MARGIN_SECONDS = 45;
  const STREAM_RESTART_MIN_DELAY_MS = 1500;
  const STREAM_RESTART_MAX_DELAY_MS = 30000;
  const MERGED_TRANSCRIPT_TARGET_SECONDS = 16;
  const MERGED_TRANSCRIPT_MAX_CHARS = 1600;
  const MERGED_TRANSCRIPT_MAX_ITEMS = 8;
  const INITIAL_AUDIO_BUFFER_SECONDS = 4;
  const INITIAL_AUDIO_BUFFER_MAX_WAIT_MS = 8000;
  const BUFFER_UNDERRUN_GUARD_SECONDS = 0.9;
  const BUFFER_GUARD_INTERVAL_MS = 500;
  const AD_RETRY_DELAY_MS = 1000;
  const STATUS_COPY_RESET_MS = 1600;
  const TRANSCRIPT_PANEL_WAIT_MS = 12000;
  const TRANSCRIPT_PANEL_POLL_MS = 250;
  const PITCH_PRESERVE_RATE_EPSILON = 0.02;
  const STREAM_PORT_NAME = "translation-stream";
  let activeUiLanguage = "system";
  let activeMessages: Record<string, string> = {};
  const FALLBACK_MESSAGES: Record<string, string> = {
    adWaitingStatus: "Waiting for the YouTube ad to finish before starting translation.",
    audioBlockedStatus:
      "Click Enable audio once so Chrome can allow translated speech on this YouTube tab.",
    audioReadyStatus:
      "Translated audio is active. If you cannot hear it, click Test audio.",
    captionsEmptyError: "The selected caption track is empty.",
    captionsUnavailableError: "No caption track is available for the selected language.",
    connectionClosedError: "Live translation connection closed unexpectedly.",
    copiedErrorButton: "Copied",
    copyErrorButton: "Copy error",
    disabledStatus:
      "Live Video Translation is ready. Open the extension, enter your token, enable translation, and save.",
    enableAudioButton: "Enable audio",
    metadataError: "Could not read the current YouTube video metadata.",
    notConfiguredStatus:
      "Live translation is enabled but not configured. Open the extension popup.",
    preparingAudioStatus: "Live translation is preparing audio.",
    testAudioButton: "Test audio",
    videoIdError: "Could not identify the current YouTube video.",
  };

  class AudioChunkScheduler {
    private readonly video: HTMLVideoElement;
    private readonly onAudioStateChanged: (state: AudioContextState) => void;
    private readonly preserveVoicePitch: boolean;
    private readonly chunks = new Map<number, DecodedAudioChunk>();
    private readonly scheduledKeys = new Set<number>();
    private readonly activeSources = new Map<AudioBufferSourceNode, number>();
    private readonly activeMediaElements = new Set<ActiveMediaElement>();
    private audioContext: AudioContext | null = null;
    private gainNode: GainNode | null = null;
    private animationFrameId: number | null = null;
    private nextScheduledContextTime = 0;

    constructor(
      video: HTMLVideoElement,
      onAudioStateChanged: (state: AudioContextState) => void,
      preserveVoicePitch: boolean,
    ) {
      this.video = video;
      this.onAudioStateChanged = onAudioStateChanged;
      this.preserveVoicePitch = preserveVoicePitch;
      this.video.addEventListener("play", this.onPlaybackResumed);
      this.video.addEventListener("pause", this.onPlaybackInterrupted);
      this.video.addEventListener("seeking", this.onPlaybackInterrupted);
      this.video.addEventListener("ratechange", this.onRateChanged);
    }

    async addChunk(chunk: StreamChunk): Promise<void> {
      const context = this.getAudioContext();
      const audioData = base64ToArrayBuffer(chunk.audioBase64);
      const buffer = await context.decodeAudioData(audioData.slice(0));
      const audioUrl = URL.createObjectURL(
        new Blob([audioData], { type: detectAudioMimeType(audioData) }),
      );
      this.chunks.set(chunk.start, {
        start: chunk.start,
        end: chunk.end,
        playbackRate: chunk.suggestedPlaybackRate,
        buffer,
        audioUrl,
      });
      this.startLoop();
    }

    async unlockAudio(): Promise<AudioContextState> {
      const context = this.getAudioContext();
      await context.resume();
      this.notifyAudioState();
      this.startLoop();
      return context.state;
    }

    async playTestTone(): Promise<AudioContextState> {
      const context = this.getAudioContext();
      await context.resume();
      const gainNode = this.gainNode;
      if (gainNode === null) {
        return context.state;
      }
      const oscillator = context.createOscillator();
      const toneGain = context.createGain();
      const startAt = context.currentTime + 0.03;
      const stopAt = startAt + 0.45;
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      toneGain.gain.setValueAtTime(0.0001, startAt);
      toneGain.gain.exponentialRampToValueAtTime(0.25, startAt + 0.04);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
      oscillator.connect(toneGain);
      toneGain.connect(gainNode);
      oscillator.start(startAt);
      oscillator.stop(stopAt + 0.03);
      oscillator.onended = () => {
        oscillator.disconnect();
        toneGain.disconnect();
      };
      this.notifyAudioState();
      return context.state;
    }

    isAudioRunning(): boolean {
      return this.audioContext?.state === "running";
    }

    getAudioState(): AudioContextState | "not-created" {
      return this.audioContext?.state ?? "not-created";
    }

    getBufferedChunkCount(): number {
      return this.chunks.size;
    }

    getBufferedAheadSeconds(currentTime: number): number {
      let cursor = currentTime;
      let bufferedSeconds = 0;
      const chunks = Array.from(this.chunks.values()).sort((left, right) => left.start - right.start);
      for (const chunk of chunks) {
        if (chunk.end <= cursor) {
          continue;
        }
        if (chunk.start > cursor + 0.6) {
          break;
        }
        const availableStart = Math.max(cursor, chunk.start);
        bufferedSeconds += Math.max(0, chunk.end - availableStart);
        cursor = Math.max(cursor, chunk.end);
      }
      return bufferedSeconds;
    }

    dispose(): void {
      if (this.animationFrameId !== null) {
        window.cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.stopActiveSources();
      this.clearChunks();
      this.scheduledKeys.clear();
      this.video.removeEventListener("play", this.onPlaybackResumed);
      this.video.removeEventListener("pause", this.onPlaybackInterrupted);
      this.video.removeEventListener("seeking", this.onPlaybackInterrupted);
      this.video.removeEventListener("ratechange", this.onRateChanged);
    }

    resetQueue(): void {
      this.stopActiveSources();
      this.clearChunks();
      this.scheduledKeys.clear();
    }

    private readonly onPlaybackResumed = (): void => {
      void this.unlockAudio().catch((error: unknown) => {
        console.warn("[Live Video Translation] AudioContext resume failed", error);
        this.notifyAudioState();
      });
      this.startLoop();
    };

    private readonly onPlaybackInterrupted = (): void => {
      this.stopActiveSources();
      this.scheduledKeys.clear();
    };

    private readonly onRateChanged = (): void => {
      if (this.preserveVoicePitch) {
        this.stopActiveSources();
        this.scheduledKeys.clear();
        this.startLoop();
        return;
      }
      for (const [source, chunkRate] of this.activeSources) {
        source.playbackRate.value = clampPlaybackRate(this.video.playbackRate * chunkRate);
      }
    };

    private getAudioContext(): AudioContext {
      if (this.audioContext === null) {
        this.audioContext = new AudioContext();
        this.audioContext.addEventListener("statechange", () => {
          this.notifyAudioState();
        });
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1;
        this.gainNode.connect(this.audioContext.destination);
        this.notifyAudioState();
      }
      return this.audioContext;
    }

    private notifyAudioState(): void {
      if (this.audioContext !== null) {
        this.onAudioStateChanged(this.audioContext.state);
      }
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
          this.deleteChunk(key);
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
      void this.unlockAudio().catch((error: unknown) => {
        console.warn("[Live Video Translation] AudioContext resume failed", error);
        this.notifyAudioState();
      });
      const effectivePlaybackRate = clampPlaybackRate(this.video.playbackRate * chunk.playbackRate);
      if (
        this.preserveVoicePitch &&
        Math.abs(effectivePlaybackRate - 1) > PITCH_PRESERVE_RATE_EPSILON &&
        supportsMediaElementPitchPreservation()
      ) {
        this.scheduleMediaElementChunk(key, chunk, currentTime, effectivePlaybackRate);
        return;
      }
      this.scheduleBufferSourceChunk(key, chunk, currentTime, effectivePlaybackRate);
    }

    private scheduleBufferSourceChunk(
      key: number,
      chunk: DecodedAudioChunk,
      currentTime: number,
      effectivePlaybackRate: number,
    ): void {
      const context = this.getAudioContext();
      const gainNode = this.gainNode;
      if (gainNode === null) {
        return;
      }
      const source = context.createBufferSource();
      source.buffer = chunk.buffer;
      source.playbackRate.value = effectivePlaybackRate;
      source.connect(gainNode);
      source.onended = () => {
        this.activeSources.delete(source);
      };

      const startDelay = Math.max(0, chunk.start - currentTime);
      const requestedWhen = context.currentTime + startDelay;
      const audioOffset = calculateAudioOffset(chunk, chunk.buffer, currentTime);
      const when = Math.max(requestedWhen, this.nextScheduledContextTime);
      this.activeSources.set(source, chunk.playbackRate);
      this.scheduledKeys.add(key);
      try {
        source.start(when, audioOffset);
        const remainingSeconds = Math.max(0, chunk.buffer.duration - audioOffset);
        this.nextScheduledContextTime = Math.max(
          this.nextScheduledContextTime,
          when + remainingSeconds / source.playbackRate.value,
        );
      } catch (error: unknown) {
        this.activeSources.delete(source);
        console.warn("[Live Video Translation] Audio source scheduling failed", error);
      }
    }

    private scheduleMediaElementChunk(
      key: number,
      chunk: DecodedAudioChunk,
      currentTime: number,
      effectivePlaybackRate: number,
    ): void {
      const context = this.getAudioContext();
      const gainNode = this.gainNode;
      if (gainNode === null) {
        return;
      }
      const audio = new Audio(chunk.audioUrl);
      audio.preload = "auto";
      audio.playbackRate = effectivePlaybackRate;
      audio.defaultPlaybackRate = effectivePlaybackRate;
      setMediaElementPreservesPitch(audio, true);

      let sourceNode: MediaElementAudioSourceNode;
      try {
        sourceNode = context.createMediaElementSource(audio);
        sourceNode.connect(gainNode);
      } catch (error: unknown) {
        console.warn("[Live Video Translation] MediaElementAudioSource setup failed", error);
        this.scheduleBufferSourceChunk(key, chunk, currentTime, effectivePlaybackRate);
        return;
      }

      const startDelay = Math.max(0, chunk.start - currentTime);
      const requestedWhen = context.currentTime + startDelay;
      const audioOffset = calculateAudioOffset(chunk, chunk.buffer, currentTime);
      const when = Math.max(requestedWhen, this.nextScheduledContextTime);
      const remainingSeconds = Math.max(0, chunk.buffer.duration - audioOffset);
      const mediaElement: ActiveMediaElement = {
        audio,
        sourceNode,
        timerId: null,
      };
      const cleanup = (): void => {
        this.activeMediaElements.delete(mediaElement);
        try {
          sourceNode.disconnect();
        } catch {
          // The node can already be disconnected by a stop or error path.
        }
      };
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      this.activeMediaElements.add(mediaElement);
      this.scheduledKeys.add(key);
      this.nextScheduledContextTime = Math.max(
        this.nextScheduledContextTime,
        when + remainingSeconds / effectivePlaybackRate,
      );

      const play = (): void => {
        mediaElement.timerId = null;
        try {
          audio.currentTime = audioOffset;
        } catch {
          // Some decoders reject seeking until metadata is available; playback still starts.
        }
        void audio.play().catch((error: unknown) => {
          cleanup();
          console.warn("[Live Video Translation] Pitch-preserving playback failed", error);
          this.scheduledKeys.delete(key);
          this.scheduleBufferSourceChunk(key, chunk, this.video.currentTime, effectivePlaybackRate);
        });
      };
      const delayMs = Math.max(0, (when - context.currentTime) * 1000);
      if (delayMs <= 20) {
        play();
        return;
      }
      mediaElement.timerId = window.setTimeout(play, delayMs);
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
      for (const mediaElement of this.activeMediaElements) {
        if (mediaElement.timerId !== null) {
          window.clearTimeout(mediaElement.timerId);
        }
        mediaElement.audio.pause();
        mediaElement.audio.removeAttribute("src");
        mediaElement.audio.load();
        try {
          mediaElement.sourceNode.disconnect();
        } catch {
          // The node can already be disconnected by the browser.
        }
      }
      this.activeMediaElements.clear();
      this.nextScheduledContextTime = 0;
    }

    private deleteChunk(key: number): void {
      const chunk = this.chunks.get(key);
      if (chunk !== undefined) {
        URL.revokeObjectURL(chunk.audioUrl);
      }
      this.chunks.delete(key);
      this.scheduledKeys.delete(key);
    }

    private clearChunks(): void {
      for (const chunk of this.chunks.values()) {
        URL.revokeObjectURL(chunk.audioUrl);
      }
      this.chunks.clear();
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
    private streamRestartTimer: number | null = null;
    private bufferGuardTimer: number | null = null;
    private streamWindowEnd: number | null = null;
    private streamRefreshPending = false;
    private bufferingWasPlaying = false;
    private bufferingStartedAt = 0;
    private translatedAudioReady = false;
    private observedVideo: HTMLVideoElement | null = null;

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
      this.clearStreamRestart();
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
      await configureContentLocale(runState.uiLanguage);
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
      const isStreamRefresh = this.activeVideoId === videoId && this.streamRefreshPending;
      if (this.activeVideoId === videoId && !isStreamRefresh) {
        return;
      }
      if (isStreamRefresh) {
        this.streamRefreshPending = false;
        this.closeStreamPort();
        this.currentVideo = video;
      } else {
        this.teardown();
        this.currentVideo = video;
      }
      this.attachVideoRuntimeListeners(video);

      const sourceLanguage = runState.sourceLanguage;
      const targetLanguage = runState.targetLanguage;
      const voiceGender = runState.voiceGender;
      const voicePitch = runState.voicePitch;
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
      const playbackTranscript = transcriptFromCurrentPlayback(transcript, video.currentTime);
      if (playbackTranscript.length === 0) {
        showStatus(localizedMessage("captionsEmptyError"), "error");
        return;
      }
      this.streamWindowEnd = transcriptWindowEnd(playbackTranscript);
      this.activeVideoId = videoId;
      if (this.scheduler === null) {
        this.scheduler = new AudioChunkScheduler(
          video,
          this.onAudioStateChanged,
          runState.preserveVoicePitch,
        );
      }
      this.openStream(
        videoId,
        playbackTranscript,
        sourceLanguage,
        targetLanguage,
        voiceGender,
        voicePitch,
        runState.preserveVoicePitch,
      );
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

    private scheduleStreamRestart(): void {
      const video = this.currentVideo;
      const windowEnd = this.streamWindowEnd;
      if (video === null || video.ended || windowEnd === null) {
        return;
      }
      this.clearStreamRestart();
      if (video.paused) {
        this.streamRestartTimer = window.setTimeout(() => {
          this.streamRestartTimer = null;
          this.scheduleStreamRestart();
        }, STREAM_RESTART_MIN_DELAY_MS);
        return;
      }
      const secondsUntilRefresh = windowEnd - video.currentTime - STREAM_REFRESH_MARGIN_SECONDS;
      const playbackRate = Math.max(0.25, Math.abs(video.playbackRate || 1));
      const delayMs = Math.max(
        STREAM_RESTART_MIN_DELAY_MS,
        Math.min(STREAM_RESTART_MAX_DELAY_MS, (secondsUntilRefresh / playbackRate) * 1000),
      );
      this.streamRestartTimer = window.setTimeout(() => {
        this.streamRestartTimer = null;
        if (
          this.currentVideo !== null &&
          this.streamWindowEnd !== null &&
          this.streamWindowEnd - this.currentVideo.currentTime > STREAM_REFRESH_MARGIN_SECONDS
        ) {
          this.scheduleStreamRestart();
          return;
        }
        this.requestStreamRefresh();
      }, delayMs);
    }

    private requestStreamRefresh(): void {
      if (this.activeVideoId === null || this.streamRefreshPending) {
        return;
      }
      this.streamRefreshPending = true;
      this.queueBootstrap();
    }

    private clearStreamRestart(): void {
      if (this.streamRestartTimer !== null) {
        window.clearTimeout(this.streamRestartTimer);
        this.streamRestartTimer = null;
      }
    }

    private openStream(
      videoId: string,
      transcript: TranscriptItem[],
      sourceLanguage: string,
      targetLanguage: string,
      voiceGender: VoiceGender,
      voicePitch: VoicePitch,
      preserveVoicePitch: boolean,
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
        voiceGender,
        voicePitch,
        preserveVoicePitch,
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
        this.clearBufferGuard();
        this.resumeAfterBuffering();
        this.restoreMutedState();
        showStatus(error, "error");
        return;
      }
      if (message.type === "streamClosed") {
        if (message.code !== 1000) {
          this.clearBufferGuard();
          this.resumeAfterBuffering();
          this.restoreMutedState();
          console.error("[Live Video Translation] WebSocket closed", message);
          showStatus(formatStreamClosedStatus(message), "error");
          return;
        }
        this.scheduleStreamRestart();
        return;
      }
      if (message.type === "streamOpen") {
        this.muteCurrentVideo();
        this.startBufferGuard();
        if (this.shouldPauseForInitialBuffering()) {
          this.pauseForInitialBuffering();
        }
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
      this.translatedAudioReady = true;
      if (this.canResumeBufferedPlayback()) {
        this.resumeAfterBuffering();
        this.showAudioReadyStatus();
        return;
      }
      if (!scheduler.isAudioRunning()) {
        this.showAudioUnlockStatus();
        return;
      }
      this.showBufferingStatus();
    }

    private readonly onAudioStateChanged = (state: AudioContextState): void => {
      if (state === "running" && this.canResumeBufferedPlayback()) {
        this.resumeAfterBuffering();
        this.showAudioReadyStatus();
        return;
      }
      if (state === "running") {
        this.showBufferingStatus();
        return;
      }
      if (this.scheduler !== null) {
        this.showAudioUnlockStatus();
      }
    };

    private showAudioUnlockStatus(): void {
      const scheduler = this.scheduler;
      if (scheduler === null) {
        return;
      }
      const message = `${localizedMessage("audioBlockedStatus")} AudioContext: ${scheduler.getAudioState()}.`;
      showStatus(message, "info", [
        {
          label: localizedMessage("enableAudioButton"),
          onClick: async () => {
            const state = await scheduler.unlockAudio();
            if (state === "running" && this.canResumeBufferedPlayback()) {
              this.resumeAfterBuffering();
              this.showAudioReadyStatus();
              return;
            }
            if (state !== "running") {
              this.showAudioUnlockStatus();
              return;
            }
            this.showBufferingStatus();
          },
        },
        this.createTestAudioAction(scheduler),
      ]);
    }

    private showBufferingStatus(): void {
      const scheduler = this.scheduler;
      const video = this.currentVideo;
      if (scheduler === null || video === null) {
        return;
      }
      const bufferedAhead = scheduler.getBufferedAheadSeconds(video.currentTime);
      showStatus(
        `${localizedMessage("preparingAudioStatus")} Buffer: ${bufferedAhead.toFixed(1)}s, chunks: ${scheduler.getBufferedChunkCount()}.`,
        "info",
        [this.createTestAudioAction(scheduler)],
      );
    }

    private showAudioReadyStatus(): void {
      const scheduler = this.scheduler;
      if (scheduler === null) {
        return;
      }
      showStatus(localizedMessage("audioReadyStatus"), "info", [
        this.createTestAudioAction(scheduler),
      ]);
    }

    private createTestAudioAction(scheduler: AudioChunkScheduler): StatusAction {
      return {
        label: localizedMessage("testAudioButton"),
        onClick: async () => {
          await scheduler.playTestTone();
        },
      };
    }

    private teardown(): void {
      this.activeVideoId = null;
      if (this.port !== null) {
        this.closeStreamPort();
      }
      if (this.scheduler !== null) {
        this.scheduler.dispose();
        this.scheduler = null;
      }
      this.detachVideoRuntimeListeners();
      this.clearStreamRestart();
      this.clearBufferGuard();
      this.bufferingWasPlaying = false;
      this.bufferingStartedAt = 0;
      this.translatedAudioReady = false;
      this.streamWindowEnd = null;
      this.streamRefreshPending = false;
      this.restoreMutedState();
      this.currentVideo = null;
    }

    private closeStreamPort(): void {
      if (this.port === null) {
        return;
      }
      try {
        this.port.postMessage({ type: "stopStream" });
      } catch {
        // The background port may already be disconnected after a completed stream.
      }
      try {
        this.port.disconnect();
      } catch {
        // Disconnect can throw if Chrome already closed the port.
      }
      this.port = null;
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

    private pauseForInitialBuffering(): void {
      const video = this.currentVideo;
      if (video === null || this.bufferingStartedAt > 0) {
        return;
      }
      this.bufferingWasPlaying = !video.paused;
      this.bufferingStartedAt = performance.now();
      if (this.bufferingWasPlaying) {
        video.pause();
      }
    }

    private shouldPauseForInitialBuffering(): boolean {
      const scheduler = this.scheduler;
      const video = this.currentVideo;
      if (scheduler === null || video === null) {
        return true;
      }
      if (!this.translatedAudioReady) {
        return true;
      }
      return scheduler.getBufferedAheadSeconds(video.currentTime) < 2;
    }

    private resumeAfterBuffering(): void {
      const video = this.currentVideo;
      const shouldResume = this.bufferingWasPlaying;
      this.bufferingWasPlaying = false;
      this.bufferingStartedAt = 0;
      if (video !== null && shouldResume && video.paused) {
        void video.play().catch((error: unknown) => {
          console.warn("[Live Video Translation] Could not resume YouTube playback", error);
        });
      }
    }

    private canResumeBufferedPlayback(): boolean {
      const scheduler = this.scheduler;
      const video = this.currentVideo;
      if (scheduler === null || video === null || !this.translatedAudioReady) {
        return false;
      }
      if (!scheduler.isAudioRunning()) {
        return false;
      }
      const bufferedAhead = scheduler.getBufferedAheadSeconds(video.currentTime);
      const waitedLongEnough =
        this.bufferingStartedAt > 0 &&
        performance.now() - this.bufferingStartedAt >= INITIAL_AUDIO_BUFFER_MAX_WAIT_MS;
      return bufferedAhead >= INITIAL_AUDIO_BUFFER_SECONDS || waitedLongEnough;
    }

    private startBufferGuard(): void {
      if (this.bufferGuardTimer !== null) {
        return;
      }
      this.bufferGuardTimer = window.setInterval(() => {
        this.checkBufferGuard();
      }, BUFFER_GUARD_INTERVAL_MS);
    }

    private clearBufferGuard(): void {
      if (this.bufferGuardTimer !== null) {
        window.clearInterval(this.bufferGuardTimer);
        this.bufferGuardTimer = null;
      }
    }

    private checkBufferGuard(): void {
      const scheduler = this.scheduler;
      const video = this.currentVideo;
      if (scheduler === null || video === null || !this.translatedAudioReady) {
        return;
      }
      if (!scheduler.isAudioRunning()) {
        return;
      }
      if (this.bufferingStartedAt > 0) {
        if (this.canResumeBufferedPlayback()) {
          this.resumeAfterBuffering();
          this.showAudioReadyStatus();
        } else {
          this.showBufferingStatus();
        }
        return;
      }
      if (video.paused || video.ended) {
        return;
      }
      if (
        this.streamWindowEnd !== null &&
        this.streamWindowEnd - video.currentTime <= BUFFER_UNDERRUN_GUARD_SECONDS
      ) {
        this.requestStreamRefresh();
        return;
      }
      const bufferedAhead = scheduler.getBufferedAheadSeconds(video.currentTime);
      if (bufferedAhead < BUFFER_UNDERRUN_GUARD_SECONDS) {
        this.pauseForInitialBuffering();
        this.showBufferingStatus();
      }
    }

    private attachVideoRuntimeListeners(video: HTMLVideoElement): void {
      if (this.observedVideo === video) {
        return;
      }
      this.detachVideoRuntimeListeners();
      this.observedVideo = video;
      video.addEventListener("play", this.onVideoPlaybackResumed);
      video.addEventListener("ratechange", this.onVideoRateChanged);
      video.addEventListener("seeking", this.onVideoSeeking);
    }

    private detachVideoRuntimeListeners(): void {
      if (this.observedVideo === null) {
        return;
      }
      this.observedVideo.removeEventListener("play", this.onVideoPlaybackResumed);
      this.observedVideo.removeEventListener("ratechange", this.onVideoRateChanged);
      this.observedVideo.removeEventListener("seeking", this.onVideoSeeking);
      this.observedVideo = null;
    }

    private readonly onVideoPlaybackResumed = (): void => {
      this.scheduleStreamRestart();
    };

    private readonly onVideoRateChanged = (): void => {
      this.scheduleStreamRestart();
    };

    private readonly onVideoSeeking = (): void => {
      if (this.scheduler !== null) {
        this.scheduler.resetQueue();
      }
      this.requestStreamRefresh();
    };
  }

  async function getRunState(): Promise<RunState> {
    try {
      const response = (await chrome.runtime.sendMessage({ type: "getRunState" })) as RunStateResponse;
      if (!response.ok) {
        return defaultRunState();
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
        voiceGender: parseVoiceGender(response.voiceGender),
        voicePitch: parseVoicePitch(response.voicePitch),
        preserveVoicePitch: response.preserveVoicePitch !== false,
        uiLanguage: typeof response.uiLanguage === "string" ? response.uiLanguage : "system",
      };
    } catch {
      return defaultRunState();
    }
  }

  function defaultRunState(): RunState {
    return {
      enabled: false,
      configured: false,
      sourceLanguage: "en",
      targetLanguage: "de",
      voiceGender: "male",
      voicePitch: "normal",
      preserveVoicePitch: true,
      uiLanguage: "system",
    };
  }

  function parseVoiceGender(value: unknown): VoiceGender {
    return value === "female" ? "female" : "male";
  }

  function parseVoicePitch(value: unknown): VoicePitch {
    if (value === "high" || value === "low") {
      return value;
    }
    return "normal";
  }

  function showStatus(message: string, kind: "info" | "error", actions: StatusAction[] = []): void {
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
          gap: 8px;
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
      status.append(messageElement, actions);
      shadow.append(style, status);
      document.documentElement.append(host);
    }
    const shadowStatus = host.shadowRoot?.getElementById("status");
    const shadowMessage = host.shadowRoot?.getElementById("status-message");
    const shadowActions = host.shadowRoot?.getElementById("status-actions");
    if (shadowStatus instanceof HTMLElement) {
      shadowStatus.dataset.kind = kind;
      shadowStatus.dir = isRtlLocale(getEffectiveUiLocale()) ? "rtl" : "ltr";
    }
    if (shadowMessage instanceof HTMLElement) {
      shadowMessage.textContent = message;
    }
    if (shadowActions instanceof HTMLElement) {
      shadowActions.replaceChildren();
      if (kind === "error") {
        shadowActions.append(createCopyReportButton(message));
      }
      for (const action of actions) {
        shadowActions.append(createStatusActionButton(action));
      }
      shadowActions.hidden = kind !== "error" && actions.length === 0;
    }
  }

  function createCopyReportButton(message: string): HTMLButtonElement {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = localizedMessage("copyErrorButton");
    const report = buildStatusReport(message);
    copyButton.addEventListener("click", () => {
      void copyStatusReport(report).then(() => {
        copyButton.textContent = localizedMessage("copiedErrorButton");
        window.setTimeout(() => {
          copyButton.textContent = localizedMessage("copyErrorButton");
        }, STATUS_COPY_RESET_MS);
      });
    });
    return copyButton;
  }

  function createStatusActionButton(action: StatusAction): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      void Promise.resolve(action.onClick()).catch((error: unknown) => {
        showStatus(formatErrorStatus(error), "error");
      });
    });
    return button;
  }

  function hideStatus(): void {
    document.getElementById("lvt-status-host")?.remove();
  }

  async function extractPlayerResponse(): Promise<YouTubePlayerResponse | null> {
    const fromPage = await requestPlayerResponseFromPage();
    const playerResponse = fromPage ?? extractInitialPlayerResponseFromScripts();
    if (playerResponse === null) {
      return null;
    }
    return augmentPlayerResponseWithTranscriptFallback(playerResponse);
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

  function augmentPlayerResponseWithTranscriptFallback(
    playerResponse: YouTubePlayerResponse,
  ): YouTubePlayerResponse {
    if (hasInnertubeTranscriptFallback(playerResponse)) {
      return playerResponse;
    }
    const fallback = extractTranscriptFallbackFromScripts(resolveVideoId(playerResponse));
    if (fallback === null) {
      return playerResponse;
    }
    return {
      ...playerResponse,
      transcriptFallback: fallback,
    };
  }

  function extractTranscriptFallbackFromScripts(
    videoId: string | null = resolvePageVideoId(),
  ): YouTubeTranscriptFallback | null {
    const apiKey = extractInnertubeApiKeyFromScripts();
    const context = extractInnertubeContextFromScripts();
    const params = extractTranscriptParamsFromScripts();
    if (apiKey === null || context === null || params === null) {
      return null;
    }
    const fallback: YouTubeTranscriptFallback = {
      innertubeApiKey: apiKey,
      innertubeContext: context,
      params,
    };
    if (videoId !== null && videoId.length > 0) {
      fallback.videoId = videoId;
    }
    return fallback;
  }

  function extractInnertubeApiKeyFromScripts(): string | null {
    for (const source of getScriptSources()) {
      if (!source.includes("INNERTUBE_API_KEY")) {
        continue;
      }
      const apiKey = extractJsonStringProperty(source, "INNERTUBE_API_KEY");
      if (apiKey !== null) {
        return apiKey;
      }
    }
    return null;
  }

  function extractInnertubeContextFromScripts(): Record<string, unknown> | null {
    for (const source of getScriptSources()) {
      if (!source.includes("INNERTUBE_CONTEXT")) {
        continue;
      }
      const json = extractBalancedJson(source, '"INNERTUBE_CONTEXT"');
      if (json === null) {
        continue;
      }
      try {
        const context = JSON.parse(json) as unknown;
        if (isRecord(context)) {
          return context;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  function extractTranscriptParamsFromScripts(): string | null {
    for (const source of getScriptSources()) {
      if (!source.includes("getTranscriptEndpoint")) {
        continue;
      }
      const match =
        /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"((?:\\.|[^"\\])+)"/.exec(source);
      if (match?.[1] === undefined) {
        continue;
      }
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1];
      }
    }
    return null;
  }

  function extractJsonStringProperty(source: string, property: string): string | null {
    const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`"${escapedProperty}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(
      source,
    );
    if (match?.[1] === undefined) {
      return null;
    }
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }

  function getScriptSources(): string[] {
    return Array.from(document.scripts).map((script) => script.textContent ?? "");
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
    let innertubeError: Error | null = null;
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
        innertubeError = normalizeError(error);
      }
    }

    let domError: Error | null = null;
    try {
      const transcript = await fetchTranscriptFromYouTubeDomPanel();
      if (transcript.length > 0) {
        return transcript;
      }
      domError = new Error("YouTube transcript panel did not expose transcript segments");
    } catch (error: unknown) {
      domError = normalizeError(error);
    }

    const errors = [
      trackError?.message,
      innertubeError !== null
        ? `innertube transcript fallback failed: ${innertubeError.message}`
        : null,
      domError !== null ? `DOM transcript fallback failed: ${domError.message}` : null,
    ].filter((message): message is string => message !== null && message !== undefined);
    throw new Error(errors.join("; ") || "No YouTube transcript source returned segments");
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
      const requestBodies = buildInnertubeRequestBodies(context, candidate, fallback.videoId);
      for (const requestBody of requestBodies) {
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              ...buildInnertubeHeaders(context),
            },
            body: JSON.stringify(requestBody.body),
          });
          const body = await response.text();
          if (!response.ok) {
            errors.push(`${requestBody.label} HTTP ${response.status}: ${body.slice(0, 180)}`);
            continue;
          }
          if (body.trim().length === 0) {
            errors.push(`${requestBody.label} empty response`);
            continue;
          }
          const transcript = parseInnertubeTranscript(JSON.parse(body));
          if (transcript.length > 0) {
            return transcript;
          }
          errors.push(`${requestBody.label} response did not contain transcript segments`);
        } catch (error: unknown) {
          errors.push(
            `${requestBody.label} ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    }
    throw new Error(`YouTube transcript panel fallback failed: ${errors.join("; ")}`);
  }

  function buildInnertubeRequestBodies(
    context: Record<string, unknown>,
    params: string,
    videoId?: string,
  ): Array<{ label: string; body: Record<string, unknown> }> {
    const baseBody = { context, params };
    if (videoId === undefined || videoId.length === 0) {
      return [{ label: "base", body: baseBody }];
    }
    return [
      { label: "base", body: baseBody },
      {
        label: "externalVideoId",
        body: {
          ...baseBody,
          externalVideoId: videoId,
        },
      },
    ];
  }

  function buildInnertubeHeaders(context: Record<string, unknown>): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Name": "1",
    };
    const client = context.client;
    if (isRecord(client) && typeof client.clientVersion === "string") {
      headers["X-Youtube-Client-Version"] = client.clientVersion;
    }
    if (isRecord(client) && typeof client.visitorData === "string") {
      headers["X-Goog-Visitor-Id"] = client.visitorData;
    }
    return headers;
  }

  async function fetchTranscriptFromYouTubeDomPanel(): Promise<TranscriptItem[]> {
    const existingTranscript = parseTranscriptFromDom();
    if (existingTranscript.length > 0) {
      return existingTranscript;
    }

    await openYouTubeTranscriptPanel();
    const startedAt = Date.now();
    while (Date.now() - startedAt < TRANSCRIPT_PANEL_WAIT_MS) {
      const transcript = parseTranscriptFromDom();
      if (transcript.length > 0) {
        return transcript;
      }
      await delay(TRANSCRIPT_PANEL_POLL_MS);
    }
    throw new Error("Timed out waiting for YouTube transcript panel segments");
  }

  async function openYouTubeTranscriptPanel(): Promise<void> {
    expandYouTubeDescription();
    await delay(300);

    const existingPanel = getTranscriptPanelElement();
    if (existingPanel !== null) {
      existingPanel.removeAttribute("hidden");
      existingPanel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    }

    const transcriptButton = findTranscriptButton();
    if (transcriptButton === null) {
      throw new Error(`Could not find YouTube transcript button (${describeTranscriptDomState()})`);
    }
    clickElement(transcriptButton);
  }

  function expandYouTubeDescription(): void {
    const directExpandSelectors = [
      "ytd-watch-metadata ytd-text-inline-expander #expand",
      "ytd-watch-metadata tp-yt-paper-button#expand",
      "ytd-watch-metadata button#expand",
      "#description-inline-expander #expand",
      "#description tp-yt-paper-button#expand",
      "#description button#expand",
    ];
    for (const selector of directExpandSelectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element !== null) {
        clickElement(element);
      }
    }

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          "ytd-watch-metadata tp-yt-paper-button#expand",
          "ytd-watch-metadata button[aria-label]",
          "#description tp-yt-paper-button#expand",
          "#description button[aria-label]",
          "button",
          "tp-yt-paper-button",
        ].join(","),
      ),
    );
    const expandButton = candidates.find((element) => {
      if (!isInteractableElement(element)) {
        return false;
      }
      const label = getElementSearchText(element);
      return /\b(more|show more|mehr|mehr anzeigen|weiterlesen)\b/i.test(label);
    });
    if (expandButton !== undefined) {
      clickElement(expandButton);
    }
  }

  function findTranscriptButton(): HTMLElement | null {
    const directSelectors = [
      "ytd-video-description-transcript-section-renderer yt-button-shape button",
      "ytd-video-description-transcript-section-renderer ytd-button-renderer button",
      "ytd-video-description-transcript-section-renderer button",
      "ytd-video-description-transcript-section-renderer [role='button']",
      "#structured-description ytd-video-description-transcript-section-renderer button",
      "#description ytd-video-description-transcript-section-renderer button",
    ];
    for (const selector of directSelectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element !== null) {
        return element;
      }
    }

    const transcriptPattern =
      /(show transcript|open transcript|transcript anzeigen|transkript anzeigen|transkript|transcript|transcription|transcripción|transcrição|transcriptie|trascrizione|transkription|文字起こし)/i;
    const blockedPattern =
      /(close|hide|schlie|ausblenden|fermer|cerrar|chiudi|sluiten|閉じる)/i;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          "button",
          "yt-button-shape button",
          "ytd-button-renderer",
          "tp-yt-paper-button",
          "a[role='button']",
          "[role='button']",
        ].join(","),
      ),
    );
    return (
      candidates.find((element) => {
        if (!isInteractableElement(element)) {
          return false;
        }
        const label = getElementSearchText(element);
        return transcriptPattern.test(label) && !blockedPattern.test(label);
      }) ?? null
    );
  }

  function getTranscriptPanelElement(): HTMLElement | null {
    const panel = document.querySelector(
      [
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
        'ytd-engagement-panel-section-list-renderer[targetid="engagement-panel-searchable-transcript"]',
        'ytd-engagement-panel-section-list-renderer[panel-identifier="engagement-panel-searchable-transcript"]',
      ].join(","),
    );
    return panel instanceof HTMLElement ? panel : null;
  }

  function parseTranscriptFromDom(): TranscriptItem[] {
    const segmentElements = Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          "ytd-transcript-segment-renderer",
          "yt-transcript-segment-renderer",
          "[class*='transcript-segment']",
        ].join(","),
      ),
    ).filter(isInteractableElement);

    const transcript = segmentElements
      .map(parseDomTranscriptSegment)
      .filter((item): item is TranscriptItem => item !== null);
    return normalizeTranscriptDurations(transcript);
  }

  function parseDomTranscriptSegment(element: HTMLElement): TranscriptItem | null {
    const timestampElement =
      element.querySelector<HTMLElement>(
        ".segment-timestamp, .segment-start-offset, [class*='timestamp'], [class*='start-offset']",
      ) ?? null;
    const timestampText = normalizeCaptionText(timestampElement?.textContent ?? "");
    const start = parseTimestampText(timestampText);
    if (!Number.isFinite(start) || start < 0) {
      return null;
    }

    const explicitTextElement =
      element.querySelector<HTMLElement>(
        ".segment-text, yt-formatted-string.segment-text, [class*='segment-text']",
      ) ?? null;
    const rawText = normalizeCaptionText(
      explicitTextElement?.textContent ?? element.textContent ?? "",
    );
    const text = normalizeCaptionText(
      rawText.startsWith(timestampText) ? rawText.slice(timestampText.length) : rawText,
    );
    if (text.length === 0) {
      return null;
    }
    return { start, duration: 0, text };
  }

  function clickElement(element: HTMLElement): void {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  }

  function isInteractableElement(element: HTMLElement): boolean {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function isVisibleElement(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function getElementSearchText(element: HTMLElement): string {
    return normalizeCaptionText(
      [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
      ].join(" "),
    );
  }

  function describeTranscriptDomState(): string {
    return [
      `section=${document.querySelectorAll("ytd-video-description-transcript-section-renderer").length}`,
      `buttons=${document.querySelectorAll("button,[role='button'],tp-yt-paper-button").length}`,
      `panel=${getTranscriptPanelElement() !== null}`,
      `segments=${document.querySelectorAll("ytd-transcript-segment-renderer,yt-transcript-segment-renderer").length}`,
    ].join(", ");
  }

  function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
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

  function transcriptFromCurrentPlayback(
    transcript: TranscriptItem[],
    currentTime: number,
  ): TranscriptItem[] {
    const minimumStart = Math.max(0, currentTime - TRANSCRIPT_LOOKBACK_SECONDS);
    const maximumStart = currentTime + STREAM_LOOKAHEAD_SECONDS;
    const windowItems = transcript.filter(
      (item) => item.start + item.duration >= minimumStart && item.start <= maximumStart,
    );
    const merged: TranscriptItem[] = [];
    let current: TranscriptItem | null = null;
    for (const item of windowItems) {
      const normalizedText = normalizeCaptionText(item.text);
      if (normalizedText.length === 0) {
        continue;
      }
      const candidate: TranscriptItem = {
        start: item.start,
        duration: item.duration,
        text: normalizedText,
      };
      if (current === null) {
        current = candidate;
        continue;
      }
      const currentEnd: number = current.start + current.duration;
      const candidateEnd: number = candidate.start + candidate.duration;
      const gap: number = candidate.start - currentEnd;
      const mergedDuration: number = Math.max(currentEnd, candidateEnd) - current.start;
      const mergedText = `${current.text} ${candidate.text}`.trim();
      if (
        gap <= 1.25 &&
        mergedDuration <= MERGED_TRANSCRIPT_TARGET_SECONDS &&
        mergedText.length <= MERGED_TRANSCRIPT_MAX_CHARS
      ) {
        current = {
          start: current.start,
          duration: mergedDuration,
          text: mergedText,
        };
        continue;
      }
      merged.push(current);
      if (merged.length >= MERGED_TRANSCRIPT_MAX_ITEMS) {
        return merged;
      }
      current = candidate;
    }
    if (current !== null && merged.length < MERGED_TRANSCRIPT_MAX_ITEMS) {
      merged.push(current);
    }
    return merged;
  }

  function transcriptWindowEnd(transcript: TranscriptItem[]): number {
    return transcript.reduce(
      (latestEnd, item) => Math.max(latestEnd, item.start + item.duration),
      0,
    );
  }

  function calculateAudioOffset(
    chunk: DecodedAudioChunk,
    playbackBuffer: AudioBuffer,
    currentTime: number,
  ): number {
    if (currentTime <= chunk.start || playbackBuffer.duration <= 0) {
      return 0;
    }
    const chunkDuration = Math.max(0.001, chunk.end - chunk.start);
    const elapsedRatio = Math.max(0, Math.min(0.95, (currentTime - chunk.start) / chunkDuration));
    return Math.min(
      playbackBuffer.duration * elapsedRatio,
      Math.max(0, playbackBuffer.duration - 0.02),
    );
  }

  function clampPlaybackRate(value: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.max(0.25, Math.min(4, value));
  }

  function supportsMediaElementPitchPreservation(): boolean {
    return (
      "preservesPitch" in HTMLMediaElement.prototype ||
      "webkitPreservesPitch" in HTMLMediaElement.prototype ||
      "mozPreservesPitch" in HTMLMediaElement.prototype
    );
  }

  function setMediaElementPreservesPitch(audio: HTMLAudioElement, value: boolean): void {
    const media = audio as HTMLAudioElement & {
      mozPreservesPitch?: boolean;
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    if ("preservesPitch" in media) {
      media.preservesPitch = value;
    }
    if ("webkitPreservesPitch" in media) {
      media.webkitPreservesPitch = value;
    }
    if ("mozPreservesPitch" in media) {
      media.mozPreservesPitch = value;
    }
  }

  function detectAudioMimeType(audioData: ArrayBuffer): string {
    const bytes = new Uint8Array(audioData.slice(0, 16));
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    ) {
      return "audio/wav";
    }
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      return "audio/mpeg";
    }
    if (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0) {
      return "audio/mpeg";
    }
    return "audio/mpeg";
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
      `Video muted: ${video instanceof HTMLVideoElement ? video.muted : "unknown"}`,
      `Video volume: ${video instanceof HTMLVideoElement ? video.volume : "unknown"}`,
      `User activation: ${describeUserActivation()}`,
      `Transcript fallback metadata: ${describeTranscriptFallbackMetadata()}`,
      `Player classes: ${player?.className.toString() ?? "unknown"}`,
      `Message: ${message}`,
    ].join("\n");
  }

  function describeUserActivation(): string {
    const activation = navigator.userActivation;
    if (activation === undefined) {
      return "unavailable";
    }
    return `active=${activation.isActive}, hasBeenActive=${activation.hasBeenActive}`;
  }

  function describeTranscriptFallbackMetadata(): string {
    return [
      `apiKey=${extractInnertubeApiKeyFromScripts() !== null}`,
      `context=${extractInnertubeContextFromScripts() !== null}`,
      `params=${extractTranscriptParamsFromScripts() !== null}`,
    ].join(", ");
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
    const configured = activeMessages[key];
    if (configured !== undefined && configured.trim().length > 0) {
      return configured;
    }
    if (typeof chrome !== "undefined" && chrome.i18n?.getMessage !== undefined) {
      const localized = chrome.i18n.getMessage(key);
      if (localized.trim().length > 0) {
        return localized;
      }
    }
    return FALLBACK_MESSAGES[key] ?? key;
  }

  async function configureContentLocale(uiLanguage: string): Promise<void> {
    const normalized = normalizeLocale(uiLanguage === "system" ? getBrowserLocale() : uiLanguage);
    if (normalized === activeUiLanguage && Object.keys(activeMessages).length > 0) {
      return;
    }
    activeUiLanguage = normalized;
    activeMessages = {
      ...(await loadLocaleMessages("en")),
      ...(normalized === "en" ? {} : await loadLocaleMessages(normalized)),
    };
  }

  async function loadLocaleMessages(locale: string): Promise<Record<string, string>> {
    if (typeof chrome === "undefined" || chrome.runtime?.getURL === undefined) {
      return {};
    }
    try {
      const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
      if (!response.ok) {
        return {};
      }
      const raw = (await response.json()) as Record<string, { message?: string }>;
      const messages: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value.message === "string") {
          messages[key] = value.message;
        }
      }
      return messages;
    } catch {
      return {};
    }
  }

  function getEffectiveUiLocale(): string {
    return activeUiLanguage === "system" ? normalizeLocale(getBrowserLocale()) : activeUiLanguage;
  }

  function getBrowserLocale(): string {
    if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage !== undefined) {
      return chrome.i18n.getUILanguage();
    }
    return navigator.languages[0] ?? navigator.language ?? "en";
  }

  function normalizeLocale(locale: string): string {
    const normalized = locale.trim().toLowerCase().replace("-", "_");
    if (normalized.startsWith("de")) return "de";
    if (normalized.startsWith("fr")) return "fr";
    if (normalized.startsWith("es")) return "es";
    if (normalized.startsWith("pt")) return "pt_BR";
    if (normalized.startsWith("zh")) return "zh_CN";
    if (normalized.startsWith("ja")) return "ja";
    if (normalized.startsWith("ko")) return "ko";
    if (normalized.startsWith("ar")) return "ar";
    if (normalized.startsWith("hi")) return "hi";
    if (normalized.startsWith("tr")) return "tr";
    if (normalized.startsWith("pl")) return "pl";
    if (normalized.startsWith("it")) return "it";
    return "en";
  }

  function isRtlLocale(locale: string): boolean {
    return locale.toLowerCase().startsWith("ar");
  }

  function formatErrorStatus(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return `Live Video Translation: ${error.message}`;
    }
    return "Live Video Translation could not start on this YouTube page.";
  }

  function formatStreamClosedStatus(message: Record<string, unknown>): string {
    const code = typeof message.code === "number" ? message.code : "unknown";
    const reason =
      typeof message.reason === "string" && message.reason.trim().length > 0
        ? message.reason.trim()
        : "No close reason provided";
    const hint =
      code === 1008 && /invalid auth token/i.test(reason)
        ? " Check that the extension backend access token matches AUTH_TOKENS in your backend."
        : "";
    return `${localizedMessage("connectionClosedError")} Code: ${code}. Reason: ${reason}.${hint}`;
  }

  function normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(typeof error === "string" ? error : "unknown error");
  }

  new YouTubeTranslationController().start();
})();
