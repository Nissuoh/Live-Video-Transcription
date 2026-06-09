export const DEFAULT_BACKEND_WSS_URL = "";
export const DEFAULT_BACKEND_ACCESS_TOKEN = "";
const LOCAL_BACKEND_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function hasDefaultBackendWssUrl(): boolean {
  return DEFAULT_BACKEND_WSS_URL.trim().length > 0;
}

export function hasDefaultBackendAccessToken(): boolean {
  return DEFAULT_BACKEND_ACCESS_TOKEN.trim().length > 0;
}

export function resolveBackendWssUrl(storedBackendWssUrl: string | undefined): string {
  const configuredDefault = DEFAULT_BACKEND_WSS_URL.trim();
  if (configuredDefault.length > 0) {
    return configuredDefault;
  }
  const stored = typeof storedBackendWssUrl === "string" ? storedBackendWssUrl.trim() : "";
  return stored;
}

export function resolveBackendAccessToken(storedBackendAccessToken: string | undefined): string {
  const configuredDefault = DEFAULT_BACKEND_ACCESS_TOKEN.trim();
  if (configuredDefault.length > 0) {
    return configuredDefault;
  }
  return typeof storedBackendAccessToken === "string" ? storedBackendAccessToken.trim() : "";
}

export function isAllowedBackendStreamUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!url.pathname.endsWith("/stream")) {
      return false;
    }
    if (url.protocol === "wss:") {
      return true;
    }
    return url.protocol === "ws:" && LOCAL_BACKEND_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
