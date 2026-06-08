(() => {
  const CONFIG_KEYS = ["authToken", "backendWssUrl"] as const;

  type ConfigKey = (typeof CONFIG_KEYS)[number];
  type ExtensionConfig = Partial<Record<ConfigKey, string>>;

  chrome.runtime.onInstalled.addListener(async () => {
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

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    void handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : "Unknown error";
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  });

  async function handleMessage(message: unknown): Promise<unknown> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return { ok: false, error: "Invalid message" };
    }
    if (message.type === "getConfig") {
      const config = (await chrome.storage.local.get([...CONFIG_KEYS])) as ExtensionConfig;
      return { ok: true, config };
    }
    if (message.type === "setConfig") {
      if (!isRecord(message.config)) {
        return { ok: false, error: "Invalid config" };
      }
      const nextConfig: ExtensionConfig = {};
      for (const key of CONFIG_KEYS) {
        const value = message.config[key];
        if (typeof value === "string") {
          nextConfig[key] = value;
        }
      }
      await chrome.storage.local.set(nextConfig);
      return { ok: true };
    }
    return { ok: false, error: "Unsupported message type" };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
})();
