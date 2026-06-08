(() => {
  interface ExtensionConfig {
    authToken?: string;
    backendWssUrl?: string;
  }

  const CONFIG_KEYS = ["authToken", "backendWssUrl"] as const;

  const form = requireElement("#options-form", HTMLFormElement);
  const backendInput = requireElement("#backend-wss-url", HTMLInputElement);
  const tokenInput = requireElement("#auth-token", HTMLInputElement);
  const revealButton = requireElement("#reveal-token", HTMLButtonElement);
  const status = requireElement("#status", HTMLParagraphElement);

  void loadOptions();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveOptions();
  });

  revealButton.addEventListener("click", () => {
    tokenInput.type = tokenInput.type === "password" ? "text" : "password";
    revealButton.textContent = tokenInput.type === "password" ? "Show token" : "Hide token";
  });

  async function loadOptions(): Promise<void> {
    const storage = getStorage();
    if (storage === null) {
      setStatus("Chrome extension storage is unavailable in this context.", "error");
      return;
    }
    const config = (await storage.get([...CONFIG_KEYS])) as ExtensionConfig;
    backendInput.value = typeof config.backendWssUrl === "string" ? config.backendWssUrl : "";
    tokenInput.value = typeof config.authToken === "string" ? config.authToken : "";
  }

  async function saveOptions(): Promise<void> {
    const storage = getStorage();
    if (storage === null) {
      setStatus("Chrome extension storage is unavailable in this context.", "error");
      return;
    }
    const backendWssUrl = backendInput.value.trim();
    const authToken = tokenInput.value.trim();
    try {
      assertWssUrl(backendWssUrl);
      if (authToken.length === 0) {
        throw new Error("Auth token is required.");
      }
      await storage.set({ backendWssUrl, authToken });
      setStatus("Saved.", "ok");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : "Settings are invalid.", "error");
    }
  }

  function assertWssUrl(value: string): void {
    const url = new URL(value);
    if (url.protocol !== "wss:") {
      throw new Error("Backend URL must start with wss://.");
    }
    if (!url.pathname.endsWith("/stream")) {
      throw new Error("Backend URL must point to /stream.");
    }
  }

  function setStatus(message: string, kind: "ok" | "error"): void {
    status.textContent = message;
    if (kind === "error") {
      status.dataset.kind = "error";
    } else {
      delete status.dataset.kind;
    }
  }

  function getStorage(): chrome.storage.StorageArea | null {
    if (typeof chrome === "undefined" || chrome.storage?.local === undefined) {
      return null;
    }
    return chrome.storage.local;
  }

  function requireElement<T extends Element>(
    selector: string,
    constructor: { new (...args: never[]): T },
  ): T {
    const element = document.querySelector(selector);
    if (!(element instanceof constructor)) {
      throw new Error(`Missing required element: ${selector}`);
    }
    return element;
  }
})();
