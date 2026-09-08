import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { z } from "zod";
import { type ErrorPayload, ErrorPayloadSchema, emit, type RouteId } from "@/lib/protocol";
import { createContentDispatcher, isErrorPayload } from "@/lib/protocol-content";

// The content script runs the Zod-free dispatcher; these tests hold it to
// the registry it stands in for.

/** Drive a listener the way the browser does and collect its reply. */
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
  emit("content", "setError", payload as z.input<typeof ErrorPayloadSchema>, { tabId: 7 });
  expect(tabsSend).toHaveBeenCalledOnce();
  return tabsSend.mock.calls[0]?.[1];
}

describe("protocol-content", () => {
  it("has one route, so the hand-checked dispatcher covers the whole content table", () => {
    // A new content route must be added to createContentDispatcher too.
    const covered: Record<RouteId<"content">, true> = { setError: true };
    // The guard's predicate type is the schema's output type.
    const guard: (value: unknown) => value is z.output<typeof ErrorPayloadSchema> = isErrorPayload;
    expect([covered, guard]).toHaveLength(2);
  });

  // Acceptance AND value: a schema transform (a trim, a default) would make
  // the registry dispatcher deliver something this receiver does not.
  it.each([
    { title: "t", message: "m", detail: "d" },
    { title: "  padded  ", message: " m\n", detail: " d " },
    { title: "", message: "", detail: "" },
    { title: "t", message: "m", detail: "d", extra: 1 },
    { title: "t", message: "m", detail: "ProviderHttpError: HTTP 403" },
    { title: "t", message: "m", detail: "d", action: undefined },
    {
      title: "t",
      message: "m",
      detail: "d",
      action: { label: "Fix it", url: "https://console.example/" },
    },
    { title: "t", message: "m", detail: "d", action: { label: "l", url: "u", extra: true } },
    { title: "t", message: "m" },
    { title: "t", message: "m", detail: undefined },
    { title: "t", message: "m", detail: 403 },
    { title: "t", message: "m", detail: "d", action: { label: "Fix it" } },
    { title: "t", message: "m", detail: "d", action: "https://console.example/" },
    { title: "t" },
    { title: 1, message: "m" },
    { message: "m" },
    null,
    "not a payload",
    undefined,
  ])("isErrorPayload agrees with ErrorPayloadSchema on %j", async (value) => {
    const parsed = ErrorPayloadSchema.safeParse(value);
    expect(isErrorPayload(value)).toBe(parsed.success);
    if (!parsed.success) return;

    // The handler receives exactly what the schema would have produced:
    // unknown keys stripped, known values untouched, a present-but-undefined
    // optional kept as such.
    const setError = vi.fn<(payload: ErrorPayload) => Promise<void>>(async () => {});
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

    const payload = { title: "Synthesis failed", message: "Bad credentials", detail: "HTTP 401" };
    expect(await dispatch(listener, emitted(payload))).toEqual({
      claimed: true,
      reply: { ok: true },
    });
    expect(setError).toHaveBeenCalledExactlyOnceWith(payload);

    for (const incomplete of [{ title: "no message" }, { title: "no detail", message: "m" }]) {
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
    expect(await dispatch(listener, emitted({ title: "t", message: "m", detail: "d" }))).toEqual({
      claimed: true,
      reply: { ok: false, error: "Error: toast exploded" },
    });
  });
});
