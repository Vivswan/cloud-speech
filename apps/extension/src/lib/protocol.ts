import { z } from "zod";
import { browser } from "#imports";
import { ProviderValidationResultSchema } from "@/lib/provider-validation";
import { PROVIDER_IDS } from "@/providers/types";

// Every context listens on runtime.onMessage, so each envelope names its
// target and a dispatcher answers only its own, parsing the payload once with
// the route's schema. Handler maps are typed by their route table, so a
// missing or extra handler is a compile error.

export const ProviderIdSchema = z.enum(PROVIDER_IDS);

/** Where the audio session's main element stands after a command (a seek, a
 *  pause). For a seek while the source is still loading: the requested
 *  target floored at 0, with duration 0; the clamp to the duration waits for
 *  metadata. */
export const PositionSchema = z.object({
  currentTime: z.number(),
  duration: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

/** Stamped with the epoch of the play it belongs to. Defined here, not in
 *  lib/playback.ts: the offscreen document imports this module and may not
 *  touch extension storage. */
export const AudioPositionSchema = z.object({
  epoch: z.int().nonnegative(),
  currentTime: z.number().nonnegative(),
  duration: z.number().nonnegative(),
});

/** Title and message are localized plain words; `detail` is the technical
 *  reason. Every notice has both. */
export const ErrorPayloadSchema = z.object({
  title: z.string(),
  message: z.string(),
  /** For the collapsed Details view and bug reports: developer-grade English,
   *  never localized, never a credential. */
  detail: z.string(),
  /** The one link that fixes it. */
  action: z.object({ label: z.string(), url: z.string() }).optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

/** The page has no i18n runtime, and the browser's own message lookup answers
 *  in the browser's language rather than the chosen one, so the background
 *  resolves the toast's two control labels. */
export const ErrorToastSchema = ErrorPayloadSchema.extend({
  labels: z.object({ details: z.string(), dismiss: z.string() }),
});
export type ErrorToast = z.infer<typeof ErrorToastSchema>;

/** The provider the background attributed the failure to, so a bug report
 *  names the provider that failed, not the selected one. */
export const BackgroundErrorEventSchema = ErrorPayloadSchema.extend({
  providerId: ProviderIdSchema.optional(),
});
export type BackgroundErrorEvent = z.infer<typeof BackgroundErrorEventSchema>;

// --- Route tables ------------------------------------------------------------

const route = <P extends z.ZodType, R extends z.ZodType>(payload: P, result: R) => ({
  payload,
  result,
});
type Route = { payload: z.ZodType; result: z.ZodType };
type RouteTable = Record<string, Route>;
/** Constraint for generic table parameters: every key of `T` holds a Route.
 *  Unlike `RouteTable`, it carries no index signature, so a lookup by a key
 *  of `T` is a Route, never `Route | undefined`. */
type Routes<T> = { [K in keyof T]: Route };

const none = z.undefined();
const epochStamp = AudioPositionSchema.pick({ epoch: true });

export const backgroundRoutes = {
  fetchVoices: route(none, z.number()),
  validateProvider: route(
    z.object({
      providerId: ProviderIdSchema,
      credentials: z.record(z.string(), z.string()).optional(),
    }),
    ProviderValidationResultSchema,
  ),
  readAloud: route(z.object({ text: z.string(), speed: z.number().optional() }), z.boolean()),
  stopReading: route(none, z.boolean()),
  download: route(z.object({ text: z.string() }), z.boolean()),
  previewVoice: route(
    z.object({
      providerId: ProviderIdSchema,
      voiceId: z.string(),
      model: z.string(),
      language: z.string().optional(),
    }),
    z.boolean(),
  ),
  playerPause: route(none, z.boolean()),
  playerResume: route(none, z.boolean()),
  playerSeekTo: route(z.object({ seconds: z.number() }), z.boolean()),
  playerSetRate: route(z.object({ rate: z.number() }), z.boolean()),
  scanVoices: route(
    z.object({ providerId: ProviderIdSchema }),
    z.object({ familiesChecked: z.number(), familiesUnavailable: z.number() }),
  ),
  // Raised by the audio session while audio is loaded. Position events carry
  // the epoch of their play; the playback document rejects one that outlived
  // its read.
  keepalive: route(none, z.boolean()),
  audioProgress: route(AudioPositionSchema, z.boolean()),
  audioEnded: route(AudioPositionSchema, z.boolean()),
} satisfies RouteTable;

/** `play`/`resume` carry the epoch so the session can stamp its events;
 *  `play` may start at a parked position (a replay after the session's
 *  context was recycled). Seeks and pauses answer with the element's own
 *  position, so the transport records reality instead of re-deriving it.
 *
 *  seekTo while still loading  -> the requested target floored at 0, with duration 0; the element clamps it to the duration once metadata arrives
 *  pause before metadata       -> null; the caller keeps the position it holds
 */
export const audioRoutes = {
  play: route(
    epochStamp.extend({
      audioUri: z.string(),
      rate: z.number(),
      startAt: z.number().nonnegative().optional(),
    }),
    z.string(),
  ),
  stop: route(none, z.string()),
  pause: route(none, PositionSchema.nullable()),
  resume: route(epochStamp, z.string()),
  seekTo: route(z.object({ seconds: z.number() }), PositionSchema),
  setRate: route(z.object({ rate: z.number() }), z.string()),
  previewPlay: route(z.object({ audioUri: z.string() }), z.string()),
  previewStop: route(none, z.string()),
} satisfies RouteTable;

/** Pushed to the content script of the active tab. */
export const contentRoutes = {
  setError: route(ErrorToastSchema, z.void()),
} satisfies RouteTable;

/** Fire-and-forget. Playback and preview state live in storage.session
 *  (lib/playback.ts) and are watched, not pushed. */
export const popupEvents = {
  backgroundError: route(BackgroundErrorEventSchema, z.void()),
} satisfies RouteTable;

export const targets = {
  background: backgroundRoutes,
  audio: audioRoutes,
  content: contentRoutes,
  popup: popupEvents,
} as const;

export type Target = keyof typeof targets;
type RouteTables = typeof targets;
export type RouteId<T extends Target> = keyof RouteTables[T] & string;

/** Nothing when the payload schema is `undefined`, otherwise exactly one
 *  argument. Non-distributive on purpose: for a union of routes (a mock typed
 *  by a whole table) this is one tuple with a union payload, not a union of
 *  tuples, which a plain `(id) => ...` implementation could not satisfy. */
type RouteArgs<R> = [R] extends [Route]
  ? [z.input<R["payload"]>] extends [undefined]
    ? []
    : [z.input<R["payload"]>]
  : never;
type RoutePayload<R> = [R] extends [Route] ? z.input<R["payload"]> : never;
type RouteResult<R> = [R] extends [Route] ? z.output<R["result"]> : never;

export type PayloadArgs<T extends Target, K extends RouteId<T>> = RouteArgs<RouteTables[T][K]>;
export type Payload<T extends Target, K extends RouteId<T>> = RoutePayload<RouteTables[T][K]>;
export type Result<T extends Target, K extends RouteId<T>> = RouteResult<RouteTables[T][K]>;

type HandlerArgs<R> = [R] extends [Route]
  ? [z.output<R["payload"]>] extends [undefined]
    ? []
    : [z.output<R["payload"]>]
  : never;

export type Handlers<T extends Routes<T>> = {
  [K in keyof T]: (...args: HandlerArgs<T[K]>) => Promise<z.output<T[K]["result"]>>;
};

// --- Wire shapes ---------------------------------------------------------------

const EnvelopeSchema = z.object({
  to: z.string(),
  id: z.string(),
  // Serialization drops an undefined payload, so the key may be absent.
  payload: z.unknown().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** A handler failure must reach the caller as a rejection, never as a
 *  silent `undefined` response. */
const ReplySchema = z.discriminatedUnion("ok", [
  // Serialization drops an undefined value (a `void` route), so the key may
  // be absent.
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type Reply = z.infer<typeof ReplySchema>;

/** The target logged the failure, and the background surfaces its handler
 *  failures to the user (its quiet routes and refused payloads excepted), so
 *  a caller that reports failures itself reports only requests that got no
 *  such answer. */
export class FailureReplyError extends Error {
  override readonly name = "FailureReplyError";
}

function isRouteId<T extends Routes<T>>(routes: T, id: string): id is keyof T & string {
  return Object.hasOwn(routes, id);
}

/** The only widening in the protocol: `id` was matched against the table the
 *  handler map is typed by, so this handler accepts exactly what the route's
 *  payload schema produced. */
function handlerOf<T extends Routes<T>, K extends keyof T & string>(
  handlers: Handlers<T>,
  id: K,
): (payload: unknown) => Promise<RouteResult<T[K]>> {
  return handlers[id] as (payload: unknown) => Promise<RouteResult<T[K]>>;
}

function routeOf<T extends Target>(to: T, id: RouteId<T>): Route {
  // Widened for the lookup, so the "not found" arm exists only for the type
  // checker: typed callers can only name ids the table has.
  const table: RouteTable = targets[to];
  const found = table[id];
  if (!found) throw new Error(`Unknown ${to} route ${id}`);
  return found;
}

// --- Receiving side --------------------------------------------------------------

export interface DispatcherOptions<T extends Routes<T>> {
  /** Awaited before every handler (the background's bootstrap). A rejected
   *  gate fails the request like a handler failure would. */
  gate?: Promise<unknown>;
  /** Called after a handler (or the gate) rejected, before the failure reply
   *  is sent. Logging is built in; this is for surfacing to the user. */
  onError?: (id: keyof T & string, error: unknown) => void | Promise<void>;
}

/** Envelopes for other targets and unknown ids return `undefined`: claiming
 *  a foreign envelope with `true` would leave the browser (and the test
 *  double) waiting for a reply that never comes. */
export function createDispatcher<T extends Routes<T>>(
  target: Target,
  routes: T,
  handlers: Handlers<T>,
  options: DispatcherOptions<T> = {},
): (raw: unknown, sender: unknown, sendResponse: (reply: Reply) => void) => true | undefined {
  return (raw, _sender, sendResponse) => {
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.to !== target) return undefined;
    const { id, payload } = envelope.data;
    if (!isRouteId(routes, id)) return undefined;

    const parsed = routes[id].payload.safeParse(payload);
    if (!parsed.success) {
      const error = `${target}.${id} rejected its payload: ${z.prettifyError(parsed.error)}`;
      console.error(error);
      sendResponse({ ok: false, error });
      return true;
    }

    const handler = handlerOf(handlers, id);
    void (async () => {
      let reply: Reply;
      try {
        await options.gate;
        reply = { ok: true, value: await handler(parsed.data) };
      } catch (error) {
        console.error(`${target} handler ${id} failed`, error);
        try {
          await options.onError?.(id, error);
        } catch {
          // The failure reply must still go out.
        }
        reply = { ok: false, error: String(error) };
      }
      sendResponse(reply);
    })();
    return true;
  };
}

/** In-process, with the same parse-once contract as the wire: for Firefox's
 *  in-background audio session. */
export async function invoke<T extends Routes<T>, K extends keyof T & string>(
  routes: T,
  handlers: Handlers<T>,
  id: K,
  ...args: RouteArgs<T[K]>
): Promise<RouteResult<T[K]>> {
  return handlerOf(handlers, id)(routes[id].payload.parse(args[0]));
}

// --- Sending side ------------------------------------------------------------------

/** Rejects when the target did not answer, answered with a failure, or
 *  answered with a value outside the route's result schema. */
export async function call<T extends Target, K extends RouteId<T>>(
  to: T,
  id: K,
  ...args: PayloadArgs<T, K>
): Promise<Result<T, K>> {
  const envelope: Envelope = { to, id, payload: args[0] };
  const raw: unknown = await browser.runtime.sendMessage(envelope);
  if (raw === undefined) throw new Error(`${to} did not respond to ${id}`);
  const reply = ReplySchema.parse(raw);
  if (!reply.ok) throw new FailureReplyError(reply.error);
  // Wire boundary: the schema that produced this value is the route's own
  // result schema, so the parsed value is the route's result type.
  return routeOf(to, id).result.parse(reply.value) as Result<T, K>;
}

/** A stalled provider or a dropped response must not hang a popup state
 *  forever. Generous on purpose: long-text downloads legitimately take a
 *  while. */
const BACKGROUND_TIMEOUT_MS = 120_000;

export function sendToBackground<K extends RouteId<"background">>(
  id: K,
  ...args: PayloadArgs<"background", K>
): Promise<Result<"background", K>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${id} timed out after ${BACKGROUND_TIMEOUT_MS / 1000}s`)),
      BACKGROUND_TIMEOUT_MS,
    );
  });
  return Promise.race([call("background", id, ...args), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** Fire-and-forget. The receiver may be gone (popup closed, tab navigated
 *  away, no offscreen document), so delivery failures are swallowed. */
export function emit<T extends Target, K extends RouteId<T>>(
  to: T,
  id: K,
  payload: Payload<T, K>,
  options: { tabId?: number } = {},
): void {
  const envelope: Envelope = { to, id, payload };
  try {
    const delivery =
      options.tabId === undefined
        ? browser.runtime.sendMessage(envelope)
        : browser.tabs.sendMessage(options.tabId, envelope);
    delivery.catch(() => {});
  } catch {
    // A missing API (test double) fails synchronously; same outcome.
  }
}
