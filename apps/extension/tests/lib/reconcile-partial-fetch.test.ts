import { describe, expect, it } from "vitest";
import { reconcile, selectVoice } from "@/lib/reconcile";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsInput,
  SettingsSchema,
  type VoiceIssues,
  type VoiceModelRef,
  withVoiceIssue,
} from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";

// One provider's voice fetch failing while another's succeeds leaves the
// cache with voices of the second provider only. Right after a browser
// restart nothing was cached for the first one, so its selection is not in
// the cache either; that must read as "unknown", never as "vanished".

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["standard", "neural"],
};

const jenny: NormalizedVoice = {
  id: "en-US-JennyNeural",
  providerId: "azure",
  displayName: "Jenny",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
  styles: ["cheerful"],
};

const JOANNA_NEURAL = { providerId: "polly", voiceId: "Joanna", model: "neural" } as const;
const JENNY_NEURAL = {
  providerId: "azure",
  voiceId: "en-US-JennyNeural",
  model: "neural",
} as const;
const JENNY_CHEERFUL = { ...JENNY_NEURAL, style: "cheerful" };

const AZURE_CREDENTIALS = { subscriptionKey: "azure-key", region: "eastus" };
const POLLY_CREDENTIALS = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  region: "us-east-1",
};

/** Both providers enabled with complete credentials, so the voice fetch asks
 *  both of them; the user picked Jenny cheerful and keeps favorites on both. */
function configured(patch: Partial<SettingsInput> = {}): Settings {
  return SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    perProvider: {
      azure: { credentials: AZURE_CREDENTIALS, enabled: true, verified: true, lastModel: "neural" },
      polly: { credentials: POLLY_CREDENTIALS, enabled: true, verified: true, lastModel: "neural" },
    },
    selection: JENNY_CHEERFUL,
    favorites: ["azure:en-US-JennyNeural", "polly:Joanna"],
    voicesByLanguage: { "en-US": { providerId: "azure", voiceId: "en-US-JennyNeural" } },
    language: "en-US",
    speed: 1.5,
    pitch: 4,
    volumeGainDb: 3,
    ...patch,
  });
}

/** Issues for the given (voice, engine) pairs, one shared reason. */
function flagged(...pairs: VoiceModelRef[]) {
  return pairs.reduce<VoiceIssues>(
    (issues, pair) =>
      withVoiceIssue(issues, pair, {
        title: "Could not read aloud",
        message: "Provider says: API disabled",
        detail: "Error: Provider says: API disabled",
      }),
    {},
  );
}

describe("reconcile when one provider's fetch failed", () => {
  // Azure failed at startup, Polly answered: the cache holds Polly only. The
  // selection is not judged at all, so neither its provenance nor an issue
  // an old scan recorded for it (which only ever moves an automatic pick)
  // changes the outcome.
  it.each([
    ["the user picked", {}, {}],
    ["the extension picked on its own", { voicesByLanguage: {} }, {}],
    ["an old scan flagged", { voicesByLanguage: {} }, flagged(JENNY_NEURAL)],
  ])(
    "keeps the selection, style and prosody of a voice %s while its roster is unknown",
    (_case, patch, issues) => {
      const settings = configured(patch);
      expect(reconcile(settings, [joanna], issues)).toEqual(settings);
    },
  );

  it("still holds the selection once the failed provider's fetch recovers", () => {
    const settings = configured();
    const kept = reconcile(settings, [joanna], {});
    expect(reconcile(kept, [joanna, jenny], {})).toEqual(settings);
  });

  // An import can bring any number; synthesis sends it as stored.
  it.each([
    ["the other provider answered", [joanna]],
    ["every provider failed", []],
  ])("clamps prosody to the selected voice's own provider when %s", (_case, cache) => {
    // Out of every provider's range; Azure tops out at 3.
    const settings = configured({ speed: 99 });
    expect(reconcile(settings, cache, {}).speed).toBe(3);
  });

  it("replaces the selection when its provider answered without the voice", () => {
    // Azure's roster is present, so a voice missing from it really is gone.
    const settings = configured({
      selection: { providerId: "azure", voiceId: "en-US-Retired", model: "neural", style: "x" },
    });
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual(JENNY_NEURAL);
  });

  // A disabled or unconfigured provider is never fetched, so its absence from
  // the cache is expected, not a failure; the selection cannot synthesize.
  it.each([
    ["disabled", { credentials: AZURE_CREDENTIALS, enabled: false }],
    ["enabled without credentials", { credentials: {}, enabled: true }],
  ])("replaces the selection of a provider that is %s", (_case, azure) => {
    const settings = configured({
      perProvider: {
        azure,
        polly: { credentials: POLLY_CREDENTIALS, enabled: true, lastModel: "neural" },
      },
    });
    expect(reconcile(settings, [joanna], {}).selection).toEqual(JOANNA_NEURAL);
  });

  it("still picks a voice from the providers that answered when nothing is selected", () => {
    const settings = configured({ selection: null, voicesByLanguage: {} });
    expect(reconcile(settings, [joanna], {}).selection).toEqual(JOANNA_NEURAL);
  });

  it("leaves everything untouched when every provider failed", () => {
    const settings = configured();
    expect(reconcile(settings, [], {})).toEqual(settings);
  });

  it("keeps the user's pick and moves an automatic one off a flagged pair as before", () => {
    // With both rosters present the rules for a flagged selection are the
    // ones the cache-backed reconcile always had.
    const picked = configured();
    expect(reconcile(picked, [jenny, joanna], flagged(JENNY_NEURAL)).selection).toEqual(
      JENNY_CHEERFUL,
    );
    const automatic = configured({ voicesByLanguage: {} });
    expect(reconcile(automatic, [jenny, joanna], flagged(JENNY_NEURAL)).selection).toEqual(
      JOANNA_NEURAL,
    );
  });

  it("keeps a fresh pick from the picker while another provider is down", () => {
    // Picking Joanna while Azure is out: reconcile runs right after every
    // pick, against a cache that still lacks Azure.
    const settings = configured();
    const picked = SettingsSchema.parse({
      ...settings,
      ...selectVoice(settings, joanna, "neural", "en-US"),
    });
    expect(reconcile(picked, [joanna], {}).selection).toEqual(JOANNA_NEURAL);
  });
});
