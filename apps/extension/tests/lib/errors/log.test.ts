import { describe, expect, it, vi } from "vitest";
import { failureLine, logError, logWarning } from "@/lib/errors/log";
import { ProviderHttpError } from "@/lib/provider-http";

const KEY = "sk-EXAMPLE-0123456789abcdefghijklmnopqrstuvwxyz";

// The console is a surface the user shares (a screenshot, a pasted log), and
// nothing but this module stands between a thrown value and it.
describe("failureLine", () => {
  it.each([
    {
      failure: "a provider body echoing the rejected key",
      error: new ProviderHttpError("custom", "voices", 401, `Received API Key = ${KEY}`),
      line: "ProviderHttpError: OpenAI-compatible voices failed: HTTP 401",
    },
    {
      failure: "a plain error quoting a bearer token",
      error: new Error(`the gateway refused Bearer ${KEY}`),
      line: "Error: the gateway refused Bearer [redacted]",
    },
    {
      failure: "an SDK error carrying its status as a field, not in its text",
      error: Object.assign(new Error("The security token is invalid."), {
        name: "UnrecognizedClientException",
        statusCode: 403,
      }),
      line: "UnrecognizedClientException: The security token is invalid. (HTTP 403)",
    },
    {
      failure: "a rejection with no text",
      error: "",
      line: "Error: the thrown value has no text",
    },
    {
      failure: "a value whose toString throws",
      error: {
        toString() {
          throw new Error("no");
        },
      },
      line: "[unprintable error]",
    },
  ])("$failure", ({ error, line }) => {
    expect(failureLine(error)).toBe(line);
  });

  it("keeps a flood of text to one bounded line and still says the status", () => {
    const flood = Object.assign(new Error("x\n".repeat(1000)), { statusCode: 502 });
    const line = failureLine(flood);
    expect(line.length).toBeLessThanOrEqual("Error: ".length + 300 + "... (HTTP 502)".length);
    expect(line).not.toContain("\n");
    expect(line.endsWith("... (HTTP 502)")).toBe(true);
  });
});

describe("logError and logWarning", () => {
  it("pass the console one string, label first", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new ProviderHttpError("azure", "synthesis", 429, KEY);

    logError("Synthesis failed", failure);
    logWarning("Voice fetch failed", failure);

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "Synthesis failed: ProviderHttpError: Azure Speech synthesis failed: HTTP 429",
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Voice fetch failed: ProviderHttpError: Azure Speech synthesis failed: HTTP 429",
    );
  });
});
