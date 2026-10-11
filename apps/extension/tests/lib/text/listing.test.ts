import { chromeListing, chromeStoreUrl, firefoxListing } from "@cloud-speech/constants";
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { installedStoreUrl } from "@/lib/text/listing";

describe("installedStoreUrl", () => {
  it("links a store install to its own listing, an unpacked build to the published one", () => {
    const published = chromeListing.status === "published" ? chromeListing.url : null;
    const firefox = firefoxListing.status === "published" ? firefoxListing.url : null;
    const sideloadedId = "sideloaded-store-install-id";

    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Cloud Speech",
      version: "2.0.0",
      update_url: "https://clients2.google.com/service/update2/crx",
    });
    Object.assign(fakeBrowser.runtime, { id: sideloadedId });
    expect(installedStoreUrl()).toBe(
      import.meta.env.FIREFOX ? firefox : chromeStoreUrl(sideloadedId),
    );

    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Cloud Speech",
      version: "2.0.0",
    });
    expect(installedStoreUrl()).toBe(import.meta.env.FIREFOX ? firefox : published);
  });
});
