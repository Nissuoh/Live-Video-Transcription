(() => {
  interface CaptionTrack {
    baseUrl?: string;
    languageCode?: string;
    name?: unknown;
    kind?: string;
    vssId?: string;
  }

  interface PlayerResponseLike {
    videoDetails?: {
      videoId?: string;
    };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: CaptionTrack[];
      };
    };
    transcriptFallback?: TranscriptFallback;
  }

  interface TranscriptFallback {
    innertubeApiKey?: string;
    innertubeContext?: Record<string, unknown>;
    params?: string;
    videoId?: string;
  }

  interface ProbeRequest {
    source: "lvt-content";
    type: "readPlayerResponse";
    requestId: string;
  }

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || !isProbeRequest(event.data)) {
      return;
    }
    const playerResponse = sanitizePlayerResponse(readCurrentPlayerResponse());
    window.postMessage(
      {
        source: "lvt-page-probe",
        type: "playerResponse",
        requestId: event.data.requestId,
        playerResponse,
      },
      window.location.origin,
    );
  });

  function readCurrentPlayerResponse(): PlayerResponseLike | null {
    const moviePlayer = document.getElementById("movie_player") as
      | (HTMLElement & { getPlayerResponse?: () => unknown })
      | null;
    if (typeof moviePlayer?.getPlayerResponse === "function") {
      const response = moviePlayer.getPlayerResponse();
      if (isPlayerResponseLike(response)) {
        return response;
      }
    }

    const globalResponse = readGlobalPlayerResponse();
    if (globalResponse !== null) {
      return globalResponse;
    }

    return null;
  }

  function readGlobalPlayerResponse(): PlayerResponseLike | null {
    const pageWindow = window as Window & { ytInitialPlayerResponse?: unknown };
    if (isPlayerResponseLike(pageWindow.ytInitialPlayerResponse)) {
      return pageWindow.ytInitialPlayerResponse;
    }
    return null;
  }

  function sanitizePlayerResponse(value: PlayerResponseLike | null): PlayerResponseLike | null {
    if (value === null) {
      return null;
    }
    const captionTracks =
      value.captions?.playerCaptionsTracklistRenderer?.captionTracks
        ?.filter((track): track is Required<Pick<CaptionTrack, "baseUrl">> & CaptionTrack => {
          return typeof track.baseUrl === "string" && track.baseUrl.length > 0;
        })
        .map((track) => compactTrack(track)) ?? [];

    const sanitized: PlayerResponseLike = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks,
        },
      },
    };
    if (typeof value.videoDetails?.videoId === "string") {
      sanitized.videoDetails = { videoId: value.videoDetails.videoId };
    }
    const transcriptFallback = readTranscriptFallback(value);
    if (transcriptFallback !== null) {
      sanitized.transcriptFallback = transcriptFallback;
    }
    return sanitized;
  }

  function compactTrack(track: Required<Pick<CaptionTrack, "baseUrl">> & CaptionTrack): CaptionTrack {
    const compacted: CaptionTrack = { baseUrl: track.baseUrl };
    if (typeof track.languageCode === "string") {
      compacted.languageCode = track.languageCode;
    }
    if (track.name !== undefined) {
      compacted.name = track.name;
    }
    if (typeof track.kind === "string") {
      compacted.kind = track.kind;
    }
    if (typeof track.vssId === "string") {
      compacted.vssId = track.vssId;
    }
    return compacted;
  }

  function readTranscriptFallback(value: PlayerResponseLike): TranscriptFallback | null {
    const config = readYtcfgData();
    const apiKey = config.INNERTUBE_API_KEY;
    const context = config.INNERTUBE_CONTEXT;
    const params =
      extractTranscriptParams(readGlobalInitialData()) ?? extractTranscriptParamsFromScripts();
    if (typeof apiKey !== "string" || !isRecord(context) || typeof params !== "string") {
      return null;
    }
    const fallback: TranscriptFallback = {
      innertubeApiKey: apiKey,
      innertubeContext: context,
      params,
    };
    const videoId = value.videoDetails?.videoId ?? readPageVideoId();
    if (videoId !== null && videoId.length > 0) {
      fallback.videoId = videoId;
    }
    return fallback;
  }

  function readYtcfgData(): Record<string, unknown> {
    const pageWindow = window as Window & {
      ytcfg?: {
        data_?: () => unknown;
        get?: (key: string) => unknown;
      };
    };
    const data = pageWindow.ytcfg?.data_?.();
    if (isRecord(data)) {
      return data;
    }
    const apiKey = pageWindow.ytcfg?.get?.("INNERTUBE_API_KEY");
    const context = pageWindow.ytcfg?.get?.("INNERTUBE_CONTEXT");
    return {
      INNERTUBE_API_KEY: apiKey,
      INNERTUBE_CONTEXT: context,
    };
  }

  function readGlobalInitialData(): unknown {
    const pageWindow = window as Window & { ytInitialData?: unknown };
    return pageWindow.ytInitialData;
  }

  function extractTranscriptParams(value: unknown): string | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const params = extractTranscriptParams(item);
        if (params !== null) {
          return params;
        }
      }
      return null;
    }
    if (!isRecord(value)) {
      return null;
    }
    const endpoint = value.getTranscriptEndpoint;
    if (isRecord(endpoint) && typeof endpoint.params === "string") {
      return endpoint.params;
    }
    for (const child of Object.values(value)) {
      const params = extractTranscriptParams(child);
      if (params !== null) {
        return params;
      }
    }
    return null;
  }

  function extractTranscriptParamsFromScripts(): string | null {
    for (const script of Array.from(document.scripts)) {
      const source = script.textContent ?? "";
      if (!source.includes("getTranscriptEndpoint")) {
        continue;
      }
      const match = /"getTranscriptEndpoint":\{"params":"([^"]+)"\}/.exec(source);
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

  function readPageVideoId(): string | null {
    const url = new URL(window.location.href);
    const watchVideoId = url.searchParams.get("v");
    if (watchVideoId !== null && watchVideoId.length > 0) {
      return watchVideoId;
    }
    const shortsMatch = /^\/shorts\/([^/?#]+)/.exec(url.pathname);
    return shortsMatch?.[1] ?? null;
  }

  function isProbeRequest(value: unknown): value is ProbeRequest {
    return (
      isRecord(value) &&
      value.source === "lvt-content" &&
      value.type === "readPlayerResponse" &&
      typeof value.requestId === "string"
    );
  }

  function isPlayerResponseLike(value: unknown): value is PlayerResponseLike {
    return isRecord(value);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
})();
