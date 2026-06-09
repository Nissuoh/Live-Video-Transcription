import {
  DEFAULT_BACKEND_ACCESS_TOKEN,
  DEFAULT_BACKEND_WSS_URL,
  hasDefaultBackendAccessToken,
  hasDefaultBackendWssUrl,
  isAllowedBackendStreamUrl,
  resolveBackendAccessToken,
  resolveBackendWssUrl,
} from "./defaults.js";

(() => {
  interface ExtensionConfig {
    authToken?: string;
    backendWssUrl?: string;
    autoTranslate?: boolean;
    sourceLanguage?: string;
    targetLanguage?: string;
    voiceGender?: VoiceGender;
    voicePitch?: VoicePitch;
  }

  type VoiceGender = "male" | "female";
  type VoicePitch = "normal" | "high" | "low";

  const CONFIG_KEYS = [
    "authToken",
    "backendWssUrl",
    "autoTranslate",
    "sourceLanguage",
    "targetLanguage",
    "voiceGender",
    "voicePitch",
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
    authTokenLabel: "Backend access token",
    authTokenPlaceholder: "Token issued by your backend",
    autoTranslateLabel: "Enable automatic translation on YouTube",
    automationSection: "Automation",
    backendStreamPathError: "Backend URL must point to /stream.",
    backendUrlLabel: "Backend WebSocket URL",
    backendUrlPlaceholder: "wss://example.com/stream",
    backendWssError: "Backend URL must use wss:// or local ws://localhost.",
    connectionSection: "Connection",
    configurationLoadedStatus: "Configuration loaded.",
    configurationSummary: "Backend: $1. Token: $2 chars, SHA-256: $3.",
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
    tokenRequiredError: "Backend access token is required when automatic translation is enabled.",
    voiceGenderFemale: "Female",
    voiceGenderLabel: "Voice gender",
    voiceGenderMale: "Male",
    voicePitchHigh: "High",
    voicePitchLabel: "Pitch",
    voicePitchLow: "Low",
    voicePitchNormal: "Normal",
    voiceSection: "Voice",
  };

  const form = requireElement("#options-form", HTMLFormElement);
  const backendField = requireElement("#backend-field", HTMLDivElement);
  const backendInput = requireElement("#backend-wss-url", HTMLInputElement);
  const tokenInput = requireElement("#auth-token", HTMLInputElement);
  const sourceLanguageInput = requireElement("#source-language", HTMLSelectElement);
  const targetLanguageInput = requireElement("#target-language", HTMLSelectElement);
  const voiceGenderInput = requireElement("#voice-gender", HTMLSelectElement);
  const voicePitchInput = requireElement("#voice-pitch", HTMLSelectElement);
  const autoTranslateInput = requireElement("#auto-translate", HTMLInputElement);
  const revealButton = requireElement("#reveal-token", HTMLButtonElement);
  const status = requireElement("#status", HTMLParagraphElement);

  applyLocalization();
  applyBackendDefaults();
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
    const voiceGender = parseVoiceGender(config.voiceGender);
    const voicePitch = parseVoicePitch(config.voicePitch);
    backendInput.value = resolveBackendWssUrl(config.backendWssUrl);
    tokenInput.value = resolveBackendAccessToken(config.authToken);
    autoTranslateInput.checked = config.autoTranslate === true;
    populateLanguageSelect(sourceLanguageInput, sourceLanguage);
    populateLanguageSelect(targetLanguageInput, targetLanguage);
    voiceGenderInput.value = voiceGender;
    voicePitchInput.value = voicePitch;
    await setConfigStatus(message("configurationLoadedStatus"), "ok");
  }

  async function saveOptions(): Promise<void> {
    const storage = getStorage();
    if (storage === null) {
      setStatus(message("storageUnavailableError"), "error");
      return;
    }
    const backendWssUrl = resolveBackendWssUrl(backendInput.value);
    const authToken = resolveBackendAccessToken(tokenInput.value);
    const autoTranslate = autoTranslateInput.checked;
    const sourceLanguage = sourceLanguageInput.value;
    const targetLanguage = targetLanguageInput.value;
    const voiceGender = parseVoiceGender(voiceGenderInput.value);
    const voicePitch = parseVoicePitch(voicePitchInput.value);
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
        voiceGender,
        voicePitch,
      });
      await notifyActiveYouTubeTab();
      await setConfigStatus(message("savedStatus"), "ok");
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

  function applyBackendDefaults(): void {
    if (!hasDefaultBackendWssUrl()) {
      if (!hasDefaultBackendAccessToken()) {
        return;
      }
    }
    if (hasDefaultBackendWssUrl()) {
      backendInput.value = DEFAULT_BACKEND_WSS_URL;
      backendField.hidden = true;
    }
    if (hasDefaultBackendAccessToken()) {
      tokenInput.value = DEFAULT_BACKEND_ACCESS_TOKEN;
      tokenInput.readOnly = true;
    }
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

  function parseVoiceGender(value: unknown): VoiceGender {
    return value === "female" ? "female" : "male";
  }

  function parseVoicePitch(value: unknown): VoicePitch {
    if (value === "high" || value === "low") {
      return value;
    }
    return "normal";
  }

  function assertWssUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(message("backendWssError"));
    }
    if (!isAllowedBackendStreamUrl(value)) {
      if (url.pathname.endsWith("/stream")) {
        throw new Error(message("backendWssError"));
      }
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

  async function setConfigStatus(prefix: string, kind: "ok" | "error"): Promise<void> {
    if (kind === "error") {
      setStatus(prefix, kind);
      return;
    }
    const backendWssUrl = resolveBackendWssUrl(backendInput.value);
    const authToken = resolveBackendAccessToken(tokenInput.value);
    const fingerprint = await fingerprintToken(authToken);
    setStatus(
      `${prefix} ${message("configurationSummary", [
        backendWssUrl || "-",
        String(authToken.length),
        fingerprint,
      ])}`,
      kind,
    );
  }

  async function fingerprintToken(value: string): Promise<string> {
    if (value.length === 0) {
      return "empty";
    }
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.subtle === undefined) {
      return "unavailable";
    }
    const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
      .slice(0, 6)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
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
