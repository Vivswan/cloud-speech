import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// vi.mock factories are hoisted, so the shared fake lives in vi.hoisted.
const { synthesize, fakeProvider, SHORT_KEY } = vi.hoisted(() => {
  /** Too short for the redaction by shape (no key=value form, under 40 characters), so only blanking the configured value itself catches it. */
  const SHORT_KEY = "short-secret-123";
  const synthesize = vi.fn(
    async (
      args: import("@/providers/types").SynthesizeArgs,
    ): Promise<import("@/providers/types").SynthResult> => {
      // Like a server that quotes the key it rejected.
      if (args.model === "bad") {
        throw new Error(`Provider says: family disabled for ${args.credentials.key}`);
      }
      return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg", extension: "mp3" };
    },
  );
  const fakeProvider = {
    id: "polly",
    audioFormats: [
      {
        id: "MP3",
        mimeType: "audio/mpeg",
        extension: "mp3",
        stitchable: true,
        forDownload: true,
        forReadAloud: true,
      },
    ],
    // Named so the recorded failure's detail can be blanked of the key.
    credentialSchema: [
      { key: "key", labelKey: "providers.polly.accessKeyId", placeholder: "", type: "password" },
    ],
    hasCredentials: () => true,
    synthesize,
    // The post-scan reconcile asks these for the selection it settles on.
    supportsStyle: () => false,
    ranges: () => ({
      speed: { min: 0.5, max: 3, default: 1, step: 0.05 },
      pitch: { min: -10, max: 10, default: 0, step: 0.1 },
      volumeGainDb: { min: -16, max: 16, default: 0, step: 1 },
    }),
  } satisfies Pick<
    import("@/providers/types").TtsProvider,
    | "id"
    | "audioFormats"
    | "credentialSchema"
    | "hasCredentials"
    | "synthesize"
    | "supportsStyle"
    | "ranges"
  >;
  return { synthesize, fakeProvider, SHORT_KEY };
});

vi.mock("@/providers", () => ({
  providerList: [fakeProvider],
  getProvider: (id: string) => ({ ...fakeProvider, id }),
}));
// Keys, not sentences, with the substitutions in brackets: the recorded failure is asserted by which message it picked and whose name it filled in.
vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string, subs?: string[]) => (subs?.length ? `${key}[${subs.join("|")}]` : key) },
  tDynamic: (key: string, subs?: string[]) => (subs?.length ? `${key}[${subs.join("|")}]` : key),
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    getSettings: vi.fn().mockResolvedValue({
      perProvider: {
        polly: { enabled: true, credentials: { key: SHORT_KEY }, readAloudEncoding: "MP3" },
      },
    }),
  };
});

import { scanVoiceAvailability } from "@/lib/probe";
import { reconcileSettings, selectVoice } from "@/lib/reconcile";
import {
  readSettingsRecord,
  readVoiceIssues,
  SettingsSchema,
  setSettings,
  updateSettingsWith,
  type VoiceIssue,
  voiceIssuesItem,
  voicesSessionItem,
} from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";

/** The "bad" family's failure as the picker will show it.
 *    title    -> the one Save & test gives a scan failure
 *    message  -> the stock sentence naming Polly, since the fake provider recognizes nothing
 *    detail   -> the raw text, the echoed key blanked */
const FAMILY_DISABLED: VoiceIssue = {
  title: "settings.validation_unknown_title",
  message: "errors.unknown_message[Amazon Polly|]",
  detail: "Error: Provider says: family disabled for [redacted]",
};

const voice = (id: string, families: [string, ...string[]]): NormalizedVoice => ({
  id,
  providerId: "polly",
  displayName: id,
  languageCodes: ["en-US"],
  gender: "Female",
  models: families,
});

describe("scanVoiceAvailability", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    await voicesSessionItem.setValue([
      voice("good-a", ["good"]),
      voice("good-b", ["good"]),
      voice("bad-a", ["bad"]),
      // Dual-engine voice: must be judged per engine, not by models[0].
      voice("dual", ["good", "bad"]),
    ]);
  });

  it("probes one voice per family and marks every (voice, engine) of a failing family", async () => {
    const result = await scanVoiceAvailability("polly");

    expect(result).toEqual({ familiesChecked: 2, familiesUnavailable: 1 });
    // One request per family, not per voice, with the provider's read-aloud format.
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ encoding: "MP3" }));

    expect(await voiceIssuesItem.getValue()).toEqual({
      polly: { "bad-a": { bad: FAMILY_DISABLED }, dual: { bad: FAMILY_DISABLED } },
    });
    // Control: the provider did echo the key; the store never saw it.
    const outcomes = await Promise.allSettled(synthesize.mock.results.map((r) => r.value));
    const rejections = outcomes.flatMap((o) => (o.status === "rejected" ? [String(o.reason)] : []));
    expect(rejections).toEqual([expect.stringContaining(SHORT_KEY)]);
    expect(JSON.stringify(await voiceIssuesItem.getValue())).not.toContain(SHORT_KEY);
  });

  it("clears stale issues when a family works again", async () => {
    await voiceIssuesItem.setValue({ polly: { "good-a": { good: FAMILY_DISABLED } } });

    await scanVoiceAvailability("polly");

    expect((await readVoiceIssues()).polly?.["good-a"]).toBeUndefined();
  });

  it.each([
    {
      case: "an automatic selection on a failing family moves to a working voice",
      before: { providerId: "polly", voiceId: "bad-a", model: "bad" },
      userPicked: false,
      after: { providerId: "polly", voiceId: "good-a", model: "good" },
    },
    {
      case: "an automatic selection on a dual-engine voice's failing engine moves to its working one",
      before: { providerId: "polly", voiceId: "dual", model: "bad" },
      userPicked: false,
      after: { providerId: "polly", voiceId: "dual", model: "good" },
    },
    {
      case: "a selection the user picked survives the scan flagging it",
      before: { providerId: "polly", voiceId: "bad-a", model: "bad" },
      userPicked: true,
      after: { providerId: "polly", voiceId: "bad-a", model: "bad" },
    },
  ] as const)("$case", async ({ before, userPicked, after }) => {
    // The fetch-time fallback picked blind; the scan is when the extension learns the family fails, so that selection
    // must follow right away. A user's pick is recorded in the per-language memory and is theirs.
    await setSettings(
      SettingsSchema.parse({
        perProvider: { polly: { credentials: { key: "x" }, enabled: true } },
        selection: before,
        language: "en-US",
        voicesByLanguage: userPicked
          ? { "en-US": { providerId: before.providerId, voiceId: before.voiceId } }
          : {},
      }),
    );

    await scanVoiceAvailability("polly");

    expect((await readSettingsRecord()).settings.selection).toEqual(after);
  });

  it("keeps a voice the user picked in Preferences through a later Save & test", async () => {
    // The user deliberately picks the flagged voice (the picker keeps flagged rows selectable), then re-saves the key:
    // the post-fetch reconcile and the scan's reconcile both run, and neither may move their pick.
    await setSettings(
      SettingsSchema.parse({
        perProvider: { polly: { credentials: { key: "x" }, enabled: true } },
        selection: { providerId: "polly", voiceId: "good-a", model: "good" },
        language: "en-US",
      }),
    );
    await voiceIssuesItem.setValue({ polly: { "bad-a": { bad: FAMILY_DISABLED } } });
    const voices = await voicesSessionItem.getValue();
    const badVoice = voices.find((v) => v.id === "bad-a");
    if (!badVoice) throw new Error("fixture lost bad-a");
    await updateSettingsWith((current) => selectVoice(current, badVoice, "bad", "en-US"));
    await reconcileSettings(voices);

    await reconcileSettings(voices);
    await scanVoiceAvailability("polly");

    const picked = { providerId: "polly", voiceId: "bad-a", model: "bad" };
    expect((await readSettingsRecord()).settings.selection).toEqual(picked);
    expect((await readVoiceIssues()).polly?.["bad-a"]?.bad).toEqual(FAMILY_DISABLED);
  });

  it("scans only the requested provider", async () => {
    const result = await scanVoiceAvailability("azure");
    expect(result).toEqual({ familiesChecked: 0, familiesUnavailable: 0 });
    expect(synthesize).not.toHaveBeenCalled();
  });
});
