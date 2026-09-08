import { describe, expect, it } from "vitest";
import { withProviderPrefs } from "@/lib/provider-state";
import { reconcile, selectVoice } from "@/lib/reconcile";
import {
  DEFAULT_SETTINGS,
  type Selection,
  type Settings,
  type SettingsInput,
  SettingsSchema,
  type VoiceIssues,
  type VoiceModelRef,
  withVoiceIssue,
} from "@/lib/storage";
import { upgradeSettingsBlob } from "@/migrations";
import { settingsFromFlatKeys } from "@/migrations/000000";
import type { NormalizedVoice } from "@/providers/types";

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

const matthew: NormalizedVoice = {
  id: "Matthew",
  providerId: "polly",
  displayName: "Matthew",
  languageCodes: ["en-US"],
  gender: "Male",
  models: ["neural"],
};

const MATTHEW_NEURAL = { providerId: "polly", voiceId: "Matthew", model: "neural" } as const;

function settingsWith(patch: Partial<SettingsInput>): Settings {
  return SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    perProvider: {
      polly: { credentials: {}, enabled: true },
      azure: { credentials: {}, enabled: true },
    },
    ...patch,
  });
}

/** Issues for the given (voice, engine) pairs, one shared reason. */
function flagged(...pairs: VoiceModelRef[]) {
  return pairs.reduce<VoiceIssues>(
    (issues, pair) => withVoiceIssue(issues, pair, "Provider says: API disabled"),
    {},
  );
}

describe("reconcile", () => {
  it("leaves everything untouched when the voice cache is empty", () => {
    const settings = settingsWith({
      selection: { providerId: "polly", voiceId: "Ghost", model: "neural" },
    });
    // A transient fetch failure must never wipe a working setup.
    expect(reconcile(settings, [], {})).toEqual(settings);
  });

  it("keeps a valid selection as-is, engine and supported style included", () => {
    const settings = settingsWith({ selection: { ...JENNY_NEURAL, style: "cheerful" } });
    expect(reconcile(settings, [joanna, jenny], {})).toEqual(settings);
  });

  it.each([
    ["the engine the user last picked for that provider", { lastModel: "neural" }, "neural"],
    ["the voice's first engine when nothing was picked before", {}, "standard"],
  ])("replaces a vanished voice with a fallback on %s", (_case, pollyPrefs, model) => {
    const settings = settingsWith({
      selection: { providerId: "polly", voiceId: "Deleted", model: "neural", style: "x" },
      perProvider: {
        polly: { credentials: {}, enabled: true, ...pollyPrefs },
        azure: { credentials: {}, enabled: true },
      },
      language: "en-US",
    });
    // The fallback voice starts fresh: the old voice's style never carries over.
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual({
      providerId: "polly",
      voiceId: "Joanna",
      model,
    });
  });

  it("prefers a favorite when repairing (first-colon composite key)", () => {
    const settings = settingsWith({ selection: null, favorites: ["azure:en-US-JennyNeural"] });
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual(JENNY_NEURAL);
  });

  it("skips malformed favorites (no colon, empty voice id, unknown provider)", () => {
    const settings = settingsWith({
      selection: null,
      favorites: ["nocolon", "polly:", "bogus:some-voice", "azure:en-US-JennyNeural"],
    });
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual(JENNY_NEURAL);
  });

  it("never picks a voice from a disabled provider", () => {
    const settings = settingsWith({
      selection: JENNY_NEURAL,
      perProvider: {
        polly: { credentials: {}, enabled: true },
        azure: { credentials: {}, enabled: false },
      },
    });
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual({
      ...JOANNA_NEURAL,
      model: "standard",
    });
  });

  it("keeps the voice but repairs an engine it no longer offers", () => {
    const settings = settingsWith({
      selection: { ...JENNY_NEURAL, model: "generative", style: "cheerful" },
    });
    // Same voice, its first engine; the style is re-checked against that
    // engine and Jenny still supports it.
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual({
      ...JENNY_NEURAL,
      style: "cheerful",
    });
  });

  it("drops a style the voice/model combination does not support", () => {
    const settings = settingsWith({ selection: { ...JOANNA_NEURAL, style: "cheerful" } });
    expect(reconcile(settings, [joanna, jenny], {}).selection).toEqual(JOANNA_NEURAL);
  });

  it("clears the selection when no enabled provider has any voice", () => {
    const settings = settingsWith({
      selection: JOANNA_NEURAL,
      perProvider: { polly: { credentials: {}, enabled: false } },
    });
    expect(reconcile(settings, [joanna], {}).selection).toBeNull();
  });

  it("clamps prosody into the provider ranges", () => {
    const settings = settingsWith({
      selection: JOANNA_NEURAL,
      speed: 99,
      pitch: -99,
      volumeGainDb: 99,
    });
    const result = reconcile(settings, [joanna], {});
    // Polly caps prosody rate at 200%, so its range tops out at 2, not the default 3.
    expect(result.speed).toBe(2);
    expect(result.pitch).toBe(-10);
    expect(result.volumeGainDb).toBe(16);
  });
});

describe("reconcile with voice issues", () => {
  // The scan learns which engines the account can use; the selection must
  // never rest on a pair the extension already knows fails while a working
  // voice of the same language exists.
  const cases: {
    case: string;
    settings: Settings;
    voices: NormalizedVoice[];
    issues: VoiceIssues;
    expected: Selection;
  }[] = [
    {
      case: "a fallback skips the flagged voice that comes first in the cache",
      settings: settingsWith({ selection: null, language: "en-US" }),
      voices: [jenny, joanna],
      issues: flagged(JENNY_NEURAL),
      expected: { ...JOANNA_NEURAL, model: "standard" },
    },
    {
      case: "a fallback keeps the favorites order among unflagged voices",
      settings: settingsWith({
        selection: null,
        favorites: ["azure:en-US-JennyNeural", "polly:Matthew", "polly:Joanna"],
      }),
      voices: [joanna, jenny, matthew],
      issues: flagged(JENNY_NEURAL),
      expected: MATTHEW_NEURAL,
    },
    {
      case: "a fallback picks the unflagged engine of a dual-engine voice",
      settings: settingsWith({
        selection: null,
        language: "en-US",
        perProvider: { polly: { credentials: {}, enabled: true, lastModel: "standard" } },
      }),
      voices: [joanna],
      issues: flagged({ ...JOANNA_NEURAL, model: "standard" }),
      expected: JOANNA_NEURAL,
    },
    {
      case: "a flagged selection moves to an unflagged voice of the same language",
      settings: settingsWith({ selection: JENNY_NEURAL, language: "en-US" }),
      voices: [jenny, joanna],
      issues: flagged(JENNY_NEURAL),
      expected: { ...JOANNA_NEURAL, model: "standard" },
    },
    {
      case: "a flagged selection prefers another engine of the same voice",
      settings: settingsWith({ selection: JOANNA_NEURAL, language: "en-US" }),
      voices: [jenny, joanna],
      issues: flagged(JOANNA_NEURAL),
      expected: { ...JOANNA_NEURAL, model: "standard" },
    },
    {
      case: "a flagged selection stays with its provider before crossing to another",
      settings: settingsWith({ selection: MATTHEW_NEURAL, language: "en-US" }),
      voices: [jenny, joanna, matthew],
      issues: flagged(MATTHEW_NEURAL),
      expected: { ...JOANNA_NEURAL, model: "standard" },
    },
    {
      case: "a flagged selection follows a favorite over its own provider",
      settings: settingsWith({
        selection: MATTHEW_NEURAL,
        language: "en-US",
        favorites: ["azure:en-US-JennyNeural"],
      }),
      voices: [jenny, joanna, matthew],
      issues: flagged(MATTHEW_NEURAL),
      expected: JENNY_NEURAL,
    },
    {
      case: "a flagged selection never moves to a voice of another language",
      settings: settingsWith({ selection: JENNY_NEURAL, language: "en-US" }),
      voices: [jenny, { ...joanna, languageCodes: ["en-GB"] }],
      issues: flagged(JENNY_NEURAL),
      expected: JENNY_NEURAL,
    },
    {
      case: "a flagged selection skips a favorite of another language",
      settings: settingsWith({
        selection: JENNY_NEURAL,
        language: "en-US",
        favorites: ["polly:Joanna"],
      }),
      voices: [jenny, { ...joanna, languageCodes: ["en-GB"] }, matthew],
      issues: flagged(JENNY_NEURAL),
      expected: MATTHEW_NEURAL,
    },
    {
      case: "a fallback with no voice of the language still avoids a flagged engine",
      settings: settingsWith({
        selection: null,
        language: "en-US",
        perProvider: { polly: { credentials: {}, enabled: true, lastModel: "neural" } },
      }),
      voices: [{ ...joanna, languageCodes: ["multilingual"] }],
      issues: flagged(JOANNA_NEURAL),
      expected: { ...JOANNA_NEURAL, model: "standard" },
    },
    {
      case: "a flagged selection the user picked for this language stays",
      settings: settingsWith({
        selection: JENNY_NEURAL,
        language: "en-US",
        voicesByLanguage: { "en-US": { providerId: "azure", voiceId: "en-US-JennyNeural" } },
      }),
      voices: [jenny, joanna],
      issues: flagged(JENNY_NEURAL),
      expected: JENNY_NEURAL,
    },
    {
      case: "a flagged selection the user picked under another language stays too",
      settings: settingsWith({
        selection: JENNY_NEURAL,
        language: "en-US",
        voicesByLanguage: { "fr-FR": { providerId: "azure", voiceId: "en-US-JennyNeural" } },
      }),
      voices: [jenny, joanna],
      issues: flagged(JENNY_NEURAL),
      expected: JENNY_NEURAL,
    },
    {
      case: "a flagged selection stays when every engine of every voice is flagged",
      settings: settingsWith({ selection: JENNY_NEURAL, language: "en-US" }),
      voices: [jenny, joanna],
      issues: flagged(JENNY_NEURAL, JOANNA_NEURAL, { ...JOANNA_NEURAL, model: "standard" }),
      expected: JENNY_NEURAL,
    },
    {
      case: "a fallback with only flagged voices still selects one",
      settings: settingsWith({ selection: null, language: "en-US" }),
      voices: [jenny],
      issues: flagged(JENNY_NEURAL),
      expected: JENNY_NEURAL,
    },
  ];
  it.each(cases)("$case", ({ settings, voices, issues, expected }) => {
    expect(reconcile(settings, voices, issues).selection).toEqual(expected);
  });

  it("keeps the flagged voice the user just picked from the picker", () => {
    // selectVoice is the one user write; its per-language memory is what
    // marks the selection as the user's, so a deliberate retry of a flagged
    // voice survives the reconcile that follows every pick.
    const before = settingsWith({ selection: { ...JOANNA_NEURAL, model: "standard" } });
    const picked = settingsWith({ ...before, ...selectVoice(before, jenny, "neural", "en-US") });
    expect(reconcile(picked, [jenny, joanna], flagged(JENNY_NEURAL)).selection).toEqual(
      JENNY_NEURAL,
    );
  });

  it("keeps the flagged voice a Google-fork install had selected", () => {
    // The fork conversion remembers the selected voice under the voice's own
    // language while `language` keeps its default, so the provenance check
    // must not be tied to the current language.
    const converted = SettingsSchema.parse(
      upgradeSettingsBlob(
        settingsFromFlatKeys({ apiKey: "AIza-example", locale: "fr-FR-Wavenet-A" }),
      ),
    );
    // Save & test enables the provider; the conversion alone does not.
    const enabled = SettingsSchema.parse({
      ...converted,
      ...withProviderPrefs(converted, "google", { enabled: true }),
    });
    const denise: NormalizedVoice = {
      id: "fr-FR-Wavenet-A",
      providerId: "google",
      displayName: "fr-FR-Wavenet-A",
      languageCodes: ["fr-FR"],
      gender: "Female",
      models: ["wavenet"],
    };
    const english: NormalizedVoice = {
      ...denise,
      id: "en-US-Standard-A",
      languageCodes: ["en-US"],
      models: ["standard"],
    };
    const wavenetDown = flagged({ providerId: "google", voiceId: denise.id, model: "wavenet" });
    expect(enabled).toMatchObject({ language: "en-US" });
    expect(reconcile(enabled, [denise, english], wavenetDown).selection).toEqual({
      providerId: "google",
      voiceId: "fr-FR-Wavenet-A",
      model: "wavenet",
    });
  });

  it("re-checks the style against the engine a flagged selection moves to", () => {
    // Azure styles exist on neural only, so the move to standard drops it.
    const dualJenny: NormalizedVoice = { ...jenny, models: ["neural", "standard"] };
    const settings = settingsWith({ selection: { ...JENNY_NEURAL, style: "cheerful" } });
    expect(reconcile(settings, [dualJenny, joanna], flagged(JENNY_NEURAL)).selection).toEqual({
      ...JENNY_NEURAL,
      model: "standard",
    });
  });

  it("resolves a Chirp 3 HD selection persisted on the shared chirp engine at read time", () => {
    // Chirp 3 HD voices used to share Google's "chirp" family. The voice no
    // longer offers that engine, so the selection repairs to its own family
    // on read, without a settings migration step.
    const achernar: NormalizedVoice = {
      id: "en-US-Chirp3-HD-Achernar",
      providerId: "google",
      displayName: "en-US-Chirp3-HD-Achernar",
      languageCodes: ["en-US"],
      gender: "Female",
      models: ["chirp3"],
    };
    const settings = settingsWith({
      selection: { providerId: "google", voiceId: achernar.id, model: "chirp" },
      perProvider: { google: { credentials: {}, enabled: true, lastModel: "chirp" } },
    });
    expect(reconcile(settings, [achernar], {}).selection).toEqual({
      providerId: "google",
      voiceId: achernar.id,
      model: "chirp3",
    });
  });
});

describe("selectVoice", () => {
  const withJenny = settingsWith({
    selection: { ...JENNY_NEURAL, style: "cheerful" },
    language: "fr-FR",
    voicesByLanguage: { "fr-FR": { providerId: "azure", voiceId: "fr-FR-DeniseNeural" } },
  });

  it("re-picking the current voice and engine keeps its style", () => {
    expect(selectVoice(withJenny, jenny, "neural", "en-US")).toEqual({
      selection: { ...JENNY_NEURAL, style: "cheerful" },
      language: "en-US",
      voicesByLanguage: {
        "fr-FR": { providerId: "azure", voiceId: "fr-FR-DeniseNeural" },
        "en-US": { providerId: "azure", voiceId: "en-US-JennyNeural" },
      },
      perProvider: {
        polly: { credentials: {}, verified: false, enabled: true },
        azure: { credentials: {}, verified: false, enabled: true, lastModel: "neural" },
      },
    });
  });

  it.each([
    ["another voice", joanna, "neural"],
    ["the same voice on another engine", jenny, "standard"],
  ])(
    "picking %s starts without a style and remembers the engine for its provider",
    (_case, voice, model) => {
      const patch = selectVoice(withJenny, voice, model, "en-US");
      expect(patch.selection).toEqual({ providerId: voice.providerId, voiceId: voice.id, model });
      expect(patch.perProvider?.[voice.providerId]?.lastModel).toBe(model);
    },
  );
});
