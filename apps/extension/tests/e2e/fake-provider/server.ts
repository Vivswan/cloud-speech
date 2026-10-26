import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { silentMp3 } from "./mp3";

// A loopback stand-in for an OpenAI-compatible speech server, driven by the `custom` provider exactly like a real one.
// Provider replies can be held until the suite releases them, so a step can act (stop, supersede, press again) while requests are provably in flight.
//   well-formed /v1/audio/voices, /v1/audio/speech  -> recorded with whether the client let it finish; held while holdReplies() is on
//   /page, unknown routes, malformed bodies         -> answered at once, never recorded or held
//   a held reply whose client has gone              -> never written

type RequestOutcome =
  | { status: "pending" }
  | { status: "aborted" }
  | { status: "completed"; completedAt: number };

/** A request the server saw; the speech body fields are all empty on a voices request. */
export type RecordedRequest = {
  kind: "voices" | "speech";
  input: string;
  voice: string;
  model: string;
  responseFormat: string;
  authorization: string | undefined;
} & RequestOutcome;

/** Served at `<origin>/page` for scenes that need the content script on a tab (the error toast). */
const PAGE_HTML = "<!doctype html><title>Fake page</title><p>A page the extension runs on.</p>";

export interface FakeSpeechServer {
  /** `http://127.0.0.1:<port>`; the provider expects it with `/v1` appended, and `/page` serves a plain HTML page. */
  readonly origin: string;

  /** Seconds of audio in every successful speech reply. */
  audioSeconds: number;

  holdReplies(): void;

  releaseReplies(): void;

  /** HTTP status of speech replies; anything but 200 answers with an OpenAI style error envelope instead of audio. */
  speechStatus: number;

  /** Requests recorded after the marker; `since(server.mark())` scopes a step. */
  mark(): number;

  since(marker: number): RecordedRequest[];

  close(): Promise<void>;
}

const VOICES = ["alpha", "beta"];
export const DEFAULT_AUDIO_SECONDS = 12;

/** What the routes read and record; the returned server's setters and hold/release write it. */
interface ServerState {
  requests: RecordedRequest[];
  gate: { opened: Promise<void>; open: () => void } | null;
  audioSeconds: number;
  speechStatus: number;
}

/** One request as a route sees it: Node's pair beside the shared state. */
interface Exchange {
  state: ServerState;
  request: IncomingMessage;
  response: ServerResponse;
}

type Route = (exchange: Exchange) => Promise<void> | void;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function record(kind: RecordedRequest["kind"], request: IncomingMessage): RecordedRequest {
  return {
    kind,
    input: "",
    voice: "",
    model: "",
    responseFormat: "",
    authorization: request.headers.authorization,
    status: "pending",
  };
}

function speechRecord(request: IncomingMessage, body: Record<string, unknown>): RecordedRequest {
  const entry = record("speech", request);
  if (typeof body.input === "string") entry.input = body.input;
  if (typeof body.voice === "string") entry.voice = body.voice;
  if (typeof body.model === "string") entry.model = body.model;
  if (typeof body.response_format === "string") entry.responseFormat = body.response_format;
  return entry;
}

/** Resolves once the reply may go out: true to send it, false when the client went away first (nothing must be written then). */
function admitted(
  state: ServerState,
  response: ServerResponse,
  entry: RecordedRequest,
): Promise<boolean> {
  const held = state.gate?.opened ?? Promise.resolve();
  return new Promise((resolve) => {
    response.on("close", () => {
      if (!response.writableFinished) {
        Object.assign(entry, { status: "aborted" });
        resolve(false);
      }
    });
    void held.then(() => resolve(entry.status === "pending"));
  });
}

function servePage({ response }: Exchange): void {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(PAGE_HTML);
}

async function serveVoices({ state, request, response }: Exchange): Promise<void> {
  const entry = record("voices", request);
  state.requests.push(entry);
  if (!(await admitted(state, response, entry))) return;
  Object.assign(entry, { status: "completed", completedAt: Date.now() });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ voices: VOICES }));
}

async function serveSpeech({ state, request, response }: Exchange): Promise<void> {
  const body: Record<string, unknown> = JSON.parse(await readBody(request));
  const entry = speechRecord(request, body);
  state.requests.push(entry);
  if (!(await admitted(state, response, entry))) return;
  Object.assign(entry, { status: "completed", completedAt: Date.now() });

  if (state.speechStatus !== 200) {
    response.writeHead(state.speechStatus, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: `fake server answered ${state.speechStatus}` } }),
    );
    return;
  }

  response.writeHead(200, { "content-type": "audio/mpeg" });
  response.end(silentMp3(state.audioSeconds));
}

async function handle(exchange: Exchange): Promise<void> {
  const { request, response } = exchange;
  const url = new URL(request.url ?? "/", "http://localhost");
  const routes: Record<string, Route> = {
    "GET /page": servePage,
    "GET /v1/audio/voices": serveVoices,
    "POST /v1/audio/speech": serveSpeech,
  };

  const route = routes[`${request.method} ${url.pathname}`];
  if (route === undefined) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `No route for ${request.method} ${url.pathname}` }));
    return;
  }

  await route(exchange);
}

/** `port` 0 (the default) takes any free port; a suite that closes the server and brings it back at the address
 *  the extension already stores passes the port it had. */
export async function startFakeSpeechServer(port = 0): Promise<FakeSpeechServer> {
  const state: ServerState = {
    requests: [],
    gate: null,
    audioSeconds: DEFAULT_AUDIO_SECONDS,
    speechStatus: 200,
  };
  const sockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    handle({ state, request, response }).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${bound}`,
    get audioSeconds() {
      return state.audioSeconds;
    },
    set audioSeconds(value: number) {
      state.audioSeconds = value;
    },
    holdReplies() {
      if (state.gate) return;
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      state.gate = { opened, open };
    },
    releaseReplies() {
      state.gate?.open();
      state.gate = null;
    },
    get speechStatus() {
      return state.speechStatus;
    },
    set speechStatus(value: number) {
      state.speechStatus = value;
    },
    mark: () => state.requests.length,
    since: (marker) => state.requests.slice(marker),
    close: () =>
      new Promise<void>((resolve, reject) => {
        state.gate?.open();
        // Keep-alive connections would otherwise hold close() open until their idle timeout.
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
