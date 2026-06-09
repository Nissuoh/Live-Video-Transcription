export const DEFAULT_BACKEND_WSS_URL = "";
const LOCAL_BACKEND_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function hasDefaultBackendWssUrl(): boolean {
  return DEFAULT_BACKEND_WSS_URL.trim().length > 0;
}

export function resolveBackendWssUrl(storedBackendWssUrl: string | undefined): string {
  const stored = typeof storedBackendWssUrl === "string" ? storedBackendWssUrl.trim() : "";
  return stored.length > 0 ? stored : DEFAULT_BACKEND_WSS_URL.trim();
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
