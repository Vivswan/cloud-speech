import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { DEFAULT_SETTINGS, SettingsSchema, setSettings } from "@/lib/storage";
import { applyInitialTheme, initTheme, resolveTheme } from "@/lib/theme";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getSettings: vi.fn(actual.getSettings) };
});

const { getSettings } = await import("@/lib/storage");

// happy-dom's matchMedia is minimal and this environment exposes no
// localStorage at all — stub both with controllable in-memory versions.
type Listener = () => void;

function stubMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  const listeners: Listener[] = [];
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_type: string, listener: Listener) => void listeners.push(listener),
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return {
    setDark(dark: boolean) {
      matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
  return store;
}

function breakLocalStorage(): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    },
  });
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fakeBrowser.reset();
  stubLocalStorage();
  document.documentElement.classList.remove("dark");
});

describe("resolveTheme", () => {
  it("passes explicit themes through and resolves system via the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("theme setting", () => {
  it("defaults to system", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("system");
  });

  it("rejects an invalid stored theme and defaults back to system", () => {
    expect(SettingsSchema.safeParse({ theme: "sepia" }).success).toBe(false);
    expect(SettingsSchema.parse({}).theme).toBe("system");
  });
});

describe("applyInitialTheme", () => {
  it("follows the OS when no cache exists", () => {
    stubMatchMedia(true);
    applyInitialTheme();
    expect(isDark()).toBe(true);
  });

  it("uses the cached explicit theme over the OS", () => {
    stubMatchMedia(true);
    window.localStorage.setItem("csfc:theme", "light");
    applyInitialTheme();
    expect(isDark()).toBe(false);
  });

  it("survives an unavailable localStorage", () => {
    stubMatchMedia(true);
    breakLocalStorage();
    expect(() => applyInitialTheme()).not.toThrow();
    expect(isDark()).toBe(true);
  });
});

describe("initTheme", () => {
  it("applies the stored setting and mirrors it into the cache", async () => {
    stubMatchMedia(false);
    await setSettings(SettingsSchema.parse({ theme: "dark" }));
    initTheme();
    await flush();
    expect(isDark()).toBe(true);
    expect(window.localStorage.getItem("csfc:theme")).toBe("dark");
  });

  it("follows settings changes", async () => {
    stubMatchMedia(false);
    initTheme();
    await flush();
    expect(isDark()).toBe(false);
    await setSettings(SettingsSchema.parse({ theme: "dark" }));
    await flush();
    expect(isDark()).toBe(true);
    await setSettings(SettingsSchema.parse({ theme: "light" }));
    await flush();
    expect(isDark()).toBe(false);
  });

  it("tracks OS changes only while in system mode", async () => {
    const media = stubMatchMedia(false);
    await setSettings(SettingsSchema.parse({ theme: "system" }));
    initTheme();
    await flush();
    expect(isDark()).toBe(false);

    media.setDark(true);
    expect(isDark()).toBe(true);

    await setSettings(SettingsSchema.parse({ theme: "light" }));
    await flush();
    expect(isDark()).toBe(false);
    media.setDark(false);
    media.setDark(true);
    expect(isDark()).toBe(false); // explicit light wins over the OS
  });

  it("never lets a slow initial read overwrite a newer watch event", async () => {
    stubMatchMedia(false);
    // The initial getSettings() resolves LATE, after the user already
    // changed the theme (watch event) — its stale value must be ignored.
    let resolveInitial: (settings: typeof DEFAULT_SETTINGS) => void = () => {};
    vi.mocked(getSettings).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );
    initTheme();
    await setSettings(SettingsSchema.parse({ theme: "dark" }));
    await flush();
    expect(isDark()).toBe(true);

    resolveInitial(SettingsSchema.parse({ theme: "light" })); // stale
    await flush();
    expect(isDark()).toBe(true);
    expect(window.localStorage.getItem("csfc:theme")).toBe("dark");
  });
});
