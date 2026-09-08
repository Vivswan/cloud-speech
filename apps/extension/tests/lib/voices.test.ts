import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { SettingsSchema, setSettings, voicesSessionItem } from "@/lib/storage";
import { fetchAllVoices } from "@/lib/voices";
import { azure } from "@/providers/azure";
import { polly } from "@/providers/polly";
import type { NormalizedVoice } from "@/providers/types";
import { sdkError } from "../helpers/sdk-error";

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const jenny: NormalizedVoice = {
  id: "en-US-JennyNeural",
  providerId: "azure",
  displayName: "Jenny",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

function bothProvidersConfigured() {
  return SettingsSchema.parse({
    perProvider: {
      polly: {
        credentials: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
        enabled: true,
      },
      azure: { credentials: { subscriptionKey: "k", region: "eastus" }, enabled: true },
    },
  });
}

describe("fetchAllVoices", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("merges voices from every enabled provider", async () => {
    await setSettings(bothProvidersConfigured());
    vi.spyOn(polly, "fetchVoices").mockResolvedValue([joanna]);
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);

    const voices = await fetchAllVoices();
    expect(voices).toHaveLength(2);
    expect(await voicesSessionItem.getValue()).toHaveLength(2);
  });

  it("isolates failures: one provider throwing never drops the others", async () => {
    await setSettings(bothProvidersConfigured());
    vi.spyOn(polly, "fetchVoices").mockRejectedValue(new Error("throttled"));
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);

    const voices = await fetchAllVoices();
    expect(voices).toEqual([jenny]);
  });

  it("keeps last-good cached voices for a transiently failing provider", async () => {
    await setSettings(bothProvidersConfigured());
    await voicesSessionItem.setValue([joanna]);
    vi.spyOn(polly, "fetchVoices").mockRejectedValue(new Error("network"));
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);

    const voices = await fetchAllVoices();
    // Polly's cached Joanna survives the failed refresh.
    expect(voices).toContainEqual(joanna);
    expect(voices).toContainEqual(jenny);
  });

  it("skips disabled and un-credentialed providers", async () => {
    await setSettings(
      SettingsSchema.parse({
        perProvider: {
          polly: {
            credentials: { accessKeyId: "a", secretAccessKey: "s", region: "r" },
            enabled: false,
          },
        },
      }),
    );
    const pollySpy = vi.spyOn(polly, "fetchVoices");

    const voices = await fetchAllVoices();
    expect(voices).toEqual([]);
    expect(pollySpy).not.toHaveBeenCalled();
  });
});

describe("fetchAllVoices retries", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    // Jitter factor 1: the first backoff is exactly 500 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      failure: "one throttled listing",
      error: sdkError("ThrottlingException", 400),
      calls: 2,
      voices: [joanna, jenny],
    },
    {
      failure: "a rejected key",
      error: sdkError("InvalidClientTokenId", 403),
      calls: 1,
      voices: [jenny],
    },
  ])("after $failure: $calls Polly call(s)", async ({ error, calls, voices }) => {
    await setSettings(bothProvidersConfigured());
    const pollySpy = vi
      .spyOn(polly, "fetchVoices")
      .mockResolvedValue([joanna])
      .mockRejectedValueOnce(error);
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = fetchAllVoices();
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome).toEqual(voices);
    expect(pollySpy).toHaveBeenCalledTimes(calls);
  });
});
