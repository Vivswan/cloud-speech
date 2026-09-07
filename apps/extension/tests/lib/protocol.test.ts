import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { z } from "zod";
import {
  backgroundRoutes,
  call,
  createDispatcher,
  emit,
  FailureReplyError,
  type Handlers,
  invoke,
  popupEvents,
  type Reply,
  sendToBackground,
} from "@/lib/protocol";

// A private table keeps these tests independent of the production routes:
// one route with a payload and a typed result, one without a payload.
const routes = {
  echo: { payload: z.object({ text: z.string() }), result: z.string() },
  ping: { payload: z.undefined(), result: z.boolean() },
};

function handlersFor(overrides: Partial<Handlers<typeof routes>> = {}): Handlers<typeof routes> {
  return {
    echo: vi.fn(async ({ text }) => text.toUpperCase()),
    ping: vi.fn(async () => true),
    ...overrides,
  };
}

/** Drive a dispatcher the way the browser does and collect its reply. */
async function dispatch(
  listener: ReturnType<typeof createDispatcher>,
  raw: unknown,
): Promise<{ claimed: true | undefined; reply: Reply | undefined }> {
  let reply: Reply | undefined;
  const claimed = listener(raw, {}, (r) => {
    reply = r;
  });
  if (claimed) await vi.waitFor(() => expect(reply).toBeDefined());
  return { claimed, reply };
}

describe("createDispatcher", () => {
  it("answers only its own target: foreign targets and unknown ids stay unclaimed", async () => {
    const handlers = handlersFor();
    const listener = createDispatcher("popup", routes, handlers);

    const cases: unknown[] = [
      { to: "background", id: "echo", payload: { text: "a" } },
      { to: "popup", id: "nope", payload: { text: "a" } },
      // Prototype keys are not routes either.
      { to: "popup", id: "constructor" },
      "not an envelope",
      undefined,
    ];
    for (const raw of cases) {
      expect(await dispatch(listener, raw)).toEqual({ claimed: undefined, reply: undefined });
    }
    expect(handlers.echo).not.toHaveBeenCalled();
    expect(handlers.ping).not.toHaveBeenCalled();
  });

  it("parses the payload once and answers the handler's value", async () => {
    const handlers = handlersFor();
    const listener = createDispatcher("popup", routes, handlers);

    expect(await dispatch(listener, { to: "popup", id: "echo", payload: { text: "hi" } })).toEqual({
      claimed: true,
      reply: { ok: true, value: "HI" },
    });
    expect(handlers.echo).toHaveBeenCalledExactlyOnceWith({ text: "hi" });

    // A payload-less route accepts an omitted payload (the wire drops it).
    expect(await dispatch(listener, { to: "popup", id: "ping" })).toEqual({
      claimed: true,
      reply: { ok: true, value: true },
    });
  });

  it("rejects a payload its schema refuses without calling the handler", async () => {
    const handlers = handlersFor();
    const onError = vi.fn();
    const listener = createDispatcher("popup", routes, handlers, { onError });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { claimed, reply } = await dispatch(listener, {
      to: "popup",
      id: "echo",
      payload: { text: 42 },
    });
    expect(claimed).toBe(true);
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("popup.echo") });
    expect(handlers.echo).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("turns a handler failure into a failure reply after onError ran", async () => {
    const failure = new Error("boom");
    const handlers = handlersFor({ ping: vi.fn(async () => Promise.reject(failure)) });
    const order: string[] = [];
    const onError = vi.fn(async (id: string) => {
      await Promise.resolve();
      order.push(`onError:${id}`);
    });
    const listener = createDispatcher("popup", routes, handlers, { onError });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { reply } = await dispatch(listener, { to: "popup", id: "ping" });
    order.push("replied");

    expect(reply).toEqual({ ok: false, error: "Error: boom" });
    expect(onError).toHaveBeenCalledExactlyOnceWith("ping", failure);
    expect(order).toEqual(["onError:ping", "replied"]);
  });

  it("holds every handler behind the gate", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const handlers = handlersFor();
    const listener = createDispatcher("popup", routes, handlers, { gate });

    let reply: Reply | undefined;
    listener({ to: "popup", id: "ping" }, {}, (r) => {
      reply = r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handlers.ping).not.toHaveBeenCalled();
    expect(reply).toBeUndefined();

    open();
    await vi.waitFor(() => expect(reply).toEqual({ ok: true, value: true }));
    expect(handlers.ping).toHaveBeenCalledOnce();
  });
});

describe("invoke", () => {
  it("runs a route in-process with the same parse-once contract as the wire", async () => {
    const handlers = handlersFor();
    await expect(invoke(routes, handlers, "echo", { text: "hi" })).resolves.toBe("HI");
    await expect(invoke(routes, handlers, "ping")).resolves.toBe(true);
    expect(handlers.echo).toHaveBeenCalledExactlyOnceWith({ text: "hi" });
  });
});

describe("call / sendToBackground / emit", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function popupHandlers(
    overrides: Partial<Handlers<typeof popupEvents>> = {},
  ): Handlers<typeof popupEvents> {
    return {
      backgroundError: vi.fn(async () => {}),
      ...overrides,
    };
  }

  /** Every background route fails loudly except the one under test. */
  function backgroundHandlersWith(
    readAloud: Handlers<typeof backgroundRoutes>["readAloud"],
  ): Handlers<typeof backgroundRoutes> {
    const unexpected = async () => {
      throw new Error("unexpected background route");
    };
    const stubs = Object.fromEntries(Object.keys(backgroundRoutes).map((id) => [id, unexpected]));
    return { ...stubs, readAloud } as Handlers<typeof backgroundRoutes>;
  }

  it("round-trips a request through a dispatcher on the other side", async () => {
    const seen: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      seen.push(message);
    });
    const backgroundError = vi.fn(async () => {});
    fakeBrowser.runtime.onMessage.addListener(
      createDispatcher("popup", popupEvents, popupHandlers({ backgroundError })),
    );

    await expect(call("popup", "backgroundError", { title: "t", message: "m" })).resolves.toBe(
      undefined,
    );
    expect(seen).toEqual([
      { to: "popup", id: "backgroundError", payload: { title: "t", message: "m" } },
    ]);
    expect(backgroundError).toHaveBeenCalledExactlyOnceWith({ title: "t", message: "m" });
  });

  // The popup and background dispatchers share one runtime.onMessage in the
  // real extension: a background request must reach its handler and answer
  // with the popup dispatcher present, in either registration order.
  it.each([
    { order: "background then popup", targets: ["background", "popup"] as const },
    { order: "popup then background", targets: ["popup", "background"] as const },
  ])(
    "sendToBackground carries a payload past the popup dispatcher ($order)",
    async ({ targets }) => {
      const readAloud = vi.fn(async (_payload: { text: string; speed?: number }) => true);
      const popup = popupHandlers();
      const listeners = {
        background: createDispatcher(
          "background",
          backgroundRoutes,
          backgroundHandlersWith(readAloud),
        ),
        popup: createDispatcher("popup", popupEvents, popup),
      };
      for (const target of targets) fakeBrowser.runtime.onMessage.addListener(listeners[target]);

      await expect(sendToBackground("readAloud", { text: "hi" })).resolves.toBe(true);
      expect(readAloud).toHaveBeenCalledExactlyOnceWith({ text: "hi" });
      for (const handler of Object.values(popup)) expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects when nobody answers, when the reply is a failure, and when the value fails its schema", async () => {
    // A listener that leaves the envelope unclaimed (another target's
    // dispatcher): the request settles with no reply at all.
    fakeBrowser.runtime.onMessage.addListener(() => undefined);
    await expect(call("background", "stopReading")).rejects.toThrow(
      "background did not respond to stopReading",
    );

    let reply: unknown = { ok: false, error: "Error: boom" };
    fakeBrowser.runtime.onMessage.addListener(
      (_message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
        sendResponse(reply);
        return true;
      },
    );
    await expect(call("background", "stopReading")).rejects.toThrow(FailureReplyError);
    await expect(call("background", "stopReading")).rejects.toThrow("Error: boom");

    reply = { ok: true, value: "yes" };
    await expect(call("background", "stopReading")).rejects.toThrow(z.ZodError);

    reply = { ok: true, value: true };
    await expect(call("background", "stopReading")).resolves.toBe(true);

    // A void result crosses the wire as a reply without a value key.
    reply = { ok: true };
    await expect(
      call("popup", "backgroundError", { title: "t", message: "m" }),
    ).resolves.toBeUndefined();
  });

  it("sendToBackground rejects after the timeout when the reply never comes", async () => {
    vi.useFakeTimers();
    fakeBrowser.runtime.onMessage.addListener(() => true);

    const pending = sendToBackground("stopReading");
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).rejects.toThrow("stopReading timed out after 120s");
  });

  it("emit delivers the envelope and swallows every delivery failure", async () => {
    // Nobody listening: the test double rejects, real browsers do too.
    expect(() => emit("popup", "backgroundError", { title: "t", message: "m" })).not.toThrow();
    // tabs.sendMessage is not mocked at all: a synchronous throw.
    expect(() =>
      emit("content", "setError", { title: "t", message: "m" }, { tabId: 7 }),
    ).not.toThrow();

    const seen: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      seen.push(message);
    });
    const tabsSend = vi.fn(async () => undefined);
    Object.assign(fakeBrowser.tabs, { sendMessage: tabsSend });

    emit("popup", "backgroundError", { title: "t", message: "m" });
    emit("content", "setError", { title: "t", message: "m" }, { tabId: 7 });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen).toEqual([
      { to: "popup", id: "backgroundError", payload: { title: "t", message: "m" } },
    ]);
    expect(tabsSend).toHaveBeenCalledExactlyOnceWith(7, {
      to: "content",
      id: "setError",
      payload: { title: "t", message: "m" },
    });
  });
});
