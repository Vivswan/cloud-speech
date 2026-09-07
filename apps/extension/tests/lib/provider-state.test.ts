import { describe, expect, it } from "vitest";
import {
  credentialsFor,
  isProviderConfigured,
  isProviderConnected,
  isProviderEnabled,
  prefsFor,
  resolveEncoding,
  selectionEncoding,
  withProviderPrefs,
} from "@/lib/provider-state";
import { DEFAULT_SETTINGS, type ProviderPrefs, type Settings, SettingsSchema } from "@/lib/storage";
import { openai } from "@/providers/openai";
import { polly } from "@/providers/polly";

// One row per provider state; every predicate is asserted on every row so a
// predicate that drifts toward another's meaning fails here. Rows go through
// the schema like every stored blob does.
const cases: Array<{
  name: string;
  openai: Partial<ProviderPrefs>;
  expected: { enabled: boolean; configured: boolean; connected: boolean };
}> = [
  {
    name: "untouched provider",
    openai: {},
    expected: { enabled: false, configured: false, connected: false },
  },
  {
    name: "enabled without credentials",
    openai: { enabled: true },
    expected: { enabled: true, configured: false, connected: false },
  },
  {
    name: "enabled with a blank required field",
    openai: { enabled: true, credentials: { apiKey: " " } },
    expected: { enabled: true, configured: false, connected: false },
  },
  {
    name: "enabled with untested credentials",
    openai: { enabled: true, credentials: { apiKey: "sk-x" } },
    expected: { enabled: true, configured: true, connected: false },
  },
  {
    name: "enabled with verified credentials",
    openai: { enabled: true, credentials: { apiKey: "sk-x" }, verified: true },
    expected: { enabled: true, configured: true, connected: true },
  },
  {
    name: "verified credentials but switched off",
    openai: { enabled: false, credentials: { apiKey: "sk-x" }, verified: true },
    expected: { enabled: false, configured: false, connected: false },
  },
  {
    name: "a verified flag without complete credentials is cleared by the parse",
    openai: { enabled: true, credentials: { apiKey: "" }, verified: true },
    expected: { enabled: true, configured: false, connected: false },
  },
];

function withOpenai(prefs: Partial<ProviderPrefs>): Settings {
  return SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    perProvider: { openai: { credentials: {}, ...prefs } },
  });
}

describe("provider state predicates", () => {
  it.each(cases)("$name", ({ openai: prefs, expected }) => {
    const settings = withOpenai(prefs);
    expect({
      enabled: isProviderEnabled(settings, "openai"),
      configured: isProviderConfigured(settings, openai),
      connected: isProviderConnected(settings, "openai"),
    }).toEqual(expected);
  });

  it("prefsFor and credentialsFor return the stored entry, or defaults to read from", () => {
    expect(prefsFor(DEFAULT_SETTINGS, "openai")).toEqual({
      credentials: {},
      verified: false,
      enabled: false,
    });
    expect(credentialsFor(DEFAULT_SETTINGS, "openai")).toEqual({});
    const stored = { apiKey: "sk-x" };
    const settings = withOpenai({ credentials: stored });
    expect(credentialsFor(settings, "openai")).toBe(settings.perProvider.openai?.credentials);
  });

  it("withProviderPrefs changes one entry and keeps its siblings and other fields", () => {
    const settings = SettingsSchema.parse({
      perProvider: {
        openai: { credentials: { apiKey: "sk-x" }, verified: true, enabled: true },
        polly: { credentials: {}, enabled: true, lastModel: "neural" },
      },
    });
    expect(withProviderPrefs(settings, "polly", { downloadEncoding: "MP3" })).toEqual({
      perProvider: {
        openai: { credentials: { apiKey: "sk-x" }, verified: true, enabled: true },
        polly: {
          credentials: {},
          verified: false,
          enabled: true,
          lastModel: "neural",
          downloadEncoding: "MP3",
        },
      },
    });
    // A provider without an entry gets one from the defaults.
    expect(withProviderPrefs(DEFAULT_SETTINGS, "azure", { enabled: true })).toEqual({
      perProvider: { azure: { credentials: {}, verified: false, enabled: true } },
    });
  });
});

describe("resolveEncoding", () => {
  it.each([
    ["a stored choice the provider offers for that purpose", { downloadEncoding: "MP3" }, "MP3"],
    // OGG is a read-aloud format only; picked for download it falls back.
    ["a choice not offered for that purpose", { downloadEncoding: "OGG_OPUS" }, "MP3_64_KBPS"],
    ["an unknown choice", { downloadEncoding: "FLAC" }, "MP3_64_KBPS"],
    ["no choice", {}, "MP3_64_KBPS"],
  ])("download with %s", (_case, prefs, expected) => {
    const settings = SettingsSchema.parse({
      perProvider: { polly: { credentials: {}, ...prefs } },
    });
    expect(resolveEncoding(settings, polly, "download")).toBe(expected);
  });

  it("resolves per purpose and per provider, and against the selected voice's provider", () => {
    const settings = SettingsSchema.parse({
      perProvider: {
        polly: { credentials: {}, readAloudEncoding: "OGG_OPUS", downloadEncoding: "MP3" },
        openai: { credentials: {}, readAloudEncoding: "MP3_64_KBPS" },
      },
      selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
    });
    expect(resolveEncoding(settings, polly, "readAloud")).toBe("OGG_OPUS");
    expect(resolveEncoding(settings, polly, "download")).toBe("MP3");
    // OpenAI has no 64 kbps variant: its own first read-aloud format instead.
    expect(resolveEncoding(settings, openai, "readAloud")).toBe("MP3");
    expect(selectionEncoding(settings, "readAloud")).toBe("OGG_OPUS");
    expect(selectionEncoding({ ...settings, selection: null }, "readAloud")).toBeNull();
  });
});
