import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKIP_DIRS, walk } from "../../../../scripts/lib/walk.mts";

// The exact arrays below also pin the sorted order: on a filesystem that lists
// directories unsorted (ext4), a walker without its own sort fails them.
let root = "";

function put(relativePath: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "walk-"));
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
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const paths = (options: Parameters<typeof walk>[1]) =>
  [...walk(root, options)].map((path) => path.slice(root.length + 1));

describe("repo walker", () => {
  it("yields the matching files in sorted order, skipping SKIP_DIRS at every depth", () => {
    expect(paths({ extensions: [".yml", ".yaml"] })).toEqual([
      "a.yml",
      "b.yaml",
      "linked-dir/deep/z.yml",
      "linked.yml",
      "zeta/deep/z.yml",
    ]);
    expect(paths({ extensions: [".ts", ".tsx"] })).toEqual(["kept/j.tsx", "kept/k.ts"]);
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
