import type { contentRoutes, Envelope, ErrorPayload, Handlers, Reply, RouteId } from "./protocol";

// The content script is injected into every page, so it must not load the
// protocol registry (Zod plus every route table). This is the registry's
// `content` target hand-checked: the same wire types, guarded by plain type
// predicates. The types come from the registry; tests/lib/protocol-content
// holds the guards to the registry's schemas, value for value.

const target = "content" satisfies Envelope["to"];
const setError = "setError" satisfies RouteId<typeof target>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isEnvelope(value: unknown): value is Envelope {
  return isRecord(value) && typeof value.to === "string" && typeof value.id === "string";
}

function isAction(value: unknown): value is ErrorPayload["action"] {
  if (value === undefined) return true;
  return isRecord(value) && typeof value.label === "string" && typeof value.url === "string";
}

export function isErrorPayload(value: unknown): value is ErrorPayload {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.message === "string" &&
    typeof value.detail === "string" &&
    isAction(value.action)
  );
}

/** A runtime.onMessage listener for the content target, with the same
 *  contract as `createDispatcher`: foreign envelopes and unknown ids stay
 *  unclaimed, a payload the guard refuses is a failure reply, a handler
 *  failure reaches the sender as a rejection. */
export function createContentDispatcher(
  handlers: Handlers<typeof contentRoutes>,
): (raw: unknown, sender: unknown, sendResponse: (reply: Reply) => void) => true | undefined {
  return (raw, _sender, sendResponse) => {
    if (!isEnvelope(raw) || raw.to !== target || raw.id !== setError) return undefined;
    if (!isErrorPayload(raw.payload)) {
      const error = `${target}.${setError} rejected its payload`;
      console.error(error);
      sendResponse({ ok: false, error });
      return true;
    }
    // Zod strips unknown keys and keeps a present-but-undefined optional; the
    // handler must see the same object either way.
    const { title, message, detail, action } = raw.payload;
    const payload: ErrorPayload = { title, message, detail };
    if ("action" in raw.payload)
      payload.action = action && { label: action.label, url: action.url };
    handlers.setError(payload).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => {
        console.error(`${target} handler ${setError} failed`, error);
        sendResponse({ ok: false, error: String(error) });
      },
    );
    return true;
  };
}
