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
