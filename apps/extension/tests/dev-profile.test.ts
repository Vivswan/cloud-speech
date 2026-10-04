// @vitest-environment node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reclaimChromeProfile } from "../dev-profile";

// Chrome rewrites Default/Preferences while it runs and on exit, so the Developer-mode cleanup must
// never write while a browser holds the profile. pgrep and pkill are faked on PATH: pgrep exit 0 means
// a process holds the profile, exit 1 means none does.
describe("reclaimChromeProfile", () => {
  let scratch: string;
  let profile: string;
  let prefsFile: string;
  const originalPath = process.env.PATH;
  const logger = { info: vi.fn(), warn: vi.fn() };

  const fakeProcessTools = (pgrepExit: number): void => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    for (const [name, exit] of [
      ["pgrep", pgrepExit],
      ["pkill", 0],
    ] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\nexit ${exit}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}:${originalPath}`;
  };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dev-profile-"));
    profile = join(scratch, "profile");
    prefsFile = join(profile, "Default/Preferences");
    mkdirSync(join(profile, "Default"), { recursive: true });
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("leaves Preferences untouched while a browser still holds the profile", async () => {
    const original = JSON.stringify({ extensions: { ui: { developer_mode: true } } });
    writeFileSync(prefsFile, original);
    fakeProcessTools(0);

    await reclaimChromeProfile(profile, logger);

    expect(readFileSync(prefsFile, "utf8")).toBe(original);
    expect(existsSync(`${prefsFile}.cloud-speech`)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "A browser still holds the dev profile; its Preferences are left alone.",
    );
  }, 10_000);

  it("removes the developer_mode copy once the profile is free, leaving no staging file", async () => {
    writeFileSync(
      prefsFile,
      JSON.stringify({ extensions: { ui: { developer_mode: true, other: 1 } }, keep: true }),
    );
    fakeProcessTools(1);

    await reclaimChromeProfile(profile, logger);

    expect(JSON.parse(readFileSync(prefsFile, "utf8"))).toEqual({
      extensions: { ui: { other: 1 } },
      keep: true,
    });
    expect(existsSync(`${prefsFile}.cloud-speech`)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
