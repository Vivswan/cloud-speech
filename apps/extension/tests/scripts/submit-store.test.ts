import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { STORES, type StoreId, submitStore } from "../../../../scripts/submit-store.mts";

const ROOT = resolve(__dirname, "../../../..");
const WORKFLOW = ".github/workflows/update-release.yml";
const SCRIPT = join(ROOT, "scripts/submit-store.mts");
const VERSION = "2.0.0";

function fixture(zips: readonly string[] | null): string {
  const root = mkdtempSync(join(tmpdir(), "submit-store-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: VERSION }));
  if (zips !== null) {
    const outDir = join(root, "apps/extension/.output");
    mkdirSync(outDir, { recursive: true });
    for (const name of zips) writeFileSync(join(outDir, name), "zip");
  }
  return root;
}

function recorder(status: number) {
  const calls: { args: string[]; cwd: string }[] = [];
  const run = (args: string[], cwd: string): number => {
    calls.push({ args, cwd });
    return status;
  };
  return { calls, run };
}

const secretsFor = (store: StoreId): Record<string, string> =>
  Object.fromEntries(STORES[store].env.map((name) => [name, `${name}-value`]));

// The command line and the notice are what leave the script: the one reaches publish-browser-extension
// (wxt submit), the other the release run's log.
const CASES: { store: StoreId; zips: string[]; args: string[]; notice: string }[] = [
  {
    store: "chrome",
    zips: [`cloud-speech-${VERSION}-chrome.zip`],
    args: ["wxt", "submit", "--chrome-zip", `.output/cloud-speech-${VERSION}-chrome.zip`],
    notice: "CWS_* secrets not fully configured; zips attached to the GitHub release only.",
  },
  {
    store: "firefox",
    zips: [`cloud-speech-${VERSION}-firefox.zip`, `cloud-speech-${VERSION}-firefox-sources.zip`],
    args: [
      "wxt",
      "submit",
      "--firefox-zip",
      `.output/cloud-speech-${VERSION}-firefox.zip`,
      "--firefox-sources-zip",
      `.output/cloud-speech-${VERSION}-firefox-sources.zip`,
    ],
    notice: "AMO_* secrets not configured; firefox zip attached to the GitHub release only.",
  },
];

describe.each(CASES)("submit-store $store", ({ store, zips, args, notice }) => {
  it("submits this version's zip(s) from apps/extension and hands back wxt's exit status", () => {
    const root = fixture(zips);
    try {
      const { calls, run } = recorder(3);
      expect(submitStore(store, { root, env: secretsFor(store), run })).toEqual({
        kind: "ran",
        status: 3,
      });
      expect(calls).toEqual([{ args, cwd: join(root, "apps/extension") }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // GitHub renders an absent secret as the empty string, so empty is the shape the release job sees.
  // The decision comes before any zip is looked for: a checkout without a build still gets the notice.
  it.each(STORES[store].env)(
    "skips with the notice and submits nothing when %s is empty",
    (name) => {
      const root = fixture(null);
      try {
        const { calls, run } = recorder(0);
        const env = { ...secretsFor(store), [name]: "" };
        expect(submitStore(store, { root, env, run })).toEqual({
          kind: "skipped",
          notice,
          missing: [name],
        });
        expect(calls).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("names every empty variable when none is set", () => {
    const root = fixture(null);
    try {
      const { calls, run } = recorder(0);
      expect(submitStore(store, { root, env: {}, run })).toEqual({
        kind: "skipped",
        notice,
        missing: [...STORES[store].env],
      });
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const [first] = zips;
  const suffix = first?.slice(first.indexOf(`-${VERSION}`)) ?? "";
  it.each([
    ["no zip matches", [], 0, ""],
    ["two zips match", [...zips, `other${suffix}`], 2, `: ${first}, other${suffix}`],
  ])("fails before submitting when %s", (_label, present, count, named) => {
    const root = fixture(present);
    try {
      const { calls, run } = recorder(0);
      const outDir = join(root, "apps/extension/.output");
      expect(() => submitStore(store, { root, env: secretsFor(store), run })).toThrow(
        `expected exactly one *${suffix} in ${outDir}, found ${count}${named}`,
      );
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails before submitting when the build output directory is missing", () => {
    const root = fixture(null);
    try {
      const { calls, run } = recorder(0);
      expect(() => submitStore(store, { root, env: secretsFor(store), run })).toThrow(
        `${join(root, "apps/extension/.output")} is missing; run the store builds first`,
      );
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the release workflow", () => {
  // The workflow sets the variables from secrets and the script reads them by name. A renamed variable
  // on either side would leave the script seeing an empty value: a notice, a green job, and no upload.
  it("sets exactly the variables each store's submit reads", () => {
    const doc = parse(readFileSync(join(ROOT, WORKFLOW), "utf8")) as {
      jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>;
    };
    const submits = new Map<string, string[]>();
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps) {
        const match = /^bun scripts\/submit-store\.mts (\S+)$/.exec(step.run ?? "");
        if (match?.[1] !== undefined) submits.set(match[1], Object.keys(step.env ?? {}).sort());
      }
    }
    expect(Object.fromEntries(submits)).toEqual(
      Object.fromEntries(
        Object.entries(STORES).map(([store, { env }]) => [store, [...env].sort()]),
      ),
    );
  });
});

describe("the command line", () => {
  const cli = (store: string, env: NodeJS.ProcessEnv) =>
    spawnSync("bun", [SCRIPT, store], { cwd: ROOT, env, encoding: "utf8" });

  // The step reads the notice from stdout and the exit status from the process. The environment here
  // carries none of the store variables, so nothing can be uploaded.
  it("prints the notice to stdout and exits 0 without the secrets", () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !STORES.chrome.env.includes(name)),
    );
    const result = cli("chrome", env);
    expect({ status: result.status, stdout: result.stdout }).toEqual({
      status: 0,
      stdout:
        "::notice::CWS_* secrets not fully configured; zips attached to the GitHub release only.\n" +
        "empty: CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN, CHROME_EXTENSION_ID\n",
    });
  });

  it("refuses a store it does not know with exit 2", () => {
    const result = cli("edge", process.env);
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 2,
      stderr: "x usage: bun scripts/submit-store.mts <chrome|firefox>\n",
    });
  });
});
