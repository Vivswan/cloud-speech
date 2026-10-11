import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Preferences } from "@/components/app/views/Preferences";
import { DEFAULT_SETTINGS, voicesSessionItem } from "@/lib/settings/storage";
import type { UiLocale } from "@/lib/text/i18n-runtime";
import type { NormalizedVoice } from "@/providers/types";

// The language select is the one place the extension prints a tag's region itself, after ICU's name
// for the language. ICU writes zh regions in full-width parentheses, so the row has to be read under a
// zh UI locale too, not only under en, or a row carrying ICU's region and the tag's passes unseen.
const ui = vi.hoisted(() => ({ locale: "en" as UiLocale }));
vi.mock("@/lib/text/i18n-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/text/i18n-runtime")>()),
  getActiveLocale: () => ui.locale,
}));

function pollyVoice(code: string): NormalizedVoice {
  return {
    id: `voice-${code}`,
    providerId: "polly",
    displayName: `Voice ${code}`,
    languageCodes: [code],
    gender: "Female",
    models: ["neural"],
  };
}

function pollySettings(code: string) {
  return {
    ...DEFAULT_SETTINGS,
    perProvider: {
      polly: {
        credentials: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
        verified: true,
        enabled: true,
      },
    },
    selection: { providerId: "polly", voiceId: `voice-${code}`, model: "neural" },
    language: code,
  };
}

describe("Preferences language select", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // fakeBrowser's commands.getAll throws "not implemented" synchronously.
    vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation((() =>
      Promise.resolve([])) as never);
  });

  it.each([
    { locale: "zh_CN", code: "en-IN", title: "英语 (IN)" },
    { locale: "en", code: "en-US", title: "English (US)" },
  ] as const)(
    "under uiLanguage $locale the row for $code reads $title",
    async ({ locale, code, title }) => {
      ui.locale = locale;
      await fakeBrowser.storage.sync.set({ settings: pollySettings(code) });
      await voicesSessionItem.setValue([pollyVoice(code)]);
      render(<Preferences />);

      const [languageSelect] = await screen.findAllByRole("combobox");
      await waitFor(() => expect(languageSelect?.textContent).toBe(title));
    },
  );
});
