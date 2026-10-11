import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITE_LOCALES } from "@cloud-speech/constants";
import {
  FALLBACK_LOCALE,
  hasLocalRender,
  STORE_SCREENSHOTS_DIR,
  STORE_SCREENSHOTS_URL,
  sceneSources,
  storeScreenshotsBase,
} from "@cloud-speech/store-screenshots";
import { afterEach, describe, expect, it } from "vitest";
import { sampleCopy } from "../e2e/store-screenshots-copy";

// A build that pointed at the local render would ship dead image URLs to GitHub Pages; check-links.mts scans
// the built pages for that as well, this pins the decision itself.

describe("storeScreenshotsBase", () => {
  const base = "/cloud-speech/";
  const local = `${base}${STORE_SCREENSHOTS_DIR}/`;

  it.each([
    { dev: true, rendered: true, expected: local },
    { dev: true, rendered: false, expected: STORE_SCREENSHOTS_URL },
    { dev: false, rendered: true, expected: STORE_SCREENSHOTS_URL },
    { dev: false, rendered: false, expected: STORE_SCREENSHOTS_URL },
  ])("dev=$dev rendered=$rendered -> $expected", ({ dev, rendered, expected }) => {
    expect(storeScreenshotsBase({ dev, rendered, base })).toBe(expected);
  });
});

describe("sampleCopy", () => {
  // contextMenuScene fills the browser's search item with the selection through this placeholder.
  it.each(SITE_LOCALES.map((locale) => locale.extensionId))(
    "keeps the $1 placeholder in the browser menu's search item in %s",
    (locale) => {
      expect(sampleCopy(locale).menu.search).toContain("$1");
    },
  );
});

describe("sceneSources", () => {
  const base = "https://example.test/sets/";

  // Every shipped locale, English included: its own directory first, the
  // root (the English set again) as the fallback.
  it.each(SITE_LOCALES.map((locale) => locale.storeLocale))(
    "loads a %s page's set from its directory, the root as the fallback",
    (locale) => {
      expect(sceneSources(base, locale, "02-preferences-voice-picker")).toEqual({
        primary: {
          store: `${base}${locale}/02-preferences-voice-picker.jpg`,
          full: `${base}${locale}/02-preferences-voice-picker-2x.jpg`,
        },
        fallback: {
          store: `${base}02-preferences-voice-picker.jpg`,
          full: `${base}02-preferences-voice-picker-2x.jpg`,
        },
      });
    },
  );
});

/** A local render directory with the given sets in it, removed after the test. */
const renders: string[] = [];
const render = () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-speech-render-"));
  renders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of renders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const set = (dir: string, locale: string, files: string[]) => {
  mkdirSync(join(dir, locale));
  for (const file of files) writeFileSync(join(dir, locale, file), "");
};

describe("hasLocalRender", () => {
  it("is true for a page whose own set finished, whatever the others did", () => {
    // `bun run screenshots:store -- --project=hi` rendered one set.
    const dir = render();
    set(dir, "hi", ["crops.json"]);
    expect(hasLocalRender("hi", dir)).toBe(true);
    expect(hasLocalRender("zh-CN", dir)).toBe(false);
  });

  it("is true for every page once the fallback set finished", () => {
    const dir = render();
    set(dir, FALLBACK_LOCALE, ["crops.json"]);
    for (const locale of SITE_LOCALES) expect(hasLocalRender(locale.storeLocale, dir)).toBe(true);
  });

  it("is false while no set has finished, even with files on disk", () => {
    const dir = render();
    set(dir, "hi", ["01-context-menu.jpg"]);
    expect(hasLocalRender("hi", dir)).toBe(false);
  });
});
