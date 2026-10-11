import { describe, expect, it, vi } from "vitest";
import { describeFailure, readingAdvice } from "@/lib/errors/errors";
import { ProviderHttpError } from "@/lib/messaging/provider-http";
import { getProvider } from "@/providers";

// Hindi translates one provider's name (the OpenAI-compatible server), so an
// English name leaking into a notice shows there.
vi.mock("@/lib/text/i18n-runtime", async () =>
  (await import("../../helpers/en-locale")).localeRuntime("hi"),
);

describe("a notice in another display language", () => {
  it("names the provider as Settings does, not in English", () => {
    const error = new ProviderHttpError("custom", "synthesis", 401, "");
    expect(describeFailure(error).message).toBe(
      "आपकी OpenAI-संगत कुंजी अस्वीकार कर दी गई। इसे सेटिंग्स में जांचें, या किसी अन्य प्रदाता की आवाज़ चुनें।",
    );
  });

  it("labels the fix link with the same name", () => {
    const advice = readingAdvice(getProvider("custom"), {
      kind: "key_rejected",
      actionUrl: "https://example.com/fix",
    });
    expect(advice.action?.label).toBe("OpenAI-संगत वेबसाइट पर इसे ठीक करें");
  });
});
