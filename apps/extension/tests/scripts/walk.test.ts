import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKIP_DIRS, walk } from "../../../../scripts/lib/walk.mts";

// What the check scripts rely on and the crawler does not promise by name: SKIP_DIRS pruned at every
// depth, symlinked directories walked and symlinked files kept, dot directories (.github) entered, an
// unreadable directory failing the scan, and one sorted order whatever the filesystem lists.

let root = "";

function put(relativePath: string): void {
  const path = join(root, relativePath);
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, "");
}

beforeAll(() => {
  root = fs.mkdtempSync(join(tmpdir(), "walk-"));
  try {
    put("zeta/deep/z.yml");
    put("b.yaml");
    put("kept/k.ts");
    put("a.yml");
    put("kept/j.tsx");
    put(".github/w.yml");
    put("notes.md");
    put("kept/notes.yaml.txt");
    for (const name of SKIP_DIRS) put(`${name}/hidden.yml`);
    put(`zeta/${[...SKIP_DIRS][0]}/hidden.ts`);
    fs.symlinkSync(join(root, "zeta"), join(root, "linked-dir"));
    fs.symlinkSync(join(root, "a.yml"), join(root, "linked.yml"));
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const paths = (options: Parameters<typeof walk>[1]) =>
  walk(root, options).map((path) => path.slice(root.length + 1));

const listingWith = (readdirSync: typeof fs.readdirSync) => ({ ...fs, readdirSync });

const YAML_FILES = [
  ".github/w.yml",
  "a.yml",
  "b.yaml",
  "linked-dir/deep/z.yml",
  "linked.yml",
  "zeta/deep/z.yml",
];

describe("repo walker", () => {
  it("returns the matching files sorted, skipping SKIP_DIRS at every depth", () => {
    expect(paths({ extensions: [".yml", ".yaml"] })).toEqual(YAML_FILES);
    expect(paths({ extensions: [".ts", ".tsx"] })).toEqual(["kept/j.tsx", "kept/k.ts"]);
    expect(paths({ extensions: [".json"] })).toEqual([]);
  });

  it("sorts entries itself instead of trusting the listing order", () => {
    // Every directory listed in descending order, so only the walker's own sort yields the ascending result.
    let listed = 0;
    const name = (entry: unknown) => String((entry as { name?: string }).name ?? entry);
    const descending = ((...args: Parameters<typeof fs.readdirSync>) => {
      listed++;
      return (fs.readdirSync(...args) as unknown[])
        .slice()
        .sort((a, b) => (name(a) < name(b) ? 1 : -1));
    }) as typeof fs.readdirSync;
    expect(paths({ extensions: [".yml", ".yaml"], fs: listingWith(descending) })).toEqual(
      YAML_FILES,
    );
    expect(listed).toBeGreaterThan(0);
  });

  it("leaves out excluded directories by absolute path", () => {
    expect(paths({ extensions: [".yml"], exclude: [join(root, "zeta")] })).toEqual([
      ".github/w.yml",
      "a.yml",
      "linked-dir/deep/z.yml",
      "linked.yml",
    ]);
  });

  it("throws on a directory it cannot read instead of scanning around it", () => {
    const denied = ((...args: Parameters<typeof fs.readdirSync>) => {
      if (
        String(args[0])
          .replace(/[\\/]+$/, "")
          .endsWith(".github")
      ) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return fs.readdirSync(...args);
    }) as typeof fs.readdirSync;
    expect(() => paths({ extensions: [".yml"], fs: listingWith(denied) })).toThrow(/EACCES/);
  });
});
