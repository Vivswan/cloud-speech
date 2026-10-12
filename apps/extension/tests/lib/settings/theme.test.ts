import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { SettingsSchema } from "@/lib/settings/storage";
import { applyInitialTheme, initTheme, resolveTheme } from "@/lib/settings/theme";
import { holdNextSyncRead } from "../../helpers/held-read";
import { seedSettings } from "../../helpers/seed-settings";

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

/** The held read's delivery has no handle; one macrotask drains it (the watcher's read is
 *  microtask-only over the in-memory fake), so a stale read that did overwrite would have by then. */
function drained(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    await seedSettings(SettingsSchema.parse({ theme: "dark" }));
    initTheme();
    await vi.waitFor(() => expect(isDark()).toBe(true));
    expect(window.localStorage.getItem("csfc:theme")).toBe("dark");
  });

  it("follows settings changes", async () => {
    stubMatchMedia(false);
    initTheme();
    await vi.waitFor(() => expect(window.localStorage.getItem("csfc:theme")).toBe("system"));
    expect(isDark()).toBe(false);
    await seedSettings(SettingsSchema.parse({ theme: "dark" }));
    await vi.waitFor(() => expect(isDark()).toBe(true));
    await seedSettings(SettingsSchema.parse({ theme: "light" }));
    await vi.waitFor(() => expect(isDark()).toBe(false));
  });

  it("tracks OS changes only while in system mode", async () => {
    const media = stubMatchMedia(false);
    await seedSettings(SettingsSchema.parse({ theme: "system" }));
    initTheme();
    await vi.waitFor(() => expect(window.localStorage.getItem("csfc:theme")).toBe("system"));
    expect(isDark()).toBe(false);

    media.setDark(true);
    expect(isDark()).toBe(true);

    await seedSettings(SettingsSchema.parse({ theme: "light" }));
    await vi.waitFor(() => expect(isDark()).toBe(false));
    media.setDark(false);
    media.setDark(true);
    expect(isDark()).toBe(false);
  });

  it("never lets a slow initial read overwrite a newer watch event", async () => {
    stubMatchMedia(false);
    await seedSettings(SettingsSchema.parse({ theme: "light" }));
    const held = holdNextSyncRead();
    try {
      initTheme();
      expect(held.started).toBe(false);
      await vi.waitFor(() => expect(held.started).toBe(true));
      await fakeBrowser.storage.sync.set({ settings: SettingsSchema.parse({ theme: "dark" }) });
      await vi.waitFor(() => expect(isDark()).toBe(true));

      held.resolve();
      await drained();
      expect(isDark()).toBe(true);
      expect(window.localStorage.getItem("csfc:theme")).toBe("dark");
    } finally {
      held.restore();
    }
  });
});
