import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { DEFAULT_SETTINGS, setSettings, updateSettings } from "@/lib/storage";

// The module keeps its loaded messages in module state: import it fresh per
// test so one test's initI18n can't leak into the next.
async function freshRuntime() {
  vi.resetModules();
  return import("@/lib/i18n-runtime");
}

function messagesResponse(messages: Record<string, string>) {
  const body = Object.fromEntries(
    Object.entries(messages).map(([key, message]) => [key, { message }]),
  );
  return new Response(JSON.stringify(body), { status: 200 });
}

/** fetch stub keyed by the locale in the `_locales/<locale>/messages.json` URL. */
function stubFetch(byLocale: Record<string, Record<string, string>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const locale = /_locales\/([^/]+)\/messages\.json/.exec(url)?.[1];
    const messages = locale ? byLocale[locale] : undefined;
    if (!messages) return new Response("not found", { status: 404 });
    return messagesResponse(messages);
  });
}

describe("resolveUiLocale", () => {
  it("maps browser tags onto the four locales", async () => {
    const { resolveUiLocale } = await freshRuntime();
    const auto = (tag: string) => resolveUiLocale("auto", tag);

    expect(auto("en-US")).toBe("en");
    expect(auto("en-GB")).toBe("en");
    expect(auto("hi")).toBe("hi");
    expect(auto("hi-IN")).toBe("hi");
    // Bare zh means Simplified by Chrome's locale convention.
    expect(auto("zh")).toBe("zh_CN");
    expect(auto("zh-CN")).toBe("zh_CN");
    expect(auto("zh-SG")).toBe("zh_CN");
    expect(auto("zh-Hans-SG")).toBe("zh_CN");
    expect(auto("zh-TW")).toBe("zh_TW");
    expect(auto("zh-HK")).toBe("zh_TW");
    expect(auto("zh-MO")).toBe("zh_TW");
    expect(auto("zh-Hant-HK")).toBe("zh_TW");
    // Unsupported languages fall back to English.
    expect(auto("pa-IN")).toBe("en");
    expect(auto("ja")).toBe("en");
  });

  it("passes explicit choices through untouched", async () => {
    const { resolveUiLocale } = await freshRuntime();
    expect(resolveUiLocale("hi", "en-US")).toBe("hi");
    expect(resolveUiLocale("zh_TW", "hi-IN")).toBe("zh_TW");
    expect(resolveUiLocale("en", "zh-CN")).toBe("en");
  });
});

describe("t / initI18n", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getUILanguage = () => "en-US";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves keys from the chosen locale with en fallback", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        en: { settings_connected: "Connected", settings_voices_count: "$1 voices" },
        hi: { settings_connected: "जुड़ा हुआ" },
      }),
    );
    await setSettings({ ...DEFAULT_SETTINGS, uiLanguage: "hi" });

    const runtime = await freshRuntime();
    await runtime.initI18n();

    expect(runtime.getActiveLocale()).toBe("hi");
    expect(runtime.t("settings.connected")).toBe("जुड़ा हुआ");
    // Missing from hi → falls back to the en bundle, substitutions intact.
    expect(runtime.t("settings.voices_count", ["7"])).toBe("7 voices");
  });

  it("substitutes $1 positionally", async () => {
    vi.stubGlobal("fetch", stubFetch({ en: { sandbox_characters: "$1 characters" } }));
    const runtime = await freshRuntime();
    await runtime.initI18n();
    expect(runtime.t("sandbox.characters", ["42"])).toBe("42 characters");
  });

  it("auto follows the browser language", async () => {
    fakeBrowser.i18n.getUILanguage = () => "zh-TW";
    vi.stubGlobal(
      "fetch",
      stubFetch({
        en: { settings_connected: "Connected" },
        // biome-ignore lint/style/useNamingConvention: Chrome's _locales folder name
        zh_TW: { settings_connected: "已連接" },
      }),
    );
    const runtime = await freshRuntime();
    await runtime.initI18n();
    expect(runtime.getActiveLocale()).toBe("zh_TW");
    expect(runtime.t("settings.connected")).toBe("已連接");
  });

  it("returns the key before init (or when bundles are unavailable)", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const runtime = await freshRuntime();
    // Pre-init call: nothing loaded, fakeBrowser has no getMessage data.
    expect(runtime.t("settings.connected")).toBe("settings.connected");
    await runtime.initI18n();
    // 404s for every bundle: still renders keys instead of crashing.
    expect(runtime.t("settings.connected")).toBe("settings.connected");
  });

  it("reloads and notifies when uiLanguage changes", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        en: { settings_connected: "Connected" },
        hi: { settings_connected: "जुड़ा हुआ" },
      }),
    );
    await setSettings(DEFAULT_SETTINGS);

    const runtime = await freshRuntime();
    await runtime.initI18n();
    expect(runtime.getActiveLocale()).toBe("en");
    const versionBefore = runtime.getLocaleVersion();

    const notified = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribeLocale(() => {
        unsubscribe();
        resolve();
      });
    });
    await updateSettings({ uiLanguage: "hi" });
    await notified;

    expect(runtime.getActiveLocale()).toBe("hi");
    expect(runtime.getLocaleVersion()).toBeGreaterThan(versionBefore);
    expect(runtime.t("settings.connected")).toBe("जुड़ा हुआ");
  });
});

describe("uiLanguage storage default", () => {
  beforeEach(() => fakeBrowser.reset());

  it("defaults to auto and salvages invalid stored values", async () => {
    const { salvageSettings } = await import("@/lib/storage");
    expect(DEFAULT_SETTINGS.uiLanguage).toBe("auto");
    expect(salvageSettings({ ...DEFAULT_SETTINGS, uiLanguage: "klingon" }).uiLanguage).toBe("auto");
  });
});
