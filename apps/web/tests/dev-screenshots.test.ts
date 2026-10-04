import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_LOCALE } from "@cloud-speech/store-screenshots";
import { renderedScreenshotsHandler, setFile } from "../src/lib/dev-screenshots";

// The dev server stands in for the published store-screenshots branch (docs/store-listing.md): the URL layout
// it must mirror and the renderer's completion marker are facts outside this app that nothing else enforces.

describe("setFile", () => {
  test("serves a store locale's directory from that set", () => {
    expect(setFile("/store-screenshots/zh-CN/01-context-menu.jpg")).toEqual({
      locale: "zh-CN",
      name: "01-context-menu.jpg",
    });
    expect(setFile("/store-screenshots/hi/crops.json?v=2")).toEqual({
      locale: "hi",
      name: "crops.json",
    });
  });

  test("serves the root from the fallback set, the published branch's layout", () => {
    expect(setFile("/store-screenshots/01-context-menu-2x.jpg")).toEqual({
      locale: FALLBACK_LOCALE,
      name: "01-context-menu-2x.jpg",
    });
  });

  test.each([
    "/store-screenshots/fr/01-context-menu.jpg",
    "/store-screenshots/zh-cn/01-context-menu.jpg",
    "/store-screenshots/zh-CN/deeper/01-context-menu.jpg",
    "/store-screenshots/zh-CN/../01-context-menu.jpg",
    "/store-screenshots/../01-context-menu.jpg",
    "/store-screenshots/zh-CN/.hidden.jpg",
    "/store-screenshots/zh-CN/01-context-menu.png",
    "/store-screenshots/zh-CN/",
    "/store-screenshots/zh-CN",
    "/other/01-context-menu.jpg",
  ])("does not serve %s", (url) => {
    expect(setFile(url)).toBeUndefined();
  });
});

/** A local render holding the given sets (locale -> file name -> content), removed after the test. */
const renders: string[] = [];
afterEach(() => {
  for (const dir of renders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function render(sets: Record<string, Record<string, string | Uint8Array>>): string {
  const dir = mkdtempSync(join(tmpdir(), "cloud-speech-render-"));
  renders.push(dir);
  for (const [locale, files] of Object.entries(sets)) {
    mkdirSync(join(dir, locale));
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(dir, locale, name), content);
  }
  return dir;
}

/** The handler behind a real server, with Astro's place taken by a 404 that echoes the URL it was handed. */
async function served(renderDir: string, run: (origin: string) => Promise<void>): Promise<void> {
  const handler = renderedScreenshotsHandler(renderDir);
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 404;
      res.end(`astro: ${req.url}`);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const shape = async (res: Response) => ({
  status: res.status,
  type: res.headers.get("content-type"),
  length: res.headers.get("content-length"),
  cache: res.headers.get("cache-control"),
  body: new Uint8Array(await res.arrayBuffer()),
});

const jpg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9,
]);
const crops = '{"01-context-menu":{"left":0,"top":0,"width":1280,"height":800}}';

describe("renderedScreenshotsHandler", () => {
  test("a finished set's file comes with its type and length on GET and HEAD alike, the body on GET only", async () => {
    const dir = render({ en: { "01-context-menu.jpg": jpg, "crops.json": crops } });
    await served(dir, async (origin) => {
      for (const [path, type, bytes] of [
        ["/store-screenshots/01-context-menu.jpg", "image/jpeg", jpg],
        ["/store-screenshots/en/01-context-menu.jpg", "image/jpeg", jpg],
        ["/store-screenshots/en/crops.json", "application/json", new TextEncoder().encode(crops)],
      ] as const) {
        for (const method of ["GET", "HEAD"]) {
          const res = await fetch(`${origin}${path}`, { method });
          expect({ method, path, ...(await shape(res)) }).toEqual({
            method,
            path,
            status: 200,
            type,
            length: String(bytes.byteLength),
            cache: "no-store",
            body: method === "GET" ? bytes : new Uint8Array(),
          });
        }
      }
    });
  });

  test("a set is refused until its crops.json exists, then served on the next request without a restart", async () => {
    // An interrupted re-render: the English set finished, the Hindi one lost its marker before its first scene and
    // stopped after some. Its files would mix the new render with the previous one, so the page falls back.
    const dir = render({
      en: { "01-context-menu.jpg": jpg, "crops.json": crops },
      hi: { "01-context-menu.jpg": jpg },
    });
    await served(dir, async (origin) => {
      const gated = await fetch(`${origin}/store-screenshots/hi/01-context-menu.jpg`);
      expect([gated.status, await gated.text()]).toEqual([
        404,
        "astro: /store-screenshots/hi/01-context-menu.jpg",
      ]);

      writeFileSync(join(dir, "hi", "crops.json"), crops);
      const finished = await fetch(`${origin}/store-screenshots/hi/01-context-menu.jpg`);
      expect([finished.status, finished.headers.get("content-type")]).toEqual([200, "image/jpeg"]);

      // A finished set's missing file reaches Astro under the URL that was asked for, not the render's path.
      const missing = await fetch(`${origin}/store-screenshots/en/missing.jpg?v=2`);
      expect([missing.status, await missing.text()]).toEqual([
        404,
        "astro: /store-screenshots/en/missing.jpg?v=2",
      ]);
    });
  });
});
