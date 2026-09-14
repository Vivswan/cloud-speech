import {
  CHROME_LISTING_ID,
  chromeListing,
  chromeStoreUrl,
  firefoxListing,
} from "@cloud-speech/constants";
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { installedStoreUrl } from "@/lib/listing";

// The Polly listing was renamed in place into the "Cloud Speech" listing, so its id is the install target.
describe("store listings", () => {
  it("the Polly listing is the published Chrome listing", () => {
    expect(chromeListing).toEqual({
      status: "published",
      id: CHROME_LISTING_ID,
      url: "https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn",
      reviewUrl:
        "https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn/reviews",
    });
  });
});

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
