import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
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

function localeOf(input: RequestInfo | URL) {
  return /_locales\/([^/]+)\/messages\.json/.exec(String(input))?.[1];
}

/** fetch stub keyed by the locale in the `_locales/<locale>/messages.json` URL. */
function stubFetch(byLocale: Record<string, Record<string, string>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const locale = localeOf(input);
    const messages = locale ? byLocale[locale] : undefined;
    if (!messages) return new Response("not found", { status: 404 });
    return messagesResponse(messages);
  });
}

function gatedFetch(byLocale: Record<string, Record<string, string>>) {
  const respond = stubFetch(byLocale);
  const opened = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const locale = localeOf(input) ?? "";
    if (!opened.has(locale)) {
      await new Promise<void>((resolve) => {
        waiting.set(locale, [...(waiting.get(locale) ?? []), resolve]);
      });
    }
    return respond(input);
  });
  return {
    fetchMock,
    requested: (locale: string) =>
      vi.waitFor(() => expect(waiting.get(locale)?.length ?? 0).toBeGreaterThan(0)),
    open: (locale: string) => {
      opened.add(locale);
      for (const resume of waiting.get(locale) ?? []) resume();
      waiting.delete(locale);
    },
  };
}

/** A slow settings read, as on a real storage backend. The settings live in the sync area by
 *  default (syncEnabledItem's fallback), so that is the area read. */
function slowReads() {
  const original = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync);
  let parking = false;
  let parked: Array<() => void> = [];
  vi.spyOn(fakeBrowser.storage.sync, "get").mockImplementation(async (...args) => {
    const value = await original(...(args as Parameters<typeof original>));
    if (parking) await new Promise<void>((deliver) => parked.push(deliver));
    return value;
  });
  return {
    hold: () => {
      parking = true;
    },
    pass: () => {
      parking = false;
    },
    parkedOne: () => vi.waitFor(() => expect(parked.length).toBe(1)),
    resume: () => {
      const deliveries = parked;
      parked = [];
      for (const deliver of deliveries) deliver();
    },
  };
}

function writeLocale(uiLanguage: "en" | "hi" | "zh_CN") {
  return fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, uiLanguage } });
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
    vi.restoreAllMocks();
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
    // Missing from hi -> falls back to the en bundle, substitutions intact.
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

  it("resolves with the locale written during the initial load, not the one it started with", async () => {
    const gate = gatedFetch({
      en: { settings_connected: "Connected" },
      hi: { settings_connected: "जुड़ा हुआ" },
    });
    vi.stubGlobal("fetch", gate.fetchMock);
    await setSettings(DEFAULT_SETTINGS);

    const runtime = await freshRuntime();
    const init = runtime.initI18n();
    await gate.requested("en");
    await setSettings({ ...DEFAULT_SETTINGS, uiLanguage: "hi" });
    await gate.requested("hi");
    gate.open("en");
    gate.open("hi");
    await init;

    expect(runtime.getActiveLocale()).toBe("hi");
    expect(runtime.t("settings.connected")).toBe("जुड़ा हुआ");
  });

  it("waits for a write whose read is still in flight when the first load finishes", async () => {
    const gate = gatedFetch({
      en: { settings_connected: "Connected" },
      hi: { settings_connected: "जुड़ा हुआ" },
    });
    vi.stubGlobal("fetch", gate.fetchMock);
    await setSettings(DEFAULT_SETTINGS);
    const reads = slowReads();

    const runtime = await freshRuntime();
    const init = runtime.initI18n();
    let localeAtResolve: string | null = null;
    void init.then(() => {
      localeAtResolve = runtime.getActiveLocale();
    });
    await gate.requested("en");
    reads.hold();
    await writeLocale("hi");
    await reads.parkedOne();
    gate.open("en");
    await new Promise((resolve) => setTimeout(resolve, 0));
    reads.pass();
    reads.resume();
    gate.open("hi");
    await init;

    expect(localeAtResolve).toBe("hi");
  });

  it("a slow read of an older write cannot overwrite a newer write", async () => {
    const fetchMock = stubFetch({
      en: { settings_connected: "Connected" },
      hi: { settings_connected: "जुड़ा हुआ" },
      // biome-ignore lint/style/useNamingConvention: Chrome's _locales folder name
      zh_CN: { settings_connected: "已连接" },
    });
    vi.stubGlobal("fetch", fetchMock);
    await setSettings(DEFAULT_SETTINGS);
    const runtime = await freshRuntime();
    await runtime.initI18n();
    const reads = slowReads();

    reads.hold();
    await writeLocale("hi");
    await reads.parkedOne();
    reads.pass();
    await writeLocale("zh_CN");
    await vi.waitFor(() => expect(runtime.getActiveLocale()).toBe("zh_CN"));
    reads.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getActiveLocale()).toBe("zh_CN");
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/hi/"));
  });

  it("resolves after a bundle fails to load and does not retry it", async () => {
    const fetchMock = stubFetch({});
    vi.stubGlobal("fetch", fetchMock);
    await setSettings({ ...DEFAULT_SETTINGS, uiLanguage: "hi" });

    const runtime = await freshRuntime();
    await runtime.initI18n();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtime.getActiveLocale()).toBe("en");
    expect(runtime.t("settings.connected")).toBe("settings.connected");
  });
});

describe("uiLanguage storage", () => {
  beforeEach(() => fakeBrowser.reset());

  it("salvages an invalid stored value back to auto", async () => {
    const { salvageSettings } = await import("@/lib/storage");
    expect(salvageSettings({ ...DEFAULT_SETTINGS, uiLanguage: "klingon" }).uiLanguage).toBe("auto");
  });
});
