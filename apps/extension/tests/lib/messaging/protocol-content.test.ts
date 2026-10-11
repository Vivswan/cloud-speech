import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { z } from "zod";
import {
  type contentRoutes,
  type ErrorPayload,
  type ErrorToast,
  ErrorToastSchema,
  emit,
  type Handlers,
  type RouteId,
} from "@/lib/messaging/protocol";
import { createContentDispatcher, isErrorToast } from "@/lib/messaging/protocol-content";
import { ProviderHttpError } from "@/lib/messaging/provider-http";

// The content script runs the Zod-free dispatcher; these tests hold it to the registry it stands in for.

// Compile-time guards. tsconfig includes tests, so `bun run typecheck` fails the build if any of these
// mistakes ever compiles. Vitest evaluates the expressions at import and discards them; nothing asserts.
{
  // A new content route must be added to createContentDispatcher too.
  ({ setError: true }) satisfies Record<RouteId<"content">, true>;
  isErrorToast satisfies (value: unknown) => value is z.output<typeof ErrorToastSchema>;

  const complete = {
    setError: async (payload) => {
      payload.title.toUpperCase();
    },
  } satisfies Handlers<typeof contentRoutes>;
  // @ts-expect-error a missing route handler does not compile
  ({}) satisfies Handlers<typeof contentRoutes>;
  ({
    ...complete,
    // @ts-expect-error an unknown route does not compile
    notARoute: async () => {},
  }) satisfies Handlers<typeof contentRoutes>;
  ({
    // @ts-expect-error the payload type comes from the route schema
    setError: async (payload: number) => {
      void payload;
    },
  }) satisfies Handlers<typeof contentRoutes>;
  ({
    // @ts-expect-error the result type comes from the route schema
    setError: async () => 42,
  }) satisfies Handlers<typeof contentRoutes>;

  ({ title: "t", message: "m", detail: "Detail: d" }) satisfies ErrorPayload;
  // @ts-expect-error a notice without its technical detail does not compile
  ({ title: "t", message: "m" }) satisfies ErrorPayload;
  // @ts-expect-error a notice without its plain-words message does not compile
  ({ title: "t", detail: "d" }) satisfies ErrorPayload;
}

async function dispatch(listener: ReturnType<typeof createContentDispatcher>, raw: unknown) {
  let reply: unknown;
  const claimed = listener(raw, {}, (r) => {
    reply = r;
  });
  if (claimed) await vi.waitFor(() => expect(reply).toBeDefined());
  return { claimed, reply };
}

/** The envelope `emit("content", "setError", ...)` really puts on the wire. */
function emitted(payload: unknown): unknown {
  const tabsSend = vi.fn<(tabId: number, message: unknown) => Promise<undefined>>(
    async () => undefined,
  );
  Object.assign(fakeBrowser.tabs, { sendMessage: tabsSend });
  emit("content", "setError", payload as z.input<typeof ErrorToastSchema>, { tabId: 7 });
  expect(tabsSend).toHaveBeenCalledOnce();
  return tabsSend.mock.calls[0]?.[1];
}

describe("protocol-content", () => {
  // Acceptance AND value: a schema transform (a trim, a default) would make
  // the registry dispatcher deliver something this receiver does not.
  const labels = { details: "Details", dismiss: "Dismiss" };
  it.each([
    { title: "t", message: "m", detail: "d", labels },
    { title: "  padded  ", message: " m\n", detail: " d ", labels },
    { title: "", message: "", detail: "", labels: { details: "", dismiss: "" } },
    { title: "t", message: "m", detail: "d", labels, extra: 1 },
    { title: "t", message: "m", detail: "ProviderHttpError: HTTP 403", labels },
    { title: "t", message: "m", detail: "d", labels, action: undefined },
    {
      title: "t",
      message: "m",
      detail: "d",
      labels,
      action: { label: "Fix it", url: "https://console.example/" },
    },
    {
      title: "t",
      message: "m",
      detail: "d",
      labels,
      action: { label: "l", url: "u", extra: true },
    },
    { title: "t", message: "m", detail: "d", labels: { details: "विवरण", dismiss: "खारिज करें" } },
    { title: "t", message: "m", detail: "d", labels: { ...labels, extra: true } },
    { title: "t", message: "m", detail: "d" },
    { title: "t", message: "m", detail: "d", labels: undefined },
    { title: "t", message: "m", detail: "d", labels: { details: "Details" } },
    { title: "t", message: "m", detail: "d", labels: { dismiss: "Dismiss" } },
    { title: "t", message: "m", detail: "d", labels: { details: "Details", dismiss: 1 } },
    { title: "t", message: "m", detail: "d", labels: "Details" },
    { title: "t", message: "m", labels },
    { title: "t", message: "m", detail: undefined, labels },
    { title: "t", message: "m", detail: 403, labels },
    { title: "t", message: "m", detail: "d", labels, action: { label: "Fix it" } },
    { title: "t", message: "m", detail: "d", labels, action: "https://console.example/" },
    { title: "t" },
    { title: 1, message: "m" },
    { message: "m" },
    null,
    "not a payload",
    undefined,
  ])("isErrorToast agrees with ErrorToastSchema on %j", async (value) => {
    const parsed = ErrorToastSchema.safeParse(value);
    expect(isErrorToast(value)).toBe(parsed.success);
    if (!parsed.success) return;

    // toStrictEqual: a present-but-undefined optional must survive exactly as the schema keeps it.
    const setError = vi.fn<(payload: ErrorToast) => Promise<void>>(async () => {});
    const listener = createContentDispatcher({ setError });
    expect(await dispatch(listener, emitted(value))).toEqual({
      claimed: true,
      reply: { ok: true },
    });
    expect(setError).toHaveBeenCalledOnce();
    expect(setError.mock.calls[0]?.[0]).toStrictEqual(parsed.data);
  });

  it("delivers what emit sends and answers like createDispatcher", async () => {
    const setError = vi.fn(async () => {});
    const listener = createContentDispatcher({ setError });

    const payload = {
      title: "Synthesis failed",
      message: "Bad credentials",
      detail: "HTTP 401",
      labels: { details: "Details", dismiss: "Dismiss" },
    };
    expect(await dispatch(listener, emitted(payload))).toEqual({
      claimed: true,
      reply: { ok: true },
    });
    expect(setError).toHaveBeenCalledExactlyOnceWith(payload);

    const { labels: _labels, ...unlabelled } = payload;
    for (const incomplete of [
      { title: "no message" },
      { title: "no detail", message: "m" },
      unlabelled,
    ]) {
      const rejected = await dispatch(listener, emitted(incomplete));
      expect(rejected.claimed).toBe(true);
      expect(rejected.reply).toMatchObject({ ok: false });
    }
    expect(setError).toHaveBeenCalledOnce();

    for (const raw of [
      { to: "popup", id: "setError", payload },
      { to: "content", id: "nope", payload },
      "not an envelope",
      undefined,
    ]) {
      expect(await dispatch(listener, raw)).toEqual({ claimed: undefined, reply: undefined });
    }
  });

  it("turns a handler failure into a failure reply", async () => {
    const listener = createContentDispatcher({
      setError: async () => {
        throw new Error("toast exploded");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = {
      title: "t",
      message: "m",
      detail: "d",
      labels: { details: "D", dismiss: "X" },
    };
    expect(await dispatch(listener, emitted(payload))).toEqual({
      claimed: true,
      reply: { ok: false, error: "Error: toast exploded" },
    });
  });

  // The same rule as createDispatcher: a proxy that echoes the key it rejected
  // (LiteLLM prints "Received API Key = ...") must reach neither the page's
  // console nor the reply, while the status still says what happened.
  it("logs and replies a handler's provider failure without the server body", async () => {
    const key = "sk-EXAMPLE-0123456789abcdefghijklmnopqrstuvwxyz";
    const listener = createContentDispatcher({
      setError: async () => {
        throw new ProviderHttpError("custom", "synthesis", 401, `Received API Key = ${key}`);
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = {
      title: "t",
      message: "m",
      detail: "d",
      labels: { details: "D", dismiss: "X" },
    };

    const { reply } = await dispatch(listener, emitted(payload));

    expect(logged).toHaveBeenCalledOnce();
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toMatch(/^content handler setError failed: /);
    expect(reply).toMatchObject({ ok: false });
    for (const text of [line, String((reply as { error?: unknown }).error)]) {
      expect(text).toContain("401");
      expect(text).not.toContain(key);
      expect(text).not.toContain("Received API Key");
    }
  });
});
