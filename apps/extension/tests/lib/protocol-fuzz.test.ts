import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { z } from "zod";
import {
  call,
  createDispatcher,
  FailureReplyError,
  type Payload,
  type Reply,
  type Result,
  type RouteId,
  type Target,
  targets,
} from "@/lib/protocol";

// ---------------------------------------------------------------------------
// The dispatcher and `call` against arbitrary wire input. A runtime.onMessage
// listener sees every message any context sends, so the contract is: never
// throw, claim only own well-addressed envelopes, parse the payload exactly
// once and never let an unparsed one reach a handler, answer bad payloads
// with a failure reply, and (on the sending side) accept only replies whose
// value the route's result schema admits.
// ---------------------------------------------------------------------------

type Samples = {
  [T in Target]: { [K in RouteId<T>]: { payload: Payload<T, K>; result: Result<T, K> } };
};

/** One valid request and reply per route. Typed by the route tables, so a
 *  new route without a sample is a compile error; used as the positive
 *  control (the accepting branch of every property is reached) and as the
 *  well-formed `call` request the reply properties answer. */
const samples: Samples = {
  background: {
    fetchVoices: { payload: undefined, result: 3 },
    validateProvider: {
      payload: { providerId: "azure", credentials: { subscriptionKey: "k", region: "eastus" } },
      result: { ok: true },
    },
    readAloud: { payload: { text: "hi", speed: 1.25 }, result: true },
    stopReading: { payload: undefined, result: true },
    download: { payload: { text: "hi" }, result: true },
    previewVoice: {
      payload: { providerId: "google", voiceId: "en-US-Wavenet-D", model: "wavenet" },
      result: true,
    },
    playerPause: { payload: undefined, result: true },
    playerResume: { payload: undefined, result: true },
    playerSeekTo: { payload: { seconds: 12.5 }, result: true },
    playerSetRate: { payload: { rate: 1.5 }, result: true },
    scanVoices: {
      payload: { providerId: "polly" },
      result: { familiesChecked: 4, familiesUnavailable: 1 },
    },
    keepalive: { payload: undefined, result: true },
    audioProgress: { payload: { epoch: 2, currentTime: 1.5, duration: 9 }, result: true },
    audioEnded: { payload: { epoch: 2, currentTime: 9, duration: 9 }, result: true },
  },
  audio: {
    play: { payload: { epoch: 1, audioUri: "data:audio/mpeg;base64,", rate: 1 }, result: "ok" },
    stop: { payload: undefined, result: "ok" },
    pause: { payload: undefined, result: { currentTime: 1, duration: 2 } },
    resume: { payload: { epoch: 1 }, result: "ok" },
    seekTo: { payload: { seconds: 3 }, result: { currentTime: 3, duration: 8 } },
    setRate: { payload: { rate: 2 }, result: "ok" },
    previewPlay: { payload: { audioUri: "data:audio/mpeg;base64," }, result: "ok" },
    previewStop: { payload: undefined, result: "ok" },
  },
  content: {
    setError: {
      payload: { title: "t", message: "m", detail: "d", labels: { details: "D", dismiss: "X" } },
      result: undefined,
    },
  },
  popup: {
    backgroundError: { payload: { title: "t", message: "m", detail: "d" }, result: undefined },
  },
};

/** The sample for a route named at runtime (the properties pick targets and
 *  ids from the tables, so the static types are gone). */
function sampleOf(to: Target, id: string): { payload: unknown; result: unknown } {
  const sample = (samples[to] as Record<string, { payload: unknown; result: unknown }>)[id];
  if (!sample) throw new Error(`no sample for ${to}.${id}`);
  return sample;
}

const TARGETS = Object.keys(targets) as Target[];
const target = fc.constantFrom(...TARGETS);
const routeOf = (to: Target) => fc.constantFrom(...(Object.keys(targets[to]) as RouteId<Target>[]));

/** Anything a peer could put on the wire: JSON (what serialization yields),
 *  plus the odder values a test double or an in-process sender can pass. */
const wireValue = fc.oneof({ arbitrary: fc.jsonValue(), weight: 3 }, fc.anything());

/** A sample payload, or an arbitrary value in its place. */
const payloadFor = (to: Target, id: RouteId<Target>) =>
  fc.oneof(
    {
      arbitrary: fc.constant(sampleOf(to, id).payload),
      weight: 1,
    },
    { arbitrary: wireValue, weight: 3 },
  );

interface Dispatch {
  claimed: true | undefined;
  reply: Reply | undefined;
  /** The (id, payload) pairs the handlers saw. */
  calls: { id: string; payload: unknown }[];
}

/** A dispatcher for `to` whose handlers record what they receive, driven
 *  once with `raw`. A claimed envelope must produce a reply within a few
 *  microtask turns (the handlers resolve at once). */
async function dispatchOnce(to: Target, raw: unknown): Promise<Dispatch> {
  const calls: Dispatch["calls"] = [];
  const routes = targets[to] as Record<string, { payload: z.ZodType; result: z.ZodType }>;
  const handlers = Object.fromEntries(
    Object.keys(routes).map((id) => [
      id,
      async (payload: unknown) => {
        calls.push({ id, payload });
        return sampleOf(to, id).result;
      },
    ]),
  );
  let reply: Reply | undefined;
  let deliver: () => void = () => {};
  const delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const listener = createDispatcher(to, routes, handlers);
  const claimed = listener(raw, {}, (r) => {
    reply = r;
    deliver();
  });
  if (claimed) {
    await Promise.race([
      delivered,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${to} claimed the envelope but never replied`)), 1000),
      ),
    ]);
  }
  return { claimed, reply, calls };
}

function isEnvelopeFor(raw: unknown, to: Target): raw is { to: Target; id: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as { to?: unknown }).to === to &&
    typeof (raw as { id?: unknown }).id === "string" &&
    Object.hasOwn(targets[to], (raw as { id: string }).id)
  );
}

/** What the dispatcher must do with `raw`: what a parse-once contract implies. */
async function checkDispatch(to: Target, raw: unknown): Promise<void> {
  const result = await dispatchOnce(to, raw);
  if (!isEnvelopeFor(raw, to)) {
    expect(result).toEqual({ claimed: undefined, reply: undefined, calls: [] });
    return;
  }
  const route = (targets[to] as Record<string, { payload: z.ZodType }>)[raw.id];
  if (!route) throw new Error("unreachable: isEnvelopeFor checked the id");
  const payload = (raw as { payload?: unknown }).payload;
  const parsed = route.payload.safeParse(payload);
  expect(result.claimed).toBe(true);
  if (parsed.success) {
    expect(result.calls).toEqual([{ id: raw.id, payload: parsed.data }]);
    expect(result.reply).toEqual({ ok: true, value: sampleOf(to, raw.id).result });
  } else {
    expect(result.calls).toEqual([]);
    expect(result.reply).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${to}.${raw.id}`),
    });
  }
}

beforeEach(() => {
  // Bad payloads are logged on purpose; the property produces thousands.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDispatcher under arbitrary wire input", () => {
  it("every sample request is accepted (control: the accepting branch is reachable)", async () => {
    for (const to of TARGETS) {
      for (const [id, sample] of Object.entries(samples[to])) {
        const result = await dispatchOnce(to, { to, id, payload: sample.payload });
        expect(result.claimed).toBe(true);
        expect(result.reply).toEqual({ ok: true, value: sample.result });
        expect(result.calls).toHaveLength(1);
      }
    }
  });

  it("an arbitrary value as the whole envelope never throws, is claimed only when addressed to a known route, and reaches a handler only parsed", async () => {
    await fc.assert(fc.asyncProperty(target, wireValue, checkDispatch), { numRuns: 300 });
  });

  it("a well-addressed envelope with an arbitrary payload: handler called with the parsed payload exactly when the schema admits it, failure reply otherwise", async () => {
    const envelope = target.chain((to) =>
      routeOf(to).chain((id) =>
        fc.record(
          { to: fc.constant(to), id: fc.constant(id), payload: payloadFor(to, id) },
          // Serialization drops an undefined payload, so the key may be absent.
          { requiredKeys: ["to", "id"] },
        ),
      ),
    );
    await fc.assert(
      fc.asyncProperty(target, envelope, async (listenerTarget, raw) => {
        await checkDispatch(listenerTarget, raw);
      }),
      { numRuns: 300 },
    );
  });

  it("an envelope addressed to another target or an unknown id is left alone by every dispatcher", async () => {
    const isRouteSomewhere = (id: string) => TARGETS.some((to) => Object.hasOwn(targets[to], id));
    const foreign = fc.oneof(
      // Right target, an id no table has (including prototype keys).
      fc.record({
        to: target,
        id: fc
          .oneof(
            fc.string(),
            fc.constantFrom("constructor", "__proto__", "toString", "hasOwnProperty"),
          )
          .filter((id) => !isRouteSomewhere(id)),
        payload: wireValue,
      }),
      // Unknown target, any id.
      fc.record({
        to: fc.string().filter((to) => !TARGETS.includes(to as Target)),
        id: fc.string(),
        payload: wireValue,
      }),
    );
    await fc.assert(
      fc.asyncProperty(target, foreign, async (to, raw) => {
        expect(await dispatchOnce(to, raw)).toEqual({
          claimed: undefined,
          reply: undefined,
          calls: [],
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe("call under arbitrary replies", () => {
  let reply: unknown;

  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.runtime.onMessage.addListener(
      (_message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
        sendResponse(reply);
        return true;
      },
    );
  });

  /** A reply: arbitrary JSON, or the success shape around an arbitrary value,
   *  or around the route's own sample result so the accepting branch runs. */
  const replyFor = (to: Target, id: RouteId<Target>) =>
    fc.oneof(
      { arbitrary: wireValue, weight: 2 },
      fc.record({ ok: fc.constant(true), value: wireValue }),
      fc.record({ ok: fc.constant(true) }),
      fc.record({ ok: fc.constant(false), error: wireValue }),
      fc.constant({ ok: true, value: sampleOf(to, id).result }),
      fc.constant({ ok: false, error: "Error: boom" }),
    );

  it("resolves exactly when the reply is a success whose value the result schema admits, and rejects with the schema's error, the failure, or a no-response error otherwise", async () => {
    const request = target.chain((to) =>
      routeOf(to).chain((id) => fc.tuple(fc.constant(to), fc.constant(id), replyFor(to, id))),
    );
    await fc.assert(
      fc.asyncProperty(request, async ([to, id, replyValue]) => {
        reply = replyValue;
        const route = (targets[to] as Record<string, { result: z.ZodType }>)[id];
        if (!route) throw new Error("unreachable: routeOf picked a table key");
        const payload = sampleOf(to, id).payload;
        const outcome = (call as (to: Target, id: string, ...args: unknown[]) => Promise<unknown>)(
          to,
          id,
          ...(payload === undefined ? [] : [payload]),
        );

        if (replyValue === undefined) {
          await expect(outcome).rejects.toThrow(`${to} did not respond to ${id}`);
          return;
        }
        const shape = z
          .discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), value: z.unknown().optional() }),
            z.object({ ok: z.literal(false), error: z.string() }),
          ])
          .safeParse(replyValue);
        if (!shape.success) {
          await expect(outcome).rejects.toBeInstanceOf(z.ZodError);
          return;
        }
        if (!shape.data.ok) {
          await expect(outcome).rejects.toBeInstanceOf(FailureReplyError);
          await expect(outcome).rejects.toThrow(shape.data.error);
          return;
        }
        const value = route.result.safeParse(shape.data.value);
        if (value.success) await expect(outcome).resolves.toEqual(value.data);
        else await expect(outcome).rejects.toBeInstanceOf(z.ZodError);
      }),
      { numRuns: 300 },
    );
  });
});
