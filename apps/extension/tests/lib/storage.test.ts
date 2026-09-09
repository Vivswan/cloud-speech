import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { withProviderPrefs } from "@/lib/provider-state";
import {
  clearVoiceIssue,
  DEFAULT_SETTINGS,
  decodeVoiceIssues,
  discardSettingsBackup,
  getSettings,
  importBackupItem,
  readVoiceIssues,
  recordVoiceIssue,
  restoreSettingsBackup,
  SETTINGS_VERSION,
  type Settings,
  SettingsSchema,
  salvageSettings,
  salvageSettingsPatch,
  setSettings,
  setSettingsWithBackup,
  setSyncEnabled,
  syncEnabledItem,
  updateSettings,
  updateSettingsWith,
  type VoiceIssue,
  type VoiceIssues,
  voiceIssue,
  voiceIssuesItem,
  watchVoiceIssues,
  withVoiceIssue,
} from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";

const NEWER_VERSION = SETTINGS_VERSION + 1;

describe("salvageSettings", () => {
  it("keeps every valid field when one field is corrupt", () => {
    const salvaged = salvageSettings({
      ...DEFAULT_SETTINGS,
      perProvider: { polly: { credentials: { accessKeyId: "KEEP" } } },
      speed: "corrupt-not-a-number",
    });
    expect(salvaged.perProvider.polly?.credentials.accessKeyId).toBe("KEEP");
    expect(salvaged.speed).toBe(DEFAULT_SETTINGS.speed);
  });

  it("clears a verified flag whose credentials are incomplete instead of storing the contradiction", () => {
    const salvaged = salvageSettings({
      ...DEFAULT_SETTINGS,
      perProvider: {
        polly: { credentials: { accessKeyId: "only-one-field" }, verified: true, enabled: true },
        openai: { credentials: { apiKey: "sk-x" }, verified: true, enabled: true },
      },
    });
    expect(salvaged.perProvider).toEqual({
      polly: { credentials: { accessKeyId: "only-one-field" }, verified: false, enabled: true },
      openai: { credentials: { apiKey: "sk-x" }, verified: true, enabled: true },
    });
  });

  it.each([
    ["a format choice", { downloadEncoding: 42 }, {}],
    ["the last engine", { lastModel: ["neural"] }, {}],
    ["a flag", { verified: "yes", enabled: 1 }, { verified: false, enabled: false }],
  ])("keeps a provider's keys when %s in its entry is corrupt", (_case, corrupt, expected) => {
    const keys = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };
    const salvaged = salvageSettings({
      ...DEFAULT_SETTINGS,
      perProvider: { polly: { credentials: keys, verified: true, enabled: true, ...corrupt } },
    });
    expect(salvaged.perProvider.polly).toEqual({
      credentials: keys,
      verified: true,
      enabled: true,
      ...expected,
    });
  });

  it.each([
    ["corrupt", { credentials: { accessKeyId: 42 }, verified: true, enabled: true }],
    ["missing", { verified: true, enabled: true }],
  ])("drops a provider entry whose credentials are %s, keeping its siblings", (_case, entry) => {
    const salvaged = salvageSettings({
      ...DEFAULT_SETTINGS,
      perProvider: {
        polly: entry,
        openai: { credentials: { apiKey: "sk-x" }, verified: true, enabled: true },
      },
    });
    expect(salvaged.perProvider).toEqual({
      openai: { credentials: { apiKey: "sk-x" }, verified: true, enabled: true },
    });
  });
});

describe("salvageSettingsPatch", () => {
  it("patches only keys present in the raw object", () => {
    const { patch, dropped } = salvageSettingsPatch({ speed: 2 });
    expect(patch).toEqual({ speed: 2 });
    expect(dropped).toEqual([]);
  });

  it("reports present-but-unusable keys as dropped", () => {
    const { patch, dropped } = salvageSettingsPatch({ speed: "corrupt", pitch: 5 });
    expect(patch).toEqual({ pitch: 5 });
    expect(dropped).toEqual(["speed"]);
  });

  it("rescues valid provider entries around a corrupt one and flags the lossy key", () => {
    const { patch, dropped } = salvageSettingsPatch({
      perProvider: { polly: { credentials: { accessKeyId: "KEEP" } }, azure: 42 },
    });
    expect(patch.perProvider).toEqual({
      polly: { credentials: { accessKeyId: "KEEP" }, verified: false, enabled: false },
    });
    expect(dropped).toEqual(["perProvider"]);
  });

  it("drops a record key with nothing usable, without patching it", () => {
    const { patch, dropped } = salvageSettingsPatch({ perProvider: { polly: 42 } });
    expect("perProvider" in patch).toBe(false);
    expect(dropped).toEqual(["perProvider"]);
  });

  it("reports nothing dropped for fully valid input, minus the version stamp", () => {
    const { schemaVersion: _version, ...fields } = DEFAULT_SETTINGS;
    const { patch, dropped } = salvageSettingsPatch(DEFAULT_SETTINGS);
    expect(patch).toEqual(fields);
    expect(dropped).toEqual([]);
  });

  it("returns empty results for non-object input", () => {
    expect(salvageSettingsPatch(null)).toEqual({ patch: {}, dropped: [] });
    expect(salvageSettingsPatch("garbage")).toEqual({ patch: {}, dropped: [] });
  });
});

describe("import backup", () => {
  beforeEach(() => fakeBrowser.reset());

  const now = new Date("2026-08-05T12:00:00.000Z");

  it("snapshots the pre-write settings and writes the computed ones", async () => {
    const before = SettingsSchema.parse({ speed: 2 });
    await setSettings(before);

    const next = await setSettingsWithBackup(
      (current) => SettingsSchema.parse({ ...current, pitch: 5 }),
      now,
    );
    expect(next.pitch).toBe(5);
    expect((await getSettings()).pitch).toBe(5);
    expect(await importBackupItem.getValue()).toEqual({
      savedAt: now.toISOString(),
      settings: before,
    });
  });

  it("works against the local area when sync is disabled", async () => {
    await setSyncEnabled(false);
    await setSettings(SettingsSchema.parse({ speed: 2 }));

    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);
    expect((await getSettings()).speed).toBe(3);
    expect((await importBackupItem.getValue())?.settings.speed).toBe(2);
  });

  it("restores the snapshot into the active area and clears the slot", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => DEFAULT_SETTINGS, now);

    const restored = await restoreSettingsBackup();
    expect(restored?.speed).toBe(2);
    expect((await getSettings()).speed).toBe(2);
    expect(await importBackupItem.getValue()).toBeNull();
  });

  it("discard clears the slot without touching the settings", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);

    await discardSettingsBackup();
    expect(await importBackupItem.getValue()).toBeNull();
    expect((await getSettings()).speed).toBe(3);
  });

  it("returns null and writes nothing when the slot is empty", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    expect(await restoreSettingsBackup()).toBeNull();
    expect((await getSettings()).speed).toBe(2);
  });

  it("keeps the previous snapshot when the computed settings do not validate", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);
    const slotBefore = await importBackupItem.getValue();

    await expect(
      setSettingsWithBackup(() => ({ speed: "corrupt" }) as unknown as Settings, now),
    ).rejects.toThrow();
    expect(await importBackupItem.getValue()).toEqual(slotBefore);
    expect((await getSettings()).speed).toBe(3);
  });

  it("puts the previous snapshot back when the settings write itself rejects", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);
    const slotBefore = await importBackupItem.getValue();

    // The settings object is in `sync` (default); the backup slot is in
    // `local`, so rejecting one sync write fails exactly the settings write
    // while the snapshot/rollback writes still succeed.
    const spy = vi
      .spyOn(fakeBrowser.storage.sync, "set")
      .mockRejectedValueOnce(new Error("QUOTA_BYTES_PER_ITEM quota exceeded"));
    try {
      await expect(
        setSettingsWithBackup(() => SettingsSchema.parse({ speed: 4 }), now),
      ).rejects.toThrow("QUOTA_BYTES_PER_ITEM");
    } finally {
      spy.mockRestore();
    }

    expect(await importBackupItem.getValue()).toEqual(slotBefore);
    expect((await getSettings()).speed).toBe(3);
  });

  it("refuses a snapshot from a newer build and keeps the slot", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    const newer = { ...DEFAULT_SETTINGS, schemaVersion: NEWER_VERSION, speed: 3, laterField: "x" };
    await importBackupItem.setValue({
      savedAt: now.toISOString(),
      settings: newer as unknown as Settings,
    });

    await expect(restoreSettingsBackup()).rejects.toBeInstanceOf(SettingsNewerError);
    expect((await importBackupItem.getValue())?.settings).toEqual(newer);
    expect((await getSettings()).speed).toBe(2);
  });

  // A restore salvages the snapshot field by field; inside a provider entry
  // and a selection, only the advisory parts may be lost, never the keys or
  // the voice.
  it.each([
    [
      "an unknown key in a provider entry (a later build's field)",
      { perProvider: { polly: { credentials: { accessKeyId: "a" }, note: "copied" } } },
      {
        perProvider: {
          polly: { credentials: { accessKeyId: "a" }, verified: false, enabled: false },
        },
      },
    ],
    [
      "a corrupt style on the selection",
      { selection: { providerId: "polly", voiceId: "Joanna", model: "neural", style: 42 } },
      { selection: { providerId: "polly", voiceId: "Joanna", model: "neural" } },
    ],
  ])("restores a snapshot with %s, keeping what is valid", async (_case, snapshot, expected) => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await importBackupItem.setValue({
      savedAt: now.toISOString(),
      settings: { ...DEFAULT_SETTINGS, ...snapshot } as unknown as Settings,
    });

    const restored = await restoreSettingsBackup();
    expect(restored).toEqual({ ...DEFAULT_SETTINGS, ...expected });
    expect(await getSettings()).toEqual(restored);
    expect(await importBackupItem.getValue()).toBeNull();
  });

  it("clears a corrupt slot instead of restoring defaults over real settings", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await importBackupItem.setValue({
      savedAt: now.toISOString(),
      settings: "garbage" as unknown as Settings,
    });

    expect(await restoreSettingsBackup()).toBeNull();
    expect(await importBackupItem.getValue()).toBeNull();
    expect((await getSettings()).speed).toBe(2);
  });
});

describe("write serialization", () => {
  beforeEach(() => fakeBrowser.reset());

  it("concurrent updates never clobber each other's fields", async () => {
    await setSettings(DEFAULT_SETTINGS);
    await Promise.all([
      updateSettings({ speed: 2 }),
      updateSettings({ pitch: 5 }),
      updateSettingsWith((c) =>
        withProviderPrefs(c, "polly", { credentials: { accessKeyId: "a" } }),
      ),
    ]);
    const settings = await getSettings();
    expect(settings.speed).toBe(2);
    expect(settings.pitch).toBe(5);
    expect(settings.perProvider.polly?.credentials.accessKeyId).toBe("a");
  });
});

/** A described failure with `message` as its one distinguishing field. */
function issue(message: string): VoiceIssue {
  return { title: "Could not read aloud", message, detail: `Error: ${message}` };
}

describe("withVoiceIssue", () => {
  const joannaNeural = { providerId: "polly", voiceId: "Joanna", model: "neural" } as const;
  const joannaStandard = { ...joannaNeural, model: "standard" } as const;

  it("adds, replaces and removes one leaf, pruning empty branches", () => {
    const one = withVoiceIssue({}, joannaNeural, issue("e1"));
    expect(one).toEqual({ polly: { Joanna: { neural: issue("e1") } } });
    const two = withVoiceIssue(one, joannaStandard, issue("e2"));
    expect(two).toEqual({ polly: { Joanna: { neural: issue("e1"), standard: issue("e2") } } });
    expect(withVoiceIssue(two, joannaNeural, issue("e3"))).toEqual({
      polly: { Joanna: { neural: issue("e3"), standard: issue("e2") } },
    });
    expect(withVoiceIssue(two, joannaNeural, null)).toEqual({
      polly: { Joanna: { standard: issue("e2") } },
    });
    expect(withVoiceIssue(one, joannaNeural, null)).toEqual({});
  });

  it("returns the same object when nothing changes, so no write is queued", () => {
    const one = withVoiceIssue({}, joannaNeural, issue("e1"));
    // The same description again (a scan re-flagging a family), field by field.
    expect(withVoiceIssue(one, joannaNeural, { ...issue("e1") })).toBe(one);
    expect(withVoiceIssue(one, joannaStandard, null)).toBe(one);
    expect(withVoiceIssue({}, joannaNeural, null)).toEqual({});
    // A detail or an action that differs is a change.
    expect(withVoiceIssue(one, joannaNeural, { ...issue("e1"), detail: "d" })).not.toBe(one);
    const linked = { ...issue("e1"), action: { label: "Fix", url: "https://a" } };
    const withLink = withVoiceIssue({}, joannaNeural, linked);
    expect(withVoiceIssue(withLink, joannaNeural, { ...linked })).toBe(withLink);
    expect(
      withVoiceIssue(withLink, joannaNeural, {
        ...linked,
        action: { label: "Fix", url: "https://b" },
      }),
    ).not.toBe(withLink);
  });

  it.each([["constructor"], ["toString"], ["__proto__"], ["hasOwnProperty"]])(
    "treats a voice or model named %s as an ordinary key, never as an inherited member",
    (name) => {
      const asModel = { providerId: "custom", voiceId: "alloy", model: name } as const;
      const asVoice = { providerId: "custom", voiceId: name, model: "tts-1" } as const;
      const other = withVoiceIssue(
        {},
        { providerId: "custom", voiceId: "alloy", model: "tts-1" },
        issue("e0"),
      );
      expect(voiceIssue(other, asModel)).toBeUndefined();
      expect(voiceIssue(other, asVoice)).toBeUndefined();
      expect(withVoiceIssue(other, asModel, null)).toBe(other);

      const marked = withVoiceIssue(
        withVoiceIssue(other, asModel, issue("e1")),
        asVoice,
        issue("e2"),
      );
      expect(voiceIssue(marked, asModel)).toEqual(issue("e1"));
      expect(voiceIssue(marked, asVoice)).toEqual(issue("e2"));
      expect(withVoiceIssue(withVoiceIssue(marked, asModel, null), asVoice, null)).toEqual(other);
    },
  );
});

describe("voice issue cache", () => {
  const joannaNeural = { providerId: "polly", voiceId: "Joanna", model: "neural" } as const;
  const described: VoiceIssue = {
    title: "Could not read aloud",
    message: "This voice needs the Agent Platform API switched on.",
    detail: "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403 (disabled)",
    action: { label: "Fix it on the Google Cloud TTS website", url: "https://console.example" },
  };

  beforeEach(() => fakeBrowser.reset());

  it("round-trips a described failure and clears it, and watchers read the decoded cache", async () => {
    const seen: VoiceIssues[] = [];
    const unwatch = watchVoiceIssues((issues) => seen.push(issues));

    await recordVoiceIssue(joannaNeural, described);
    expect(await readVoiceIssues()).toEqual({ polly: { Joanna: { neural: described } } });
    expect(voiceIssue(await readVoiceIssues(), joannaNeural)).toEqual(described);

    await clearVoiceIssue(joannaNeural);
    expect(await readVoiceIssues()).toEqual({});
    expect(seen).toEqual([{ polly: { Joanna: { neural: described } } }, {}]);
    unwatch();
  });

  it("reads a leaf that is not a described failure as no issue and prunes what it leaves empty", async () => {
    await fakeBrowser.storage.local.set({
      voiceIssues: {
        polly: {
          // A build that kept the provider's error text as the leaf.
          Joanna: {
            neural: "ProviderHttpError: Amazon Polly synthesis failed: HTTP 403",
            standard: described,
          },
          Matthew: { neural: "Error: Provider says no" },
        },
        azure: "junk",
        google: {
          Kore: 5,
          Puck: { neural2: { title: "no message" } },
          // A build that described failures without a detail.
          Charon: { neural2: { title: "Could not read aloud", message: "no detail" } },
        },
      },
    });

    expect(await readVoiceIssues()).toEqual({ polly: { Joanna: { standard: described } } });
    expect(decodeVoiceIssues(null)).toEqual({});
    expect(decodeVoiceIssues(["not", "a", "record"])).toEqual({});
  });

  it("a write over such a cache stores only what reads back", async () => {
    await fakeBrowser.storage.local.set({
      voiceIssues: { polly: { Joanna: { neural: "Error: text leaf" } } },
    });
    const matthewNeural = { ...joannaNeural, voiceId: "Matthew" };

    await recordVoiceIssue(matthewNeural, described);

    expect(await voiceIssuesItem.getValue()).toEqual({ polly: { Matthew: { neural: described } } });
  });

  it("decodes a voice named __proto__ as an own property", () => {
    const raw: unknown = JSON.parse(
      `{"polly":{"__proto__":{"neural":${JSON.stringify(described)}}}}`,
    );
    const decoded = decodeVoiceIssues(raw);
    expect(Object.getPrototypeOf(decoded.polly)).toBe(Object.prototype);
    expect(voiceIssue(decoded, { ...joannaNeural, voiceId: "__proto__" })).toEqual(described);
  });
});

describe("sync toggle", () => {
  beforeEach(() => fakeBrowser.reset());

  it("refuses to overwrite a synced copy a newer build wrote, unless adopting it", async () => {
    await setSyncEnabled(false);
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    const newer = { ...DEFAULT_SETTINGS, schemaVersion: NEWER_VERSION, speed: 3, laterField: "x" };
    await fakeBrowser.storage.sync.set({ settings: newer });

    await expect(setSyncEnabled(true)).rejects.toBeInstanceOf(SettingsNewerError);
    expect(await syncEnabledItem.getValue()).toBe(false);
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);
    expect((await getSettings()).speed).toBe(2);

    // Adopting the synced copy is lossless: the newer blob stays byte-for-byte.
    await setSyncEnabled(true, { adoptRemote: true });
    expect(await syncEnabledItem.getValue()).toBe(true);
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);
    expect((await fakeBrowser.storage.local.get("settings")).settings).toBeUndefined();
    expect((await getSettings()).speed).toBe(3);
  });

  it("moves settings between areas without a destructive gap", async () => {
    const custom = SettingsSchema.parse({ speed: 2.5 });
    await setSettings(custom); // lands in sync (default on)

    await setSyncEnabled(false);
    expect(await syncEnabledItem.getValue()).toBe(false);
    expect((await getSettings()).speed).toBe(2.5); // now read from local

    await setSyncEnabled(true);
    expect((await getSettings()).speed).toBe(2.5); // back in sync
  });
});
