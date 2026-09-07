import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { DEFAULT_SETTINGS, getSettings, type Settings, setSettings } from "@/lib/storage";
import { SettingsNewerError, upgradeSettingsBlob } from "@/migrations";
import { importHandoff } from "@/migrations/handoff";
import { createExternalMessageHandler } from "@/migrations/handoff/external";
import { handoffBannerItem, handoffImportsItem } from "@/migrations/handoff/state";

const UNIFIED = "unified-extension-id";
const LEGACY_A = "legacy-polly-id";
const LEGACY_B = "legacy-azure-id";

const pollyConfigured: Settings = {
  ...DEFAULT_SETTINGS,
  credentials: { polly: { accessKeyId: "AKIA", secretAccessKey: "shh" } },
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

    it("answers nobody while the unified id is unset", () => {
      const handler = createExternalMessageHandler("");
      const sendResponse = vi.fn();
      expect(handler({ type: "exportSettings" }, { id: "" }, sendResponse)).toBe(undefined);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("flips the banner to imported (and un-dismisses it) before acknowledging", async () => {
      await handoffBannerItem.setValue({ dismissedAt: 123, imported: false });
      const handler = createExternalMessageHandler(UNIFIED);
      const sendResponse = vi.fn();

      expect(handler({ type: "settingsImported" }, { id: UNIFIED }, sendResponse)).toBe(true);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      });
      // The ack arrives only after persistence; the dismissal resets so the
      // "settings transferred" confirmation still gets shown once.
      expect(await handoffBannerItem.getValue()).toEqual({ imported: true, dismissedAt: null });
    });
  });

  describe("unified-side import", () => {
    beforeEach(() => {
      fakeBrowser.runtime.id = UNIFIED;
    });

    function stubLegacyResponses(byId: Record<string, unknown>) {
      return vi
        .spyOn(fakeBrowser.runtime, "sendMessage")
        .mockImplementation((...args: unknown[]) => {
          const [extensionId, message] = args as [string, { type?: string }];
          if (message?.type === "exportSettings" && extensionId in byId) {
            return Promise.resolve({ ok: true, settings: byId[extensionId] });
          }
          if (message?.type === "settingsImported") return Promise.resolve({ ok: true });
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
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"] },
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
        [LEGACY_B]: { importedAt: ISO, providers: [] },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_B]);
    });

    it("a fresh install takes the snapshot whole, selection and preferences included", async () => {
      const sendMessage = stubLegacyResponses({ [LEGACY_B]: azureConfigured });

      await importHandoff(UNIFIED, [LEGACY_A, LEGACY_B]);

      expect(await getSettings()).toEqual(azureConfigured);
      // Only the answering fork is recorded; the absent one is asked again.
      expect(await handoffImportsItem.getValue()).toEqual({
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"] },
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
        [LEGACY_A]: { importedAt: ISO, providers: ["polly"] },
        [LEGACY_B]: { importedAt: ISO, providers: ["azure"] },
      });
      expect(messagesTo(sendMessage, "settingsImported")).toEqual([LEGACY_A, LEGACY_B]);
    });

    it.each([
      ["does not answer", undefined],
      ["has nothing configured", DEFAULT_SETTINGS],
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
        [LEGACY_A]: { importedAt: ISO, providers: ["polly"] },
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
