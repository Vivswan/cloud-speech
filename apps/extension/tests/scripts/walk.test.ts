import {
  mkdirSync,
  mkdtempSync,
  type PathLike,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SKIP_DIRS, walk } from "../../../../scripts/lib/walk.mts";

// One spy on readdirSync so a test can control the listing order (APFS already
// lists sorted). It sits on the named and the default export: Vite's DOM
// environment transform reads builtin named imports through `default`.
vi.mock("node:fs", async (importOriginal) => {
  type Fs = typeof import("node:fs");
  const actual = await importOriginal<Fs & { default: Fs }>();
  const readdirSync = vi.fn(actual.readdirSync);
  return { ...actual, readdirSync, default: { ...actual.default, readdirSync } };
});

let root = "";

function put(relativePath: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "walk-"));
  try {
    put("zeta/deep/z.yml");
    put("b.yaml");
    put("kept/k.ts");
    put("a.yml");
    put("kept/j.tsx");
    put("notes.md");
    put("kept/notes.yaml.txt");
    for (const name of SKIP_DIRS) put(`${name}/hidden.yml`);
    put(`zeta/${[...SKIP_DIRS][0]}/hidden.ts`);
    symlinkSync(join(root, "zeta"), join(root, "linked-dir"));
    symlinkSync(join(root, "a.yml"), join(root, "linked.yml"));
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const paths = (options: Parameters<typeof walk>[1]) =>
  [...walk(root, options)].map((path) => path.slice(root.length + 1));

describe("repo walker", () => {
  it("yields the matching files, skipping SKIP_DIRS at every depth", () => {
    expect(paths({ extensions: [".yml", ".yaml"] })).toEqual([
      "a.yml",
      "b.yaml",
      "linked-dir/deep/z.yml",
      "linked.yml",
      "zeta/deep/z.yml",
    ]);
    expect(paths({ extensions: [".ts", ".tsx"] })).toEqual(["kept/j.tsx", "kept/k.ts"]);
  });

  it("sorts entries itself instead of trusting the listing order", async () => {
    // Every directory is listed in reverse-sorted order, which no filesystem
    // hands back sorted; only the walker's own sort can produce the order
    // below. The call-count check proves the walker read through the mock.
    const { readdirSync: list } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const listing = vi.mocked<(path: PathLike) => string[]>(readdirSync);
    listing.mockClear();
    listing.mockImplementation((path) => list(path).sort().reverse());
    try {
      expect(paths({ extensions: [".yml", ".yaml"] })).toEqual([
        "a.yml",
        "b.yaml",
        "linked-dir/deep/z.yml",
        "linked.yml",
        "zeta/deep/z.yml",
      ]);
      expect(listing).toHaveBeenCalled();
    } finally {
      listing.mockImplementation(list);
    }
  });

  it("leaves out excluded directories by absolute path", () => {
    expect(paths({ extensions: [".yml"], exclude: [join(root, "zeta")] })).toEqual([
      "a.yml",
      "linked-dir/deep/z.yml",
      "linked.yml",
    ]);
  });

  it("yields nothing when no file carries a listed extension", () => {
    expect(paths({ extensions: [".json"] })).toEqual([]);
  });
});
