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
    uiLanguage?: UiLanguage;
    voiceGender?: VoiceGender;
    voicePitch?: VoicePitch;
    preserveVoicePitch?: boolean;
  }

  type UiLanguage = "system" | "en" | "de" | "fr";
  type VoiceGender = "male" | "female";
  type VoicePitch = "normal" | "high" | "low";

  const CONFIG_KEYS = [
    "authToken",
    "backendWssUrl",
    "autoTranslate",
    "sourceLanguage",
    "targetLanguage",
    "uiLanguage",
    "voiceGender",
    "voicePitch",
    "preserveVoicePitch",
  ] as const;

  const SUPPORTED_UI_LANGUAGES: readonly UiLanguage[] = ["system", "en", "de", "fr"];
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
    interfaceSection: "Interface",
    uiLanguageLabel: "Interface language",
    uiLanguageSystem: "Use browser language",
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
    preserveVoicePitchLabel: "Keep voice pitch when YouTube speed changes",
    voicePitchHigh: "High",
    voicePitchLabel: "Pitch",
    voicePitchLow: "Low",
    voicePitchNormal: "Normal",
    voiceSection: "Voice",
  };

  let activeUiLanguage: UiLanguage = "system";
  let activeMessages: Record<string, string> = {};

  const form = requireElement("#options-form", HTMLFormElement);
  const backendField = requireElement("#backend-field", HTMLDivElement);
  const backendInput = requireElement("#backend-wss-url", HTMLInputElement);
  const tokenInput = requireElement("#auth-token", HTMLInputElement);
  const uiLanguageInput = requireElement("#ui-language", HTMLSelectElement);
  const sourceLanguageInput = requireElement("#source-language", HTMLSelectElement);
  const targetLanguageInput = requireElement("#target-language", HTMLSelectElement);
  const voiceGenderInput = requireElement("#voice-gender", HTMLSelectElement);
  const voicePitchInput = requireElement("#voice-pitch", HTMLSelectElement);
  const preserveVoicePitchInput = requireElement("#preserve-voice-pitch", HTMLInputElement);
  const autoTranslateInput = requireElement("#auto-translate", HTMLInputElement);
  const revealButton = requireElement("#reveal-token", HTMLButtonElement);
  const status = requireElement("#status", HTMLParagraphElement);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveOptions();
  });

  uiLanguageInput.addEventListener("change", () => {
    void applySelectedUiLanguage();
  });

  revealButton.addEventListener("click", () => {
    tokenInput.type = tokenInput.type === "password" ? "text" : "password";
    revealButton.textContent =
      tokenInput.type === "password" ? message("showTokenButton") : message("hideTokenButton");
  });

  void initialize();

  async function initialize(): Promise<void> {
    const storage = getStorage();
    if (storage === null) {
      setStatus(message("storageUnavailableError"), "error");
      return;
    }
    const config = (await storage.get([...CONFIG_KEYS])) as ExtensionConfig;
    activeUiLanguage = parseUiLanguage(config.uiLanguage);
    activeMessages = await loadMessagesForUiLanguage(activeUiLanguage);
    applyLocalization();
    applyBackendDefaults();
    populateUiLanguageSelect(activeUiLanguage);
    loadOptions(config);
  }

  function loadOptions(config: ExtensionConfig): void {
    const sourceLanguage =
      typeof config.sourceLanguage === "string" ? config.sourceLanguage : "en";
    const targetLanguage =
      typeof config.targetLanguage === "string" ? config.targetLanguage : "de";
    const voiceGender = parseVoiceGender(config.voiceGender);
    const voicePitch = parseVoicePitch(config.voicePitch);
    backendInput.value = resolveBackendWssUrl(config.backendWssUrl);
    tokenInput.value = resolveBackendAccessToken(config.authToken);
    autoTranslateInput.checked = config.autoTranslate === true;
    preserveVoicePitchInput.checked = config.preserveVoicePitch !== false;
    uiLanguageInput.value = activeUiLanguage;
    populateLanguageSelect(sourceLanguageInput, sourceLanguage);
    populateLanguageSelect(targetLanguageInput, targetLanguage);
    voiceGenderInput.value = voiceGender;
    voicePitchInput.value = voicePitch;
    void setConfigStatus(message("configurationLoadedStatus"), "ok");
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
    const uiLanguage = parseUiLanguage(uiLanguageInput.value);
    const voiceGender = parseVoiceGender(voiceGenderInput.value);
    const voicePitch = parseVoicePitch(voicePitchInput.value);
    const preserveVoicePitch = preserveVoicePitchInput.checked;
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
        uiLanguage,
        voiceGender,
        voicePitch,
        preserveVoicePitch,
      });
      activeUiLanguage = uiLanguage;
      activeMessages = await loadMessagesForUiLanguage(activeUiLanguage);
      applyLocalization();
      populateUiLanguageSelect(activeUiLanguage);
      populateLanguageSelect(sourceLanguageInput, sourceLanguage);
      populateLanguageSelect(targetLanguageInput, targetLanguage);
      await notifyActiveYouTubeTab();
      await setConfigStatus(message("savedStatus"), "ok");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : message("settingsInvalidError"), "error");
    }
  }

  function applyLocalization(): void {
    const locale = getEffectiveUiLocale();
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
    revealButton.textContent =
      tokenInput.type === "password" ? message("showTokenButton") : message("hideTokenButton");
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
    const locale = getEffectiveUiLocale();
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
    const locale = getEffectiveUiLocale();
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

  function populateUiLanguageSelect(selectedLanguage: UiLanguage): void {
    const fragment = document.createDocumentFragment();
    for (const language of SUPPORTED_UI_LANGUAGES) {
      const option = document.createElement("option");
      option.value = language;
      option.textContent =
        language === "system" ? message("uiLanguageSystem") : formatLanguageLabel(language);
      fragment.append(option);
    }
    uiLanguageInput.replaceChildren(fragment);
    uiLanguageInput.value = selectedLanguage;
  }

  async function applySelectedUiLanguage(): Promise<void> {
    const selectedLanguage = parseUiLanguage(uiLanguageInput.value);
    const sourceLanguage = sourceLanguageInput.value || "en";
    const targetLanguage = targetLanguageInput.value || "de";
    activeUiLanguage = selectedLanguage;
    activeMessages = await loadMessagesForUiLanguage(activeUiLanguage);
    applyLocalization();
    populateUiLanguageSelect(activeUiLanguage);
    populateLanguageSelect(sourceLanguageInput, sourceLanguage);
    populateLanguageSelect(targetLanguageInput, targetLanguage);
  }

  function parseUiLanguage(value: unknown): UiLanguage {
    return value === "de" || value === "fr" || value === "en" ? value : "system";
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

  function getEffectiveUiLocale(): string {
    if (activeUiLanguage !== "system") {
      return activeUiLanguage;
    }
    return getUiLocale();
  }

  async function loadMessagesForUiLanguage(uiLanguage: UiLanguage): Promise<Record<string, string>> {
    const browserLocale = normalizeLocale(getUiLocale());
    const requestedLocale = uiLanguage === "system" ? browserLocale : uiLanguage;
    return {
      ...(await loadLocaleMessages("en")),
      ...(requestedLocale === "en" ? {} : await loadLocaleMessages(requestedLocale)),
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

  function normalizeLocale(locale: string): string {
    const normalized = locale.trim().toLowerCase();
    if (normalized.startsWith("de")) {
      return "de";
    }
    if (normalized.startsWith("fr")) {
      return "fr";
    }
    return "en";
  }

  function message(key: string, substitutions?: string | string[]): string {
    const configured = activeMessages[key];
    if (configured !== undefined && configured.trim().length > 0) {
      return interpolateMessage(configured, substitutions);
    }
    if (typeof chrome !== "undefined" && chrome.i18n?.getMessage !== undefined) {
      const localized = chrome.i18n.getMessage(key, substitutions);
      if (localized.trim().length > 0) {
        return localized;
      }
    }
    const fallback = FALLBACK_MESSAGES[key] ?? key;
    return interpolateMessage(fallback, substitutions);
  }

  function interpolateMessage(messageTemplate: string, substitutions?: string | string[]): string {
    if (substitutions === undefined) {
      return messageTemplate;
    }
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return values.reduce(
      (current, value, index) =>
        current
          .replaceAll(`$${index + 1}`, value)
          .replaceAll(`$${index + 1}$`, value)
          .replaceAll(index === 0 ? "$SELECTOR$" : `$ARG${index + 1}$`, value),
      messageTemplate,
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
