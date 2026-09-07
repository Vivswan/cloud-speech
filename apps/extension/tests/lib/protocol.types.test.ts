import { describe, expect, it } from "vitest";
import type { contentRoutes, Handlers } from "@/lib/protocol";

// Compile-time guards: `bun run typecheck` covers tests, so every expected
// type error below fails the build if the mistake it marks ever starts to
// compile. The runtime assertion only makes vitest count the file.

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
