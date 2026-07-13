import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createExternalMessageHandler, importLegacySettings } from "@/lib/migration-handoff";
import {
  DEFAULT_SETTINGS,
  getSettings,
  legacyImportDoneItem,
  migrationBannerItem,
  setSettings,
} from "@/lib/storage";

const UNIFIED = "unified-extension-id";
const LEGACY_A = "legacy-polly-id";
const LEGACY_B = "legacy-azure-id";

const pollyConfigured = {
  ...DEFAULT_SETTINGS,
  credentials: { polly: { accessKeyId: "AKIA", secretAccessKey: "shh" } },
  credentialsValid: { polly: true },
  enabledProviders: { polly: true },
  favorites: ["polly:Joanna"],
};

const azureConfigured = {
  ...DEFAULT_SETTINGS,
  credentials: { azure: { subscriptionKey: "key", region: "eastus" } },
  credentialsValid: { azure: true },
  enabledProviders: { azure: true },
  favorites: ["azure:Jenny"],
};

describe("migration-handoff", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  describe("legacy-side export guard", () => {
    it("answers exportSettings only when the sender is the unified listing", async () => {
      const handler = createExternalMessageHandler(UNIFIED);
      const sendResponse = vi.fn();

      expect(handler({ type: "exportSettings" }, { id: "some-other-ext" }, sendResponse)).toBe(
        undefined,
      );
      expect(handler({ type: "exportSettings" }, {}, sendResponse)).toBe(undefined);
      expect(sendResponse).not.toHaveBeenCalled();

      expect(handler({ type: "exportSettings" }, { id: UNIFIED }, sendResponse)).toBe(true);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith(
          expect.objectContaining({ ok: true, settings: expect.any(Object) }),
        );
      });
    });

    it("answers nobody while the unified id is unset", () => {
      const handler = createExternalMessageHandler("");
      const sendResponse = vi.fn();
      expect(handler({ type: "exportSettings" }, { id: "" }, sendResponse)).toBe(undefined);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("flips the banner to imported (and un-dismisses it) before acknowledging", async () => {
      await migrationBannerItem.setValue({ dismissedAt: 123, imported: false });
      const handler = createExternalMessageHandler(UNIFIED);
      const sendResponse = vi.fn();

      expect(handler({ type: "settingsImported" }, { id: UNIFIED }, sendResponse)).toBe(true);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      });
      // The ack arrives only after persistence; the dismissal resets so the
      // "settings transferred" confirmation still gets shown once.
      expect(await migrationBannerItem.getValue()).toEqual({ imported: true, dismissedAt: null });
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

    it("imports legacy settings exactly once and confirms to the legacy install", async () => {
      const sendMessage = stubLegacyResponses({ [LEGACY_A]: pollyConfigured });

      expect(await importLegacySettings(UNIFIED, [LEGACY_A, LEGACY_B])).toBe(true);
      expect((await getSettings()).credentials.polly?.accessKeyId).toBe("AKIA");
      expect(await legacyImportDoneItem.getValue()).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(LEGACY_A, { type: "settingsImported" });
      // Only the CONTRIBUTING install gets the transferred confirmation.
      expect(sendMessage).not.toHaveBeenCalledWith(LEGACY_B, { type: "settingsImported" });

      // Import-once: a second run never pings again.
      sendMessage.mockClear();
      expect(await importLegacySettings(UNIFIED, [LEGACY_A, LEGACY_B])).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("merges credentials and favorites when BOTH legacy installs are configured", async () => {
      stubLegacyResponses({ [LEGACY_A]: pollyConfigured, [LEGACY_B]: azureConfigured });

      expect(await importLegacySettings(UNIFIED, [LEGACY_A, LEGACY_B])).toBe(true);
      const settings = await getSettings();
      expect(settings.credentials.polly?.accessKeyId).toBe("AKIA");
      expect(settings.credentials.azure?.subscriptionKey).toBe("key");
      expect(settings.enabledProviders).toMatchObject({ polly: true, azure: true });
      expect(settings.favorites).toEqual(["polly:Joanna", "azure:Jenny"]);
    });

    it("never overwrites an already-configured install", async () => {
      await setSettings({
        ...DEFAULT_SETTINGS,
        credentials: { google: { apiKey: "existing" } },
      });
      const sendMessage = vi.spyOn(fakeBrowser.runtime, "sendMessage");

      expect(await importLegacySettings(UNIFIED, [LEGACY_A])).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      expect((await getSettings()).credentials.google?.apiKey).toBe("existing");
      // Marked done: a hand-configured install is never asked again.
      expect(await legacyImportDoneItem.getValue()).toBe(true);
    });

    it("a save landing during the export round-trip wins over the import", async () => {
      // The legacy response is delayed; the user configures the install in
      // the gap. The locked re-check must keep the user's settings.
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
        async (...args: unknown[]) => {
          const [, message] = args as [string, { type?: string }];
          if (message?.type === "exportSettings") {
            await setSettings({
              ...DEFAULT_SETTINGS,
              credentials: { openai: { apiKey: "typed-by-user" } },
            });
            return { ok: true, settings: pollyConfigured };
          }
          return { ok: true };
        },
      );

      expect(await importLegacySettings(UNIFIED, [LEGACY_A])).toBe(false);
      const settings = await getSettings();
      expect(settings.credentials.openai?.apiKey).toBe("typed-by-user");
      expect(settings.credentials.polly).toBeUndefined();
      expect(await legacyImportDoneItem.getValue()).toBe(true);
    });

    it("does nothing when not running under the unified id", async () => {
      fakeBrowser.runtime.id = "someone-else";
      const sendMessage = vi.spyOn(fakeBrowser.runtime, "sendMessage");
      expect(await importLegacySettings(UNIFIED, [LEGACY_A])).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("skips unconfigured legacy installs and stays retryable", async () => {
      stubLegacyResponses({ [LEGACY_A]: DEFAULT_SETTINGS }); // nothing configured

      expect(await importLegacySettings(UNIFIED, [LEGACY_A, LEGACY_B])).toBe(false);
      // NOT marked done: a later run may find a configured install.
      expect(await legacyImportDoneItem.getValue()).toBe(false);
    });
  });
});
