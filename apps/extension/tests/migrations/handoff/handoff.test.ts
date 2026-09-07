import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { DEFAULT_SETTINGS, getSettings, type Settings, setSettings } from "@/lib/storage";
import { runStartupMigrations, SettingsNewerError, upgradeSettingsBlob } from "@/migrations";
import { importHandoff } from "@/migrations/handoff";
import { createExternalMessageHandler } from "@/migrations/handoff/external";
import { handoffBannerItem, handoffImportsItem } from "@/migrations/handoff/state";

const UNIFIED = "unified-extension-id";
const LEGACY_A = "legacy-polly-id";
const LEGACY_B = "legacy-azure-id";

const pollyConfigured: Settings = {
  ...DEFAULT_SETTINGS,
  credentials: { polly: { accessKeyId: "AKIA", secretAccessKey: "shh", region: "us-east-1" } },
  credentialsValid: { polly: true },
  enabledProviders: { polly: true },
  favorites: ["polly:Joanna"],
  selectedVoice: { providerId: "polly", voiceId: "Joanna" },
  theme: "dark",
};

const azureConfigured: Settings = {
  ...DEFAULT_SETTINGS,
  credentials: { azure: { subscriptionKey: "key", region: "eastus" } },
  credentialsValid: { azure: true },
  enabledProviders: { azure: true },
  favorites: ["azure:Jenny"],
  selectedVoice: { providerId: "azure", voiceId: "Jenny" },
  speed: 1.5,
};

const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

describe("settings handoff", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  describe("legacy-side export guard", () => {
    it("answers exportSettings only when the sender is the unified listing", async () => {
      await setSettings(pollyConfigured);
      const handler = createExternalMessageHandler(UNIFIED);
      const sendResponse = vi.fn();

      expect(handler({ type: "exportSettings" }, { id: "some-other-ext" }, sendResponse)).toBe(
        undefined,
      );
      expect(handler({ type: "exportSettings" }, {}, sendResponse)).toBe(undefined);
      expect(sendResponse).not.toHaveBeenCalled();

      expect(handler({ type: "exportSettings" }, { id: UNIFIED }, sendResponse)).toBe(true);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({ ok: true, settings: pollyConfigured });
      });
    });

    it("exports the blob as stored, so a newer build's version reaches the importer", async () => {
      const newer = { ...DEFAULT_SETTINGS, schemaVersion: 2, laterField: "x" };
      await fakeBrowser.storage.sync.set({ settings: newer });
      const handler = createExternalMessageHandler(UNIFIED);
      const sendResponse = vi.fn();

      handler({ type: "exportSettings" }, { id: UNIFIED }, sendResponse);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({ ok: true, settings: newer });
      });
      expect(() => upgradeSettingsBlob(sendResponse.mock.calls[0]?.[0].settings)).toThrow(
        SettingsNewerError,
      );
    });

    it("answers an export that arrives during the flat-key conversion only once the blob is written, so the same start imports", async () => {
      // A fork upgraded from the flat-key build: keys configured, no blob yet.
      await fakeBrowser.storage.sync.set({
        accessKeyId: "AKIA",
        secretAccessKey: "shh",
        region: "us-east-1",
        credentialsValid: true,
        voices: { "en-US": "Joanna" },
        language: "en-US",
      });
      const converted: Settings = {
        ...DEFAULT_SETTINGS,
        credentials: {
          polly: { accessKeyId: "AKIA", secretAccessKey: "shh", region: "us-east-1" },
        },
        credentialsValid: { polly: true },
        enabledProviders: { polly: true },
        selectedVoice: { providerId: "polly", voiceId: "Joanna" },
        voicesByLanguage: { "en-US": { providerId: "polly", voiceId: "Joanna" } },
      };
      // Hold the conversion inside the settings lock, right before its write.
      let releaseConversion = () => {};
      const conversionWrite = new Promise<void>((resolve) => {
        releaseConversion = resolve;
      });
      const originalSet = fakeBrowser.storage.sync.set.bind(fakeBrowser.storage.sync);
      const syncSet = vi
        .spyOn(fakeBrowser.storage.sync, "set")
        .mockImplementationOnce(async (items) => {
          await conversionWrite;
          await originalSet(items);
        });
      const conversion = runStartupMigrations();
      await vi.waitFor(() => expect(syncSet).toHaveBeenCalledOnce());

      // The conversion holds the settings lock now, so the next request for
      // it is the export's: that request, not elapsed time, is the signal
      // that the handler is queued behind the held conversion.
      let exportQueued = () => {};
      const exportLockRequested = new Promise<void>((resolve) => {
        exportQueued = resolve;
      });
      const originalRequest = navigator.locks.request.bind(navigator.locks);
      vi.spyOn(navigator.locks, "request").mockImplementation((...args) => {
        if (args[0] === "cloud-speech-settings-write") exportQueued();
        return originalRequest(...args);
      });

      // One fakeBrowser plays both installs: the fork's handler answers the
      // unified importer in-process, and once it has answered, its blob is
      // removed so the rest of the run is the unified install's fresh storage.
      fakeBrowser.runtime.id = UNIFIED;
      const handler = createExternalMessageHandler(UNIFIED);
      const exported = vi.fn();
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
        async (...args: unknown[]) => {
          const [, message] = args as [string, { type?: string }];
          if (message?.type !== "exportSettings") return { ok: true };
          const response = await new Promise((resolve) =>
            handler(message, { id: UNIFIED }, resolve),
          );
          exported(response);
          await fakeBrowser.storage.sync.remove("settings");
          return response;
        },
      );
      const importing = importHandoff(UNIFIED, [LEGACY_A]);
      // The lock queue outlives a failed assertion: always let the conversion
      // finish, or every later settings write in this file would stall.
      try {
        // A handler that reads outside the lock never requests it; the import
        // then completes first and the assertion below shows its answer.
        await Promise.race([exportLockRequested, importing]);
        expect(exported).not.toHaveBeenCalled();
        expect(await handoffImportsItem.getValue()).toEqual({});
      } finally {
        releaseConversion();
        await conversion;
      }
      await importing;

      expect(exported).toHaveBeenCalledExactlyOnceWith({ ok: true, settings: converted });
      expect(await getSettings()).toEqual(converted);
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_A]: { importedAt: ISO, providers: ["polly"], acknowledged: true },
      });
    });

    it("answers nobody while the unified id is unset", () => {
      const handler = createExternalMessageHandler("");
      const sendResponse = vi.fn();
      expect(handler({ type: "exportSettings" }, { id: "" }, sendResponse)).toBe(undefined);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it.each([
      {
        outcome: "flips the banner to imported and un-dismisses a snooze made before the transfer",
        before: { dismissedAt: 123, imported: false },
        after: { dismissedAt: null, imported: true },
      },
      {
        outcome: "repeated, keeps a dismissal made after the transfer",
        before: { dismissedAt: 456, imported: true },
        after: { dismissedAt: 456, imported: true },
      },
    ])("settingsImported $outcome, then acknowledges", async ({ before, after }) => {
      await handoffBannerItem.setValue(before);
      const handler = createExternalMessageHandler(UNIFIED);
      const sendResponse = vi.fn();

      expect(handler({ type: "settingsImported" }, { id: UNIFIED }, sendResponse)).toBe(true);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      });
      // The ack arrives only after persistence.
      expect(await handoffBannerItem.getValue()).toEqual(after);
    });
  });

  describe("unified-side import", () => {
    beforeEach(() => {
      fakeBrowser.runtime.id = UNIFIED;
    });

    const acknowledge = () => Promise.resolve({ ok: true });

    function stubLegacyResponses(byId: Record<string, unknown>, ack = () => acknowledge()) {
      return vi
        .spyOn(fakeBrowser.runtime, "sendMessage")
        .mockImplementation((...args: unknown[]) => {
          const [extensionId, message] = args as [string, { type?: string }];
          if (message?.type === "exportSettings" && extensionId in byId) {
            return Promise.resolve({ ok: true, settings: byId[extensionId] });
          }
          if (message?.type === "settingsImported") return ack();
          return Promise.reject(new Error("not installed"));
        });
    }

    function messagesTo(
      sendMessage: ReturnType<typeof stubLegacyResponses>,
      type: "exportSettings" | "settingsImported",
    ): string[] {
      return sendMessage.mock.calls
        .filter(([, message]) => (message as { type?: string })?.type === type)
        .map(([id]) => id as string);
    }

    it("adds the providers a configured install lacks, keeps its own, then never asks again", async () => {
      await setSettings(pollyConfigured);
      const sendMessage = stubLegacyResponses({ [LEGACY_B]: azureConfigured });

      await importHandoff(UNIFIED, [LEGACY_B]);

      // Azure arrives whole; Polly's keys, the selection and the UI prefs
      // stay this install's own; favorites are unioned.
      expect(await getSettings()).toEqual({
        ...pollyConfigured,
        credentials: { ...pollyConfigured.credentials, ...azureConfigured.credentials },
        credentialsValid: { polly: true, azure: true },
        enabledProviders: { polly: true, azure: true },
        favorites: ["polly:Joanna", "azure:Jenny"],
      });
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"], acknowledged: true },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_B]);

      // Recorded: the next start neither pings nor writes anything.
      sendMessage.mockClear();
      const syncSet = vi.spyOn(fakeBrowser.storage.sync, "set");
      const localSet = vi.spyOn(fakeBrowser.storage.local, "set");
      await importHandoff(UNIFIED, [LEGACY_B]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(syncSet).not.toHaveBeenCalled();
      expect(localSet).not.toHaveBeenCalled();
    });

    it("never overwrites a provider this install already has", async () => {
      const mine = {
        ...pollyConfigured,
        credentials: {
          ...pollyConfigured.credentials,
          azure: { subscriptionKey: "mine", region: "westus" },
        },
        credentialsValid: { polly: true, azure: false },
        enabledProviders: { polly: true, azure: false },
      };
      await setSettings(mine);
      const sendMessage = stubLegacyResponses({ [LEGACY_B]: azureConfigured });

      await importHandoff(UNIFIED, [LEGACY_B]);

      expect(await getSettings()).toEqual({ ...mine, favorites: ["polly:Joanna", "azure:Jenny"] });
      // Nothing to add is still a completed handoff: recorded and confirmed.
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_B]: { importedAt: ISO, providers: [], acknowledged: true },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_B]);
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("receiving end does not exist"))],
      ["answers ok: false to", () => Promise.resolve({ ok: false })],
    ])(
      "keeps the import when the fork %s settingsImported, and tells it again each start until it acknowledges",
      async (_, failedAck) => {
        let ack = failedAck;
        const sendMessage = stubLegacyResponses({ [LEGACY_A]: pollyConfigured }, () => ack());

        await importHandoff(UNIFIED, [LEGACY_A]);

        // The data is in; only the fork's confirmation is outstanding.
        expect(await getSettings()).toEqual(pollyConfigured);
        expect(await handoffImportsItem.getValue()).toEqual({
          [LEGACY_A]: { importedAt: ISO, providers: ["polly"], acknowledged: false },
        });
        expect(messagesTo(sendMessage, "exportSettings")).toEqual([LEGACY_A]);
        expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_A]);

        // Next start: re-sent, never re-imported; the record stays put.
        sendMessage.mockClear();
        await importHandoff(UNIFIED, [LEGACY_A]);
        expect(messagesTo(sendMessage, "exportSettings")).toEqual([]);
        expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_A]);
        expect(await getSettings()).toEqual(pollyConfigured);
        expect(await handoffImportsItem.getValue()).toEqual({
          [LEGACY_A]: { importedAt: ISO, providers: ["polly"], acknowledged: false },
        });

        // The fork comes back: acknowledged, and afterwards left alone.
        ack = acknowledge;
        sendMessage.mockClear();
        await importHandoff(UNIFIED, [LEGACY_A]);
        expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_A]);
        expect(await handoffImportsItem.getValue()).toEqual({
          [LEGACY_A]: { importedAt: ISO, providers: ["polly"], acknowledged: true },
        });
        sendMessage.mockClear();
        await importHandoff(UNIFIED, [LEGACY_A]);
        expect(sendMessage).not.toHaveBeenCalled();
      },
    );

    it("a fresh install takes the snapshot whole, selection and preferences included", async () => {
      const sendMessage = stubLegacyResponses({ [LEGACY_B]: azureConfigured });

      await importHandoff(UNIFIED, [LEGACY_A, LEGACY_B]);

      expect(await getSettings()).toEqual(azureConfigured);
      // Only the answering fork is recorded; the absent one is asked again.
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"], acknowledged: true },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_B]);
    });

    it("with both forks configured, the first sets the base and the second adds its provider", async () => {
      const sendMessage = stubLegacyResponses({
        [LEGACY_A]: pollyConfigured,
        [LEGACY_B]: azureConfigured,
      });

      await importHandoff(UNIFIED, [LEGACY_A, LEGACY_B]);

      expect(await getSettings()).toEqual({
        ...pollyConfigured,
        credentials: { ...pollyConfigured.credentials, ...azureConfigured.credentials },
        credentialsValid: { polly: true, azure: true },
        enabledProviders: { polly: true, azure: true },
        favorites: ["polly:Joanna", "azure:Jenny"],
      });
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_A]: { importedAt: ISO, providers: ["polly"], acknowledged: true },
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"], acknowledged: true },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_A, LEGACY_B]);
    });

    describe("on an upgraded fork install whose keys were never entered", () => {
      // What the flat-key conversion makes of the keys the Polly listing
      // wrote at install time: an empty credential record, not an absent one.
      const pollyPlaceholder = { accessKeyId: "", secretAccessKey: "", region: "us-east-1" };

      beforeEach(async () => {
        await fakeBrowser.storage.sync.set({
          accessKeyId: "",
          secretAccessKey: "",
          region: "us-east-1",
          language: "en-US",
          speed: 1,
          pitch: 0,
        });
        await runStartupMigrations();
        expect(await getSettings()).toEqual({
          ...DEFAULT_SETTINGS,
          credentials: { polly: pollyPlaceholder },
          credentialsValid: { polly: false },
          enabledProviders: { polly: false },
        });
      });

      it.each([
        {
          outcome: "takes the real keys for that same provider from the fork that has them",
          forkId: LEGACY_A,
          snapshot: pollyConfigured,
          expected: pollyConfigured,
          providers: ["polly"],
        },
        {
          outcome:
            "is a fresh install for another provider's fork: its selection and preferences come along",
          forkId: LEGACY_B,
          snapshot: azureConfigured,
          expected: {
            ...azureConfigured,
            credentials: { polly: pollyPlaceholder, ...azureConfigured.credentials },
            credentialsValid: { polly: false, azure: true },
            enabledProviders: { polly: false, azure: true },
          },
          providers: ["azure"],
        },
      ])("$outcome", async ({ forkId, snapshot, expected, providers }) => {
        const sendMessage = stubLegacyResponses({ [forkId]: snapshot });

        await importHandoff(UNIFIED, [forkId]);

        expect(await getSettings()).toEqual(expected);
        expect(await handoffImportsItem.getValue()).toEqual({
          [forkId]: { importedAt: ISO, providers, acknowledged: true },
        });
        expect(messagesTo(sendMessage, "settingsImported")).toEqual([forkId]);
      });
    });

    it.each([
      ["does not answer", undefined],
      ["has nothing configured", DEFAULT_SETTINGS],
      [
        "never had its keys entered",
        { ...DEFAULT_SETTINGS, credentials: { azure: { subscriptionKey: "", region: "eastus" } } },
      ],
      ["runs a newer build", { ...azureConfigured, schemaVersion: 2, laterField: "x" }],
    ])("asks again next start when the fork %s", async (_, snapshot) => {
      const sendMessage = stubLegacyResponses(
        snapshot === undefined ? {} : { [LEGACY_B]: snapshot },
      );

      await importHandoff(UNIFIED, [LEGACY_B]);
      await importHandoff(UNIFIED, [LEGACY_B]);

      expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
      expect(await handoffImportsItem.getValue()).toEqual({});
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([]);
      expect(messagesTo(sendMessage, "exportSettings")).toEqual([LEGACY_B, LEGACY_B]);
    });

    it("with two forks, one on a newer build, imports the readable one and keeps asking the other", async () => {
      const sendMessage = stubLegacyResponses({
        [LEGACY_A]: { ...pollyConfigured, schemaVersion: 2, laterField: "x" },
        [LEGACY_B]: azureConfigured,
      });

      await importHandoff(UNIFIED, [LEGACY_A, LEGACY_B]);
      await importHandoff(UNIFIED, [LEGACY_A, LEGACY_B]);

      expect(await getSettings()).toEqual(azureConfigured);
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"], acknowledged: true },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_B]);
      expect(messagesTo(sendMessage, "exportSettings")).toEqual([LEGACY_A, LEGACY_B, LEGACY_A]);
    });

    it("skips a fork, unrecorded, while this install's own blob is from a newer build", async () => {
      const newer = { ...DEFAULT_SETTINGS, schemaVersion: 2, laterField: "x" };
      await fakeBrowser.storage.sync.set({ settings: newer });
      const sendMessage = stubLegacyResponses({ [LEGACY_B]: azureConfigured });

      await importHandoff(UNIFIED, [LEGACY_B]);

      expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);
      expect(await handoffImportsItem.getValue()).toEqual({});
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([]);
    });

    it("keeps a save that lands during the export round-trip and adds the snapshot to it", async () => {
      const typed = { ...DEFAULT_SETTINGS, credentials: { openai: { apiKey: "typed-by-user" } } };
      const sendMessage = vi
        .spyOn(fakeBrowser.runtime, "sendMessage")
        .mockImplementation(async (...args: unknown[]) => {
          const [, message] = args as [string, { type?: string }];
          if (message?.type === "exportSettings") {
            await setSettings(typed);
            return { ok: true, settings: pollyConfigured };
          }
          return { ok: true };
        });

      await importHandoff(UNIFIED, [LEGACY_A]);

      // Not fresh any more: the user's key stays, and only Polly is added.
      expect(await getSettings()).toEqual({
        ...typed,
        credentials: { ...typed.credentials, ...pollyConfigured.credentials },
        credentialsValid: { polly: true },
        enabledProviders: { polly: true },
        favorites: ["polly:Joanna"],
      });
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_A]: { importedAt: ISO, providers: ["polly"], acknowledged: true },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_A]);
    });

    it("does nothing when not running under the unified id", async () => {
      fakeBrowser.runtime.id = "someone-else";
      const sendMessage = vi.spyOn(fakeBrowser.runtime, "sendMessage");
      await importHandoff(UNIFIED, [LEGACY_A]);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
