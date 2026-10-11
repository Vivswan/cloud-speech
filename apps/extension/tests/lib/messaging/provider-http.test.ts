import { describe, expect, it } from "vitest";
import { audioBytes } from "@/lib/messaging/provider-http";
import { httpResponse } from "../../helpers/http-response";

const BODY = new TextEncoder().encode("quota exceeded");

function ok200(contentType: string | null): Response {
  return httpResponse({ contentType, body: BODY });
}

describe("audioBytes content-type gate", () => {
  it.each([
    "text/plain",
    "text/plain; charset=utf-8",
    "text/html; charset=utf-8",
    "application/json",
    "application/problem+json",
    "Application/JSON; charset=UTF-8",
  ])("rejects a 200 typed %s with the body as the detail", async (contentType) => {
    await expect(audioBytes("custom", "synthesis", ok200(contentType))).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 200,
      message: "OpenAI-compatible synthesis failed: HTTP 200 (quota exceeded)",
    });
  });

  it.each([
    "audio/mpeg",
    "audio/ogg; codecs=opus",
    "application/octet-stream",
    "binary/octet-stream",
  ])("returns the bytes of a 200 typed %s", async (contentType) => {
    await expect(audioBytes("custom", "synthesis", ok200(contentType))).resolves.toEqual(BODY);
  });

  it("returns the bytes of a 200 without a content-type header", async () => {
    await expect(audioBytes("custom", "synthesis", ok200(null))).resolves.toEqual(BODY);
  });
});
