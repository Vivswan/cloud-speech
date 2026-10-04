import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GITHUB_REPO_URL, SITE_LOCALES } from "@cloud-speech/constants";
import {
  FALLBACK_LOCALE,
  fullFile,
  hasLocalRender,
  RENDER_DIR,
  SCREENSHOT_SCENES,
  STORE_SCREENSHOTS_DIR,
  STORE_SCREENSHOTS_URL,
  sceneSources,
  storeFile,
  storeScreenshotsBase,
} from "@cloud-speech/store-screenshots";
import { afterEach, describe, expect, it } from "vitest";
import { sampleCopy, sandboxText } from "../e2e/store-screenshots-copy";

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

  it("names the renderer's two files per scene", () => {
    expect(storeFile("01-context-menu")).toBe("01-context-menu.jpg");
    expect(fullFile("01-context-menu")).toBe("01-context-menu-2x.jpg");
  });

  it("serves the renderer's output directory", () => {
    expect(RENDER_DIR).toBe(resolve(__dirname, "../../.output", STORE_SCREENSHOTS_DIR));
  });

  it("lists exactly the scenes the renderer captures", () => {
    // Each scene is named once where it is captured: `capturePopup(page, "<scene>"`
    // or `writeScene("<scene>"` (the drawn context-menu scene), the call
    // written on one line or wrapped.
    const renderer = readFileSync(resolve(__dirname, "../e2e/store-screenshots.ts"), "utf8");
    const captured = [
      ...renderer.matchAll(/(?:capturePopup\(\s*page,|writeScene\()\s*"(\d\d-[a-z-]+)"/g),
    ]
      .map((match) => match[1])
      .sort();
    expect(captured.length).toBeGreaterThan(0);
    expect([...SCREENSHOT_SCENES].sort()).toEqual(captured);
  });

  it("publishes from the repository's store-screenshots branch on raw.githubusercontent.com", () => {
    const repoPath = new URL(GITHUB_REPO_URL).pathname;
    expect(STORE_SCREENSHOTS_URL).toBe(
      `https://raw.githubusercontent.com${repoPath}/${STORE_SCREENSHOTS_DIR}/`,
    );
  });
});

describe("sampleCopy", () => {
  it.each(SITE_LOCALES.map((locale) => locale.extensionId))(
    "has the article, the browser menu, and a Sandbox passage in %s",
    (locale) => {
      const copy = sampleCopy(locale);
      expect(copy.article.selected.length).toBeGreaterThan(0);
      expect(copy.menu.search).toContain("$1");
      expect(sandboxText(copy)).toContain(copy.article.selected);
    },
  );
});

describe("sceneSources", () => {
  const base = "https://example.test/sets/";

  it("falls back to English, the set at the root", () => {
    expect(FALLBACK_LOCALE).toBe("en");
    expect(SITE_LOCALES[0].storeLocale).toBe(FALLBACK_LOCALE);
  });

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
