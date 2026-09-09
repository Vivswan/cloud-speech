import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GITHUB_REPO_URL, SITE_LOCALES } from "@cloud-speech/constants";
import { afterEach, describe, expect, it } from "vitest";
import { completeSetFile, setFile } from "../../../web/src/lib/dev-screenshots";
import {
  FALLBACK_LOCALE,
  fullFile,
  RENDER_DIR,
  SCREENSHOT_SCENES,
  STORE_SCREENSHOTS_DIR,
  sceneSources,
  storeFile,
  storeScreenshotsBase,
} from "../../../web/src/lib/screenshot-source";
import { STORE_SCREENSHOTS_URL } from "../../../web/src/lib/site";
import { sampleCopy, sandboxText } from "../e2e/store-screenshots-copy";

// The walkthrough pages' image sources: the local render in `astro dev`, the
// published sets in every build (a build that pointed at the local copy would
// ship dead image URLs to GitHub Pages; check-links.mjs scans the built pages
// for that as well, this pins the decision itself), and per page the set of
// its own language with the English set at the root as the fallback.

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

describe("dev server: setFile", () => {
  const base = "/cloud-speech/";

  it("serves a store locale's directory from that set", () => {
    expect(setFile("/store-screenshots/zh-CN/01-context-menu.jpg", base)).toEqual({
      locale: "zh-CN",
      name: "01-context-menu.jpg",
    });
    expect(setFile(`${base}store-screenshots/hi/crops.json?v=2`, base)).toEqual({
      locale: "hi",
      name: "crops.json",
    });
  });

  it("serves the root from the fallback set, the published branch's layout", () => {
    expect(setFile("/store-screenshots/01-context-menu-2x.jpg", base)).toEqual({
      locale: FALLBACK_LOCALE,
      name: "01-context-menu-2x.jpg",
    });
  });

  it.each([
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
    expect(setFile(url, base)).toBeUndefined();
  });
});

describe("dev server: completeSetFile", () => {
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
  const file = { locale: "hi", name: "01-context-menu.jpg" } as const;

  it("serves a file of a set whose render finished (its crops.json exists)", () => {
    const dir = render();
    set(dir, "hi", ["01-context-menu.jpg", "crops.json"]);
    expect(completeSetFile(file, dir)).toBe(join(dir, "hi", "01-context-menu.jpg"));
  });

  it("serves nothing of a set mid-render or failed part-way, even a file that is there", () => {
    // An interrupted re-render: the English set finished, the Hindi one lost
    // its marker before its first scene and stopped after some. Its files
    // would mix the new render with the previous one, so the page falls back
    // to the English set instead.
    const dir = render();
    set(dir, "en", ["01-context-menu.jpg", "crops.json"]);
    set(dir, "hi", ["01-context-menu.jpg"]);
    expect(completeSetFile(file, dir)).toBeUndefined();
    expect(completeSetFile({ locale: "en", name: "01-context-menu.jpg" }, dir)).toBe(
      join(dir, "en", "01-context-menu.jpg"),
    );
  });
});
