import { GITHUB_REPO_URL } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";
import {
  STORE_SCREENSHOTS_DIR,
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

  it("publishes from the repository's store-screenshots branch on raw.githubusercontent.com", () => {
    const repoPath = new URL(GITHUB_REPO_URL).pathname;
    expect(STORE_SCREENSHOTS_URL).toBe(
      `https://raw.githubusercontent.com${repoPath}/${STORE_SCREENSHOTS_DIR}/`,
    );
  });
});
