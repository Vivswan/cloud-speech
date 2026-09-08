import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { describeFailure, surfaceError } from "@/lib/errors";
import { ProviderHttpError } from "@/lib/provider-http";
import { withProviderPrefs } from "@/lib/provider-state";
import { DEFAULT_SETTINGS, setSettings } from "@/lib/storage";
import { NoVoiceSelectedError, ProviderDisabledError } from "@/lib/synthesize";
import { UserFacingError } from "@/lib/user-facing-error";
import { sdkError } from "../helpers/sdk-error";

// What the user reads for each class of failure, in the shipped English: the
// substituted sentences are the product, so the test resolves the real
// en.yml instead of asserting key names.
vi.mock("@/lib/i18n-runtime", async () => (await import("../helpers/en-locale")).englishRuntime());

const GOOGLE_DISABLED_DETAIL =
  "Agent Platform API has not been used in project 176867167810 before or it is disabled. " +
  "Enable it by visiting https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=176867167810 then retry. " +
  "If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.";

const OPENAI_RATE_LIMIT_DETAIL =
  "Rate limit reached for gpt-4o-mini-tts on requests per min (RPM): Limit 3, Used 3, Requested 1. " +
  "Please try again in 20s. You can increase your rate limit by adding a payment method to your " +
  "account at https://platform.openai.com/account/billing.";

const TITLE = "Could not read aloud";

function http(provider: ProviderHttpError["provider"], status: number, detail = "") {
  return new ProviderHttpError(provider, "synthesis", status, detail);
}

function networkError(): TypeError {
  return new TypeError("Failed to fetch");
}

describe("describeFailure", () => {
  it.each([
    {
      failure: "a Google key that lacks the API the voice needs",
      error: http("google", 403, GOOGLE_DISABLED_DETAIL),
      payload: {
        title: TITLE,
        message:
          "This voice needs the Agent Platform API switched on in your Google Cloud TTS account. Turn it on, wait a minute, then try again.",
        action: {
          label: "Fix it on the Google Cloud TTS website",
          url: "https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=176867167810",
        },
        // The console link keeps its project in the action; the detail, which
        // travels to bug reports, loses every URL query.
        detail: `ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403 (${GOOGLE_DISABLED_DETAIL.replace("?project=176867167810", "")})`,
      },
    },
    {
      failure: "a Google key rejected as a 400",
      error: http("google", 400, "API key not valid. Please pass a valid API key."),
      payload: {
        title: TITLE,
        message:
          "Your Google Cloud TTS key was rejected. Check it in Settings, or pick a voice from another provider.",
        detail:
          "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 400 (API key not valid. Please pass a valid API key.)",
      },
    },
    {
      failure: "a 401 from any provider",
      error: http("azure", 401, "Access denied due to invalid subscription key"),
      payload: {
        title: TITLE,
        message:
          "Your Azure Speech key was rejected. Check it in Settings, or pick a voice from another provider.",
        detail:
          "ProviderHttpError: Azure Speech synthesis failed: HTTP 401 (Access denied due to invalid subscription key)",
      },
    },
    {
      failure: "a 403 without a recognisable story",
      error: http("openai", 403),
      payload: {
        title: TITLE,
        message:
          "Your OpenAI key was rejected. Check it in Settings, or pick a voice from another provider.",
        detail: "ProviderHttpError: OpenAI synthesis failed: HTTP 403",
      },
    },
    {
      failure: "an Azure quota used up (a 403 too)",
      error: http("azure", 403, "Quota Exceeded"),
      payload: {
        title: TITLE,
        message:
          "Your Azure Speech account has used up its quota. Wait for it to reset or upgrade the plan, or pick a voice from another provider.",
        detail: "ProviderHttpError: Azure Speech synthesis failed: HTTP 403 (Quota Exceeded)",
      },
    },
    {
      failure: "a throttled request",
      error: http("azure", 429),
      payload: {
        title: TITLE,
        message: "Azure Speech is busy right now. Try again in a moment.",
        detail: "ProviderHttpError: Azure Speech synthesis failed: HTTP 429",
      },
    },
    {
      failure: "an OpenAI account out of credit (a 429 too)",
      error: http(
        "openai",
        429,
        "You exceeded your current quota, please check your plan and billing details.",
      ),
      payload: {
        title: TITLE,
        message:
          "Your OpenAI account is out of credit. Add credit, or pick a voice from another provider.",
        action: {
          label: "Fix it on the OpenAI website",
          url: "https://platform.openai.com/settings/organization/billing/overview",
        },
        detail:
          "ProviderHttpError: OpenAI synthesis failed: HTTP 429 (You exceeded your current quota, please check your plan and billing details.)",
      },
    },
    {
      failure: "an OpenAI rate limit whose body also mentions billing",
      error: http("openai", 429, OPENAI_RATE_LIMIT_DETAIL),
      payload: {
        title: TITLE,
        message: "OpenAI is busy right now. Try again in a moment.",
        detail: `ProviderHttpError: OpenAI synthesis failed: HTTP 429 (${OPENAI_RATE_LIMIT_DETAIL})`,
      },
    },
    {
      failure: "a Google account without billing",
      error: http(
        "google",
        403,
        "This API method requires billing to be enabled. Please enable billing on project #42 by visiting https://console.developers.google.com/billing/enable?project=42 then retry.",
      ),
      payload: {
        title: TITLE,
        message:
          "Your Google Cloud TTS account needs billing switched on. Turn it on, wait a minute, then try again.",
        action: {
          label: "Fix it on the Google Cloud TTS website",
          url: "https://console.developers.google.com/billing/enable?project=42",
        },
        detail:
          "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403 (This API method requires billing to be enabled. Please enable billing on project #42 by visiting https://console.developers.google.com/billing/enable then retry.)",
      },
    },
    {
      failure: "a provider outage",
      error: http("google", 503),
      payload: {
        title: TITLE,
        message:
          "Google Cloud TTS is having trouble. Try again later, or pick a voice from another provider.",
        detail: "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 503",
      },
    },
    {
      failure: "a voice or text the provider refuses",
      error: http("azure", 400, "Unsupported voice"),
      payload: {
        title: TITLE,
        message: "Azure Speech could not read this text with this voice. Try another voice.",
        detail: "ProviderHttpError: Azure Speech synthesis failed: HTTP 400 (Unsupported voice)",
      },
    },
    {
      failure: "a custom server with no speech route",
      error: http("custom", 404, "Not Found"),
      payload: {
        title: TITLE,
        message: "The server at that URL does not offer speech. Check the server URL in Settings.",
        detail: "ProviderHttpError: OpenAI-compatible synthesis failed: HTTP 404 (Not Found)",
      },
    },
    {
      failure: "a custom speech route that knows no such model",
      error: http("custom", 404, "The model tts-1 does not exist"),
      payload: {
        title: TITLE,
        message:
          "The server does not know this voice or model. Check the voices and model in Settings.",
        detail:
          "ProviderHttpError: OpenAI-compatible synthesis failed: HTTP 404 (The model tts-1 does not exist)",
      },
    },
    {
      failure: "a gateway passing OpenAI's exhausted quota through",
      error: http(
        "custom",
        429,
        "You exceeded your current quota, please check your plan and billing details.",
      ),
      payload: {
        title: TITLE,
        message:
          "Your OpenAI-compatible account is out of credit. Add credit, or pick a voice from another provider.",
        detail:
          "ProviderHttpError: OpenAI-compatible synthesis failed: HTTP 429 (You exceeded your current quota, please check your plan and billing details.)",
      },
    },
    {
      failure: "a gateway echoing the key it rejected",
      error: http("custom", 401, "Invalid authentication. Received API Key = EXAMPLEKEY0000"),
      payload: {
        title: TITLE,
        message:
          "Your OpenAI-compatible key was rejected. Check it in Settings, or pick a voice from another provider.",
        detail:
          "ProviderHttpError: OpenAI-compatible synthesis failed: HTTP 401 (Invalid authentication. Received API Key=[redacted])",
      },
    },
    {
      failure: "a custom server answering with a web page",
      error: http("custom", 200, "<html>"),
      payload: {
        title: TITLE,
        message: "The server at that URL does not offer speech. Check the server URL in Settings.",
        detail: "ProviderHttpError: OpenAI-compatible synthesis failed: HTTP 200 (<html>)",
      },
    },
    {
      failure: "a fetch that never got an answer, provider unknown",
      error: networkError(),
      payload: {
        title: TITLE,
        message: "Could not reach the speech service. Check your internet connection.",
        detail: "TypeError: Failed to fetch",
      },
    },
    {
      failure: "a deadline that ran out, provider unknown",
      error: new DOMException("signal timed out", "TimeoutError"),
      payload: {
        title: TITLE,
        message: "Could not reach the speech service. Check your internet connection.",
        detail: "TimeoutError: signal timed out",
      },
    },
    {
      failure: "Polly credentials the SDK rejects (a 400 by status)",
      error: sdkError("UnrecognizedClientException", 400),
      payload: {
        title: TITLE,
        message:
          "Your Amazon Polly key was rejected. Check it in Settings, or pick a voice from another provider.",
        detail: "UnrecognizedClientException: UnrecognizedClientException",
      },
    },
    {
      failure: "a Polly key that may list voices but not speak (a 403 by status)",
      error: sdkError("AccessDeniedException", 403),
      payload: {
        title: TITLE,
        message:
          "Your Amazon Polly key is not allowed to use speech. Give it permission in your Amazon Polly account, or pick a voice from another provider.",
        detail: "AccessDeniedException: AccessDeniedException",
      },
    },
    {
      failure: "Polly throttling (a 400 by status)",
      error: sdkError("ThrottlingException", 400),
      payload: {
        title: TITLE,
        message: "Amazon Polly is busy right now. Try again in a moment.",
        detail: "ThrottlingException: ThrottlingException",
      },
    },
    {
      failure: "a Polly request the SDK names nothing special",
      error: sdkError("InvalidSsmlException", 400),
      payload: {
        title: TITLE,
        message: "Amazon Polly could not read this text with this voice. Try another voice.",
        detail: "InvalidSsmlException: InvalidSsmlException",
      },
    },
    {
      failure: "a malformed Azure region, refused before any request",
      error: new Error('Azure region "East US" is invalid'),
      payload: {
        title: TITLE,
        message:
          "The Azure Speech region in Settings looks wrong. Fix it, or pick a voice from another provider.",
        detail: 'Error: Azure region "East US" is invalid',
      },
    },
    {
      failure: "the notice the background throws when nothing is selected",
      error: new UserFacingError({
        titleKey: "errors.read_failed_title",
        messageKey: "errors.no_selection",
      }),
      payload: { title: TITLE, message: "Select some text on the page first." },
    },
    {
      failure: "a notice with its own fix link",
      error: new UserFacingError({
        titleKey: "settings.storage_error_newer_title",
        messageKey: "settings.storage_error_newer",
        action: { labelKey: "settings.storage_error_newer_action", url: "https://store.example/" },
      }),
      payload: {
        title: "Settings locked by a newer version",
        message:
          "Update the extension to change settings. This device is reading settings saved by a newer version.",
        action: { label: "Open the store page", url: "https://store.example/" },
      },
    },
    {
      failure: "a plain Error carrying one of our sentences (no longer a notice)",
      error: new Error("Select some text on the page first."),
      payload: {
        title: TITLE,
        message: "Something went wrong. Try again, or pick another voice.",
        detail: "Error: Select some text on the page first.",
      },
    },
    {
      failure: "a plain Error with technical text (Firefox's audio session)",
      error: new Error("Error loading audio source: NS_ERROR_DOM_MEDIA_METADATA_ERR"),
      payload: {
        title: TITLE,
        message: "Something went wrong. Try again, or pick another voice.",
        detail: "Error: Error loading audio source: NS_ERROR_DOM_MEDIA_METADATA_ERR",
      },
    },
    {
      failure: "machinery nobody recognizes",
      error: new RangeError("Invalid array length"),
      payload: {
        title: TITLE,
        message: "Something went wrong. Try again, or pick another voice.",
        detail: "RangeError: Invalid array length",
      },
    },
    {
      failure: "no voice selected",
      error: new NoVoiceSelectedError(),
      payload: {
        title: "No voice selected",
        message: "Open the extension popup and pick a voice in Preferences.",
      },
    },
    {
      failure: "a disabled provider",
      error: new ProviderDisabledError("google"),
      payload: {
        title: "Provider is disabled",
        message: "Enable the provider in Settings or pick a voice from another provider.",
      },
    },
  ])("tells the user what to do about $failure", ({ error, payload }) => {
    expect(describeFailure(error)).toEqual(payload);
  });

  it.each([
    {
      provider: "google" as const,
      message: "Could not reach Google Cloud TTS. Check your internet connection.",
    },
    {
      provider: "azure" as const,
      message:
        "Could not reach Azure Speech. Check the region in Settings and your internet connection.",
    },
    {
      provider: "polly" as const,
      message:
        "Could not reach Amazon Polly. Check the region in Settings and your internet connection.",
    },
    {
      provider: "custom" as const,
      message:
        "Could not reach your server. Check the server URL in Settings and that the server is running.",
    },
  ])("names $provider when the caller knows whose fetch got no answer", ({ provider, message }) => {
    expect(describeFailure(networkError(), { providerId: provider })).toEqual({
      title: TITLE,
      message,
      detail: "TypeError: Failed to fetch",
    });
  });

  it("recognizes the disabled API whatever Google calls it and wherever the link sits", () => {
    const detail =
      "Access Not Configured. Cloud Text-to-Speech API has not been used in project 42 before or it is disabled. Enable it by visiting https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/overview?project=42. Then retry.";
    expect(describeFailure(http("google", 403, detail))).toEqual({
      title: TITLE,
      message:
        "This voice needs the Cloud Text-to-Speech API switched on in your Google Cloud TTS account. Turn it on, wait a minute, then try again.",
      action: {
        label: "Fix it on the Google Cloud TTS website",
        url: "https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/overview?project=42",
      },
      detail: `ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403 (${detail.replace("?project=42.", "")})`,
    });
  });

  it("trusts the error's own provider over the caller's context", () => {
    expect(describeFailure(http("openai", 401), { providerId: "google" })).toEqual({
      title: TITLE,
      message:
        "Your OpenAI key was rejected. Check it in Settings, or pick a voice from another provider.",
      detail: "ProviderHttpError: OpenAI synthesis failed: HTTP 401",
    });
  });
});

describe("surfaceError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the same notice to the active tab's toast and the popup banner", async () => {
    fakeBrowser.reset();
    const toTab = vi.fn(async () => undefined);
    Object.assign(fakeBrowser.tabs, {
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage: toTab,
    });
    const toPopup = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined);

    await surfaceError(http("google", 403, GOOGLE_DISABLED_DETAIL));

    const payload = describeFailure(http("google", 403, GOOGLE_DISABLED_DETAIL));
    expect(payload).toMatchObject({ action: expect.anything(), detail: expect.any(String) });
    expect(toTab).toHaveBeenCalledExactlyOnceWith(7, { to: "content", id: "setError", payload });
    expect(toPopup).toHaveBeenCalledExactlyOnceWith({
      to: "popup",
      id: "backgroundError",
      payload,
    });
  });

  it("still reaches the popup when no tab can take the toast", async () => {
    fakeBrowser.reset();
    Object.assign(fakeBrowser.tabs, {
      query: vi.fn(async () => {
        throw new Error("no tabs here");
      }),
    });
    const toPopup = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined);

    await surfaceError(
      new UserFacingError({
        titleKey: "errors.read_failed_title",
        messageKey: "errors.no_selection",
      }),
    );

    expect(toPopup).toHaveBeenCalledExactlyOnceWith({
      to: "popup",
      id: "backgroundError",
      payload: { title: TITLE, message: "Select some text on the page first." },
    });
  });

  it("blanks a configured key the server echoed, even one too short to be recognized by shape", async () => {
    fakeBrowser.reset();
    Object.assign(fakeBrowser.tabs, { query: vi.fn(async () => []) });
    const toPopup = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined);
    await setSettings({
      ...DEFAULT_SETTINGS,
      ...withProviderPrefs(DEFAULT_SETTINGS, "custom", {
        credentials: { baseUrl: "https://tts.example/v1", apiKey: "short-secret-123" },
      }),
    });
    const echoed = http("custom", 401, "Rejected credential short-secret-123");
    // The shape-based redaction alone lets a 16-character key through.
    expect(describeFailure(echoed).detail).toContain("short-secret-123");

    await surfaceError(echoed);

    expect(toPopup).toHaveBeenCalledExactlyOnceWith({
      to: "popup",
      id: "backgroundError",
      payload: expect.objectContaining({
        detail:
          "ProviderHttpError: OpenAI-compatible synthesis failed: HTTP 401 (Rejected credential [redacted])",
      }),
    });
  });
});
