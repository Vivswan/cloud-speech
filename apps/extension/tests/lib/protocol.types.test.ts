import { describe, expect, it } from "vitest";
import type { contentRoutes, ErrorPayload, Handlers } from "@/lib/protocol";

// Compile-time guards: `bun run typecheck` covers tests, so each @ts-expect-error fails the build if its mistake ever compiles.
// The runtime assertions only make vitest count the file.

describe("Handlers<T>", () => {
  it("is exactly one correctly typed handler per route", () => {
    const complete: Handlers<typeof contentRoutes> = {
      setError: async (payload) => {
        payload.title.toUpperCase();
      },
    };

    // @ts-expect-error a missing route handler does not compile
    const missing: Handlers<typeof contentRoutes> = {};

    const extra: Handlers<typeof contentRoutes> = {
      ...complete,
      // @ts-expect-error an unknown route does not compile
      notARoute: async () => {},
    };

    const wrongPayload: Handlers<typeof contentRoutes> = {
      // @ts-expect-error the payload type comes from the route schema
      setError: async (payload: number) => {
        void payload;
      },
    };

    const wrongResult: Handlers<typeof contentRoutes> = {
      // @ts-expect-error the result type comes from the route schema
      setError: async () => 42,
    };

    expect([complete, missing, extra, wrongPayload, wrongResult]).toHaveLength(5);
  });
});

describe("ErrorPayload", () => {
  it("has both parts: the plain words and the technical detail", () => {
    const whole: ErrorPayload = { title: "t", message: "m", detail: "Detail: d" };

    // @ts-expect-error a notice without its technical detail does not compile
    const wordsOnly: ErrorPayload = { title: "t", message: "m" };

    // @ts-expect-error a notice without its plain-words message does not compile
    const detailOnly: ErrorPayload = { title: "t", detail: "d" };

    expect([whole, wordsOnly, detailOnly]).toHaveLength(3);
  });
});
