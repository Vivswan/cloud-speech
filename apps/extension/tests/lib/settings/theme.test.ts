import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { SettingsSchema, setSettings } from "@/lib/settings/storage";
import { applyInitialTheme, initTheme, resolveTheme } from "@/lib/settings/theme";
import { holdNextSyncRead } from "../../helpers/held-read";

// happy-dom's matchMedia is minimal, so stub it with a controllable in-memory version.
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

/** Browsers that block storage throw on the property access itself. */
function breakLocalStorage(): void {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("denied");
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
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
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
  it("rejects an invalid stored theme", () => {
    expect(SettingsSchema.safeParse({ theme: "sepia" }).success).toBe(false);
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
    expect(isDark()).toBe(false);
  });

  it("never lets a slow initial read overwrite a newer watch event", async () => {
    stubMatchMedia(false);
    await setSettings(SettingsSchema.parse({ theme: "light" }));
    const held = holdNextSyncRead();
    try {
      initTheme();
      expect(held.started).toBe(false);
      await flush();
      expect(held.started).toBe(true);
      await fakeBrowser.storage.sync.set({ settings: SettingsSchema.parse({ theme: "dark" }) });
      await flush();
      expect(isDark()).toBe(true);

      held.resolve();
      await flush();
      expect(isDark()).toBe(true);
      expect(window.localStorage.getItem("csfc:theme")).toBe("dark");
    } finally {
      held.restore();
    }
  });
});
