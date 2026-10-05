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

// The module has no seam for a failing rename, so node:fs is passed through with one switchable
// renameSync.
let failRename = false;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (failRename)
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return actual.renameSync(...args);
    },
  };
});

// Chrome rewrites Default/Preferences while it runs and on exit, so the Developer-mode cleanup must
// never write while a browser holds the profile.
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
    failRename = false;
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

  it("keeps Preferences byte-identical and removes the staging file when the rename fails", async () => {
    const original = JSON.stringify({ extensions: { ui: { developer_mode: true } } });
    writeFileSync(prefsFile, original);
    fakeProcessTools(1);
    failRename = true;

    await reclaimChromeProfile(profile, logger);

    expect(readFileSync(prefsFile, "utf8")).toBe(original);
    expect(existsSync(`${prefsFile}.cloud-speech`)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("Could not clean the dev profile's Preferences:");
  });
});
