import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { silentMp3 } from "./mp3";

// A local stand-in for an OpenAI-compatible speech server, driven by the
// `custom` provider exactly like a real one: voice discovery on
// GET /v1/audio/voices, synthesis on POST /v1/audio/speech. It records every
// request and whether the client let it finish, and it can hold every reply
// until the suite releases it, so a step can act (stop, supersede, press
// again) while requests are provably still in flight. Loopback only.

/** How a request ended: still open, the client closed the connection before
 *  the reply went out, or the reply was written (stamped with Date.now()). */
export type RequestOutcome =
  | { status: "pending" }
  | { status: "aborted" }
  | { status: "completed"; completedAt: number };

export type RecordedRequest = {
  kind: "voices" | "speech";
  /** The `input` field of a speech request. */
  input: string;
  responseFormat: string;
  authorization: string | undefined;
} & RequestOutcome;

export interface FakeSpeechServer {
  /** `http://127.0.0.1:<port>`; the provider expects it with `/v1` appended. */
  readonly origin: string;
  /** Seconds of audio in every successful speech reply. */
  audioSeconds: number;
  /** Keep every reply (current and future) waiting until releaseReplies(). */
  holdReplies(): void;
  releaseReplies(): void;
  /** HTTP status of speech replies; anything but 200 answers with an OpenAI
   *  style error envelope instead of audio. */
  speechStatus: number;
  /** Requests recorded after the marker; `since(server.mark())` scopes a step. */
  mark(): number;
  since(marker: number): RecordedRequest[];
  close(): Promise<void>;
}

const VOICES = ["alpha", "beta"];
export const DEFAULT_AUDIO_SECONDS = 12;

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
    responseFormat: "",
    authorization: request.headers.authorization,
    status: "pending",
  };
}

export async function startFakeSpeechServer(): Promise<FakeSpeechServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let audioSeconds = DEFAULT_AUDIO_SECONDS;
  let gate: { opened: Promise<void>; open: () => void } | null = null;
  let speechStatus = 200;

  /** Resolves once the reply may go out: true to send it, false when the
   *  client went away first (nothing must be written then). */
  function admitted(response: ServerResponse, entry: RecordedRequest): Promise<boolean> {
    const held = gate?.opened ?? Promise.resolve();
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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/audio/voices") {
      const entry = record("voices", request);
      requests.push(entry);
      if (!(await admitted(response, entry))) return;
      Object.assign(entry, { status: "completed", completedAt: Date.now() });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ voices: VOICES }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/audio/speech") {
      const body: Record<string, unknown> = JSON.parse(await readBody(request));
      const entry = record("speech", request);
      if (typeof body.input === "string") entry.input = body.input;
      if (typeof body.response_format === "string") entry.responseFormat = body.response_format;
      requests.push(entry);
      if (!(await admitted(response, entry))) return;
      Object.assign(entry, { status: "completed", completedAt: Date.now() });
      if (speechStatus !== 200) {
        response.writeHead(speechStatus, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: `fake server answered ${speechStatus}` } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "audio/mpeg" });
      response.end(silentMp3(audioSeconds));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `No route for ${request.method} ${url.pathname}` }));
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    get audioSeconds() {
      return audioSeconds;
    },
    set audioSeconds(value: number) {
      audioSeconds = value;
    },
    holdReplies() {
      if (gate) return;
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      gate = { opened, open };
    },
    releaseReplies() {
      gate?.open();
      gate = null;
    },
    get speechStatus() {
      return speechStatus;
    },
    set speechStatus(value: number) {
      speechStatus = value;
    },
    mark: () => requests.length,
    since: (marker) => requests.slice(marker),
    close: () =>
      new Promise<void>((resolve, reject) => {
        gate?.open();
        // Keep-alive connections would otherwise hold close() open until
        // their idle timeout.
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
