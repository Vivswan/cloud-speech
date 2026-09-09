import {
  AZURE_ID,
  chromeListing,
  chromeStoreUrl,
  firefoxListing,
  LEGACY_IDS,
  POLLY_ID,
  UNIFIED_ID,
} from "@cloud-speech/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { installedStoreUrl, isUnifiedInstall, unifiedStoreUrl } from "@/lib/listing";
import { isLegacyInstall } from "@/migrations/handoff/listing";

// The Polly listing was renamed in place into the unified "Cloud Speech"
// listing, so its id plays both roles: install target for new users and the
// one Chrome id that must NOT be treated as legacy (a legacy install nags
// its user to move and exports its settings to the unified id; the unified
// install must do neither to itself).
describe("store listings", () => {
  it("the Polly listing is the published unified listing and Azure the only legacy one", () => {
    expect(chromeListing).toEqual({
      status: "published",
      id: POLLY_ID,
      url: "https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn",
      reviewUrl:
        "https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn/reviews",
    });
    expect(UNIFIED_ID).toBe(POLLY_ID);
    expect(LEGACY_IDS).toEqual([AZURE_ID]);
    expect(LEGACY_IDS).not.toContain(UNIFIED_ID);
  });

  describe("runtime role by browser.runtime.id", () => {
    beforeEach(() => {
      fakeBrowser.reset();
    });

    // On Firefox neither role applies: the Chrome ids never match a Firefox
    // install, and the helpers short-circuit before looking at runtime.id.
    const chrome = !import.meta.env.FIREFOX;
    it.each([
      {
        install: "the unified (Polly) listing",
        runtimeId: POLLY_ID,
        unified: chrome,
        legacy: false,
      },
      { install: "the legacy Azure listing", runtimeId: AZURE_ID, unified: false, legacy: chrome },
      {
        install: "an unpacked dev build",
        runtimeId: "unpacked-dev-build-id",
        unified: false,
        legacy: false,
      },
    ])("$install: unified=$unified, legacy=$legacy", ({ runtimeId, unified, legacy }) => {
      fakeBrowser.runtime.id = runtimeId;
      expect({
        unified: isUnifiedInstall(),
        legacy: isLegacyInstall(),
        storeUrl: unifiedStoreUrl(),
      }).toEqual({ unified, legacy, storeUrl: chromeStoreUrl(POLLY_ID) });
    });
  });
});

describe("installedStoreUrl", () => {
  it("links a store install to its own listing, an unpacked build to the unified one", () => {
    const unified = chromeListing.status === "published" ? chromeListing.url : null;
    const firefox = firefoxListing.status === "published" ? firefoxListing.url : null;

    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Cloud Speech",
      version: "2.0.0",
      update_url: "https://clients2.google.com/service/update2/crx",
    });
    Object.assign(fakeBrowser.runtime, { id: AZURE_ID });
    expect(installedStoreUrl()).toBe(import.meta.env.FIREFOX ? firefox : chromeStoreUrl(AZURE_ID));

    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Cloud Speech",
      version: "2.0.0",
    });
    expect(installedStoreUrl()).toBe(import.meta.env.FIREFOX ? firefox : unified);
  });
});
