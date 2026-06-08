(() => {
  interface ExtensionConfig {
    authToken?: string;
    backendWssUrl?: string;
    autoTranslate?: boolean;
    sourceLanguage?: string;
    targetLanguage?: string;
  }

  const CONFIG_KEYS = [
    "authToken",
    "backendWssUrl",
    "autoTranslate",
    "sourceLanguage",
    "targetLanguage",
  ] as const;

  const LANGUAGE_CODES: readonly string[] = [
    "ar",
    "da",
    "de",
    "en",
    "es",
    "fi",
    "fr",
    "hi",
    "it",
    "ja",
    "ko",
    "nl",
    "no",
    "pl",
    "pt",
    "ru",
    "sv",
    "tr",
    "uk",
    "zh",
  ];

  const FALLBACK_MESSAGES: Record<string, string> = {
    aiDisclosure:
      "Translated speech is AI-generated and sent through your configured backend.",
    appName: "Live Video Translation",
    authTokenLabel: "API/Auth token",
    autoTranslateLabel: "Enable automatic translation on YouTube",
    automationSection: "Automation",
    backendStreamPathError: "Backend URL must point to /stream.",
    backendUrlLabel: "Backend WebSocket URL",
    backendUrlPlaceholder: "wss://example.com/stream",
    backendWssError: "Backend URL must start with wss://.",
    connectionSection: "Connection",
    hideTokenButton: "Hide token",
    languageSection: "Language",
    missingElementError: "Missing required element: $1",
    optionsSubtitle: "Secure backend configuration for synchronized YouTube audio translation.",
    popupSubtitle: "The current YouTube video is detected automatically when translation is enabled.",
    productEyebrow: "YouTube audio translator",
    saveButton: "Save",
    savedStatus: "Saved.",
    settingsInvalidError: "Settings are invalid.",
    showTokenButton: "Show token",
    sourceLanguageLabel: "From",
    storageUnavailableError: "Chrome extension storage is unavailable in this context.",
    targetLanguageLabel: "To",
    tokenRequiredError: "Auth token is required when automatic translation is enabled.",
  };

  const form = requireElement("#options-form", HTMLFormElement);
  const backendInput = requireElement("#backend-wss-url", HTMLInputElement);
  const tokenInput = requireElement("#auth-token", HTMLInputElement);
  const sourceLanguageInput = requireElement("#source-language", HTMLSelectElement);
  const targetLanguageInput = requireElement("#target-language", HTMLSelectElement);
  const autoTranslateInput = requireElement("#auto-translate", HTMLInputElement);
  const revealButton = requireElement("#reveal-token", HTMLButtonElement);
  const status = requireElement("#status", HTMLParagraphElement);

  applyLocalization();
  populateLanguageSelect(sourceLanguageInput, "en");
  populateLanguageSelect(targetLanguageInput, "de");
  void loadOptions();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveOptions();
  });

  revealButton.addEventListener("click", () => {
    tokenInput.type = tokenInput.type === "password" ? "text" : "password";
    revealButton.textContent =
      tokenInput.type === "password" ? message("showTokenButton") : message("hideTokenButton");
  });

  async function loadOptions(): Promise<void> {
    const storage = getStorage();
    if (storage === null) {
      setStatus(message("storageUnavailableError"), "error");
      return;
    }
    const config = (await storage.get([...CONFIG_KEYS])) as ExtensionConfig;
    const sourceLanguage =
      typeof config.sourceLanguage === "string" ? config.sourceLanguage : "en";
    const targetLanguage =
      typeof config.targetLanguage === "string" ? config.targetLanguage : "de";
    backendInput.value = typeof config.backendWssUrl === "string" ? config.backendWssUrl : "";
    tokenInput.value = typeof config.authToken === "string" ? config.authToken : "";
    autoTranslateInput.checked = config.autoTranslate === true;
    populateLanguageSelect(sourceLanguageInput, sourceLanguage);
    populateLanguageSelect(targetLanguageInput, targetLanguage);
  }

  async function saveOptions(): Promise<void> {
    const storage = getStorage();
    if (storage === null) {
      setStatus(message("storageUnavailableError"), "error");
      return;
    }
    const backendWssUrl = backendInput.value.trim();
    const authToken = tokenInput.value.trim();
    const autoTranslate = autoTranslateInput.checked;
    const sourceLanguage = sourceLanguageInput.value;
    const targetLanguage = targetLanguageInput.value;
    try {
      if (backendWssUrl.length > 0 || autoTranslate) {
        assertWssUrl(backendWssUrl);
      }
      if (autoTranslate && authToken.length === 0) {
        throw new Error(message("tokenRequiredError"));
      }
      await storage.set({
        backendWssUrl,
        authToken,
        autoTranslate,
        sourceLanguage,
        targetLanguage,
      });
      await notifyActiveYouTubeTab();
      setStatus(message("savedStatus"), "ok");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : message("settingsInvalidError"), "error");
    }
  }

  function applyLocalization(): void {
    const locale = getUiLocale();
    document.documentElement.lang = locale;
    document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
      const key = element.dataset.i18n;
      if (key !== undefined) {
        element.textContent = message(key);
      }
    });
    document
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]")
      .forEach((element) => {
        const key = element.dataset.i18nPlaceholder;
        if (key !== undefined) {
          element.placeholder = message(key);
        }
      });
  }

  function populateLanguageSelect(select: HTMLSelectElement, selectedLanguage: string): void {
    const locale = getUiLocale();
    const uniqueCodes = Array.from(new Set([...LANGUAGE_CODES, selectedLanguage]));
    const options = uniqueCodes
      .filter((code) => code.trim().length > 0)
      .map((code) => ({
        code,
        label: formatLanguageLabel(code),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, locale));
    const fragment = document.createDocumentFragment();
    for (const optionData of options) {
      const option = document.createElement("option");
      option.value = optionData.code;
      option.textContent = optionData.label;
      fragment.append(option);
    }
    select.replaceChildren(fragment);
    select.value = selectedLanguage;
  }

  function formatLanguageLabel(languageCode: string): string {
    const locale = getUiLocale();
    try {
      const displayNames = new Intl.DisplayNames([locale], { type: "language" });
      const localizedName = displayNames.of(languageCode);
      if (localizedName !== undefined && localizedName.trim().length > 0) {
        return `${localizedName} (${languageCode.toUpperCase()})`;
      }
    } catch {
      // Intl.DisplayNames can be unavailable in non-Chrome preview contexts.
    }
    return languageCode.toUpperCase();
  }

  function assertWssUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(message("backendWssError"));
    }
    if (url.protocol !== "wss:") {
      throw new Error(message("backendWssError"));
    }
    if (!url.pathname.endsWith("/stream")) {
      throw new Error(message("backendStreamPathError"));
    }
  }

  function setStatus(statusMessage: string, kind: "ok" | "error"): void {
    status.textContent = statusMessage;
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

  async function notifyActiveYouTubeTab(): Promise<void> {
    if (chrome.tabs?.query === undefined || chrome.tabs.sendMessage === undefined) {
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    await Promise.allSettled(
      tabs
        .filter((tab) => typeof tab.id === "number")
        .map((tab) => chrome.tabs.sendMessage(tab.id as number, { type: "lvtSettingsUpdated" })),
    );
  }

  function getUiLocale(): string {
    if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage !== undefined) {
      return chrome.i18n.getUILanguage();
    }
    return navigator.languages[0] ?? navigator.language ?? "en";
  }

  function message(key: string, substitutions?: string | string[]): string {
    if (typeof chrome !== "undefined" && chrome.i18n?.getMessage !== undefined) {
      const localized = chrome.i18n.getMessage(key, substitutions);
      if (localized.trim().length > 0) {
        return localized;
      }
    }
    const fallback = FALLBACK_MESSAGES[key] ?? key;
    if (substitutions === undefined) {
      return fallback;
    }
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return values.reduce(
      (current, value, index) => current.replace(`$${index + 1}`, value),
      fallback,
    );
  }

  function requireElement<T extends Element>(
    selector: string,
    constructor: { new (...args: never[]): T },
  ): T {
    const element = document.querySelector(selector);
    if (!(element instanceof constructor)) {
      throw new Error(message("missingElementError", selector));
    }
    return element;
  }
})();
