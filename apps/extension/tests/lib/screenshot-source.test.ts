import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GITHUB_REPO_URL } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";
import {
  fullFile,
  RENDER_DIR,
  SCREENSHOT_SCENES,
  STORE_SCREENSHOTS_DIR,
  storeFile,
  storeScreenshotsBase,
} from "../../../web/src/lib/screenshot-source";
import { STORE_SCREENSHOTS_URL } from "../../../web/src/lib/site";

// The walkthrough page's image prefix: the local render in `astro dev`, the
// published set in every build. A build that pointed at the local copy would
// ship dead image URLs to GitHub Pages; check-links.mjs scans the built pages
// for that as well, this pins the decision itself.

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
