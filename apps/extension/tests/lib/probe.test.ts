import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";

// Mock the provider registry with one fake provider exposing two engine
// families: "good" (synthesizes fine) and "bad" (rejects like a 403).
// vi.mock factories are hoisted, so the shared fake lives in vi.hoisted.
const { synthesize, fakeProvider } = vi.hoisted(() => {
  const synthesize = vi.fn(
    async (
      args: import("@/providers/types").SynthesizeArgs,
    ): Promise<import("@/providers/types").SynthResult> => {
      if (args.model === "bad") throw new Error("Provider says: family disabled");
      return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg", extension: "mp3" };
    },
  );
  // Typed against the real interface so drift in TtsProvider breaks THIS
  // file at compile time instead of silently diverging from production.
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
    hasCredentials: () => true,
    synthesize,
  } satisfies Pick<
    import("@/providers/types").TtsProvider,
    "id" | "audioFormats" | "hasCredentials" | "synthesize"
  >;
  return { synthesize, fakeProvider };
});

vi.mock("@/providers", () => ({
  providerList: [fakeProvider],
  getProvider: () => fakeProvider,
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    getSettings: vi.fn().mockResolvedValue({
      enabledProviders: { polly: true },
      credentials: { polly: { key: "x" } },
      readAloudEncoding: "MP3",
    }),
  };
});

import { scanVoiceAvailability } from "@/lib/probe";
import { voiceIssuesItem, voicesSessionItem } from "@/lib/storage";

const voice = (id: string, families: string[]) => ({
  id,
  providerId: "polly" as const,
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
    // One request per family, not per voice.
    expect(synthesize).toHaveBeenCalledTimes(2);

    const issues = await voiceIssuesItem.getValue();
    expect(issues["polly:bad-a:bad"]).toContain("family disabled");
    // The dual voice is broken on "bad" but fine on "good": per-engine marks.
    expect(issues["polly:dual:bad"]).toContain("family disabled");
    expect(issues["polly:dual:good"]).toBeUndefined();
    expect(issues["polly:good-a:good"]).toBeUndefined();
    expect(issues["polly:good-b:good"]).toBeUndefined();
  });

  it("clears stale issues when a family works again", async () => {
    await voiceIssuesItem.setValue({ "polly:good-a:good": "old failure" });

    await scanVoiceAvailability("polly");

    const issues = await voiceIssuesItem.getValue();
    expect(issues["polly:good-a:good"]).toBeUndefined();
  });

  it("scans only the requested provider", async () => {
    const result = await scanVoiceAvailability("azure");
    expect(result).toEqual({ familiesChecked: 0, familiesUnavailable: 0 });
    expect(synthesize).not.toHaveBeenCalled();
  });
});
