import { describe, expect, it } from "vitest";
import { type AudioFormat, type AudioFormats, effectiveFormat } from "@/providers/types";

const MP3: AudioFormat = {
  id: "MP3",
  label: "MP3",
  mimeType: "audio/mpeg",
  extension: "mp3",
  stitchable: true,
  forDownload: true,
  forReadAloud: true,
};

const OGG: AudioFormat = {
  id: "OGG_OPUS",
  label: "Ogg Opus",
  mimeType: "audio/ogg",
  extension: "ogg",
  stitchable: false,
  forDownload: false,
  forReadAloud: true,
};

const FORMATS: AudioFormats = [MP3, OGG];

describe("effectiveFormat", () => {
  it("returns the requested format for a single chunk, stitchable or not", () => {
    expect(effectiveFormat(FORMATS, "OGG_OPUS", 1)).toBe(OGG);
    expect(effectiveFormat(FORMATS, "MP3", 1)).toBe(MP3);
  });

  it("keeps a stitchable format across multiple chunks", () => {
    expect(effectiveFormat(FORMATS, "MP3", 5)).toBe(MP3);
  });

  it("swaps a non-stitchable format for a same-purpose stitchable one on multi-chunk", () => {
    // OGG is read-aloud only; MP3 serves read-aloud too and byte-concats safely.
    expect(effectiveFormat(FORMATS, "OGG_OPUS", 2)).toBe(MP3);
  });

  it("requires the alternative to cover every purpose of the requested format", () => {
    const downloadOnlyMp3: AudioFormat = { ...MP3, forReadAloud: false };
    // No stitchable format covers read-aloud, so fall back to the request.
    expect(effectiveFormat([downloadOnlyMp3, OGG], "OGG_OPUS", 2)).toBe(OGG);
  });

  it("falls back to the requested format when nothing stitchable exists", () => {
    expect(effectiveFormat([OGG], "OGG_OPUS", 3)).toBe(OGG);
  });

  it("treats an unknown requested id as the provider's first format", () => {
    expect(effectiveFormat(FORMATS, "NOPE", 1)).toBe(MP3);
    expect(effectiveFormat(FORMATS, "NOPE", 4)).toBe(MP3);
  });

  it("every registered provider declares only honestly stitchable formats", async () => {
    // Ogg/WebM containers and WAV (its header) never byte-concatenate cleanly; MP3 frame streams do.
    // OGG downloads shipped once and had to be rolled back, so OGG_OPUS is also pinned read-aloud only.
    const containers = new Set(["audio/ogg", "audio/webm", "audio/wav", "audio/x-wav"]);
    const { providerList } = await import("@/providers");
    for (const provider of providerList) {
      for (const format of provider.audioFormats) {
        const where = `${provider.id} ${format.id}`;
        const ogg = format.id === "OGG_OPUS";
        if (ogg || containers.has(format.mimeType)) expect(format.stitchable, where).toBe(false);
        if (ogg) expect(format.forDownload, `${where} forDownload`).toBe(false);
      }
    }
  });
});
