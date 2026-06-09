export const DEFAULT_BACKEND_WSS_URL = "";

export function hasDefaultBackendWssUrl(): boolean {
  return DEFAULT_BACKEND_WSS_URL.trim().length > 0;
}

export function resolveBackendWssUrl(storedBackendWssUrl: string | undefined): string {
  const stored = typeof storedBackendWssUrl === "string" ? storedBackendWssUrl.trim() : "";
  return stored.length > 0 ? stored : DEFAULT_BACKEND_WSS_URL.trim();
}
