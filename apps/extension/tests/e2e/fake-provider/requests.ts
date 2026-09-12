import { expect } from "@playwright/test";
import type { FakeSpeechServer, RecordedRequest } from "./server";

// Queries over what the fake server recorded since a marker, shared by every
// suite that drives the `custom` provider against it. Voice discovery is left
// out of the synthesis views: every popup mount refreshes the voice list.

export function speechSince(server: FakeSpeechServer, marker: number): RecordedRequest[] {
  return server.since(marker).filter((r) => r.kind === "speech");
}

export function statusesSince(server: FakeSpeechServer, marker: number): string[] {
  return speechSince(server, marker).map((r) => r.status);
}

/** The synthesis inputs since the marker, order-insensitive: the provider
 *  chunks per sentence and two concurrent chunk requests arrive in either
 *  order. */
export function inputsSince(server: FakeSpeechServer, marker: number): string[] {
  return speechSince(server, marker)
    .map((r) => r.input)
    .sort();
}

export function targetsSince(
  server: FakeSpeechServer,
  marker: number,
): Array<{ voice: string; model: string }> {
  return speechSince(server, marker).map(({ voice, model }) => ({ voice, model }));
}

/** Wait until the server holds exactly `count` synthesis requests since the
 *  marker, none answered: the point at which a cancellation is observable. */
export async function pendingSpeech(
  server: FakeSpeechServer,
  marker: number,
  count: number,
): Promise<void> {
  await expect
    .poll(() => statusesSince(server, marker), {
      message: `${count} synthesis requests in flight`,
    })
    .toEqual(Array<string>(count).fill("pending"));
}
