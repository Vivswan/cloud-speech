import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// End-to-end coverage of the background's Save & test route: the production
// dispatcher, the in-flight registry, and validateProvider run for real; the
// provider round-trip (validateProviderCandidate) and the bootstrap chores are
// mocked.

const { fakeProvider, gate } = vi.hoisted(() => {
  const fakeProvider = {
    id: "polly",
    hasCredentials: () => true,
  } satisfies Pick<import("@/providers/types").TtsProvider, "id" | "hasCredentials">;
  // Every validation waits here until the test opens its draft (keyed on the
  // access key id) or all of them, so requests sent together are in flight
  // together and one can settle while another still runs. Each test re-arms it.
  interface Waiter {
    opened: Promise<void>;
    open: () => void;
  }
  const waiters = new Map<string, Waiter>();
  let allOpen = false;
  const waiter = (key: string): Waiter => {
    const existing = waiters.get(key);
    if (existing) return existing;
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const created = { opened, open };
    waiters.set(key, created);
    return created;
  };
  const gate = {
    wait: (key: string) => (allOpen ? Promise.resolve() : waiter(key).opened),
    open: (key?: string) => {
      if (key !== undefined) {
        waiter(key).open();
        return;
      }
      allOpen = true;
      for (const entry of waiters.values()) entry.open();
    },
    arm: () => {
      waiters.clear();
      allOpen = false;
    },
  };
  return { fakeProvider, gate };
});

vi.mock("@/providers", () => ({ providerList: [fakeProvider], getProvider: () => fakeProvider }));
vi.mock("@/migrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/migrations")>()),
  runStartupMigrations: vi.fn(async () => {}),
}));
vi.mock("@/migrations/handoff", () => ({
  importHandoffOnce: vi.fn(async () => {}),
  registerHandoff: vi.fn(),
}));
vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string) => key },
  initI18n: vi.fn(async () => {}),
  subscribeLocale: vi.fn(),
}));
vi.mock("@/lib/voices", () => ({ fetchAllVoices: vi.fn(async () => []) }));
vi.mock("@/lib/errors", () => ({ surfaceError: vi.fn(async () => {}) }));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn(async () => {}),
  sendToAudioHost: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/provider-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider-validation")>();
  const validateProviderCandidate: typeof actual.validateProviderCandidate = async (
    _provider,
    credentials,
    commit,
  ) => {
    await gate.wait(credentials.accessKeyId ?? "");
    return (await commit([])) === "persisted" ? { ok: true } : { ok: false, code: "superseded" };
  };
  return { ...actual, validateProviderCandidate: vi.fn(validateProviderCandidate) };
});

import background from "@/entrypoints/background";
import { textDigest } from "@/lib/digest";
import { validateProviderCandidate } from "@/lib/provider-validation";
import { getSettings } from "@/lib/storage";

beforeAll(() => {
  Object.assign(fakeBrowser, {
    contextMenus: {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
  });
  background.main();
});

beforeEach(() => {
  gate.arm();
  vi.mocked(validateProviderCandidate).mockClear();
});

function sendValidate(credentials: Record<string, string>): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({
    to: "background",
    id: "validateProvider",
    payload: { providerId: "polly", credentials },
  });
}

const okReply = { ok: true, value: { ok: true } };
const supersededReply = { ok: true, value: { ok: false, code: "superseded" } };

const draft = (accessKeyId: string) => ({
  accessKeyId,
  secretAccessKey: "EXAMPLE-secret-not-real",
  region: "us-east-1",
});

const validatedDrafts = () => vi.mocked(validateProviderCandidate).mock.calls.map(([, c]) => c);
const storedCredentials = async () => (await getSettings()).perProvider.polly?.credentials;

describe("background Save & test", () => {
  it("validates two concurrent distinct drafts in arrival order and stores the newest, even when their 32-bit digests collide", async () => {
    const first = draft("EXAMPLEKEYAAAA3");
    const second = draft("EXAMPLEKEYAAABP");
    // The pair shares one textDigest of its canonical form, so a registry
    // keyed on that digest would hand the second caller the first's promise.
    const canonical = (c: Record<string, string>) =>
      JSON.stringify(["polly", Object.fromEntries(Object.entries(c).sort())]);
    expect(textDigest(canonical(first))).toBe(textDigest(canonical(second)));

    const replies = Promise.all([sendValidate(first), sendValidate(second)]);
    await vi.waitFor(() => {
      expect(validateProviderCandidate).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(validateProviderCandidate).mock.calls.map(([, c]) => c)).toEqual([
      first,
      second,
    ]);

    gate.open();
    // Each request claims the provider slot in the tick it arrives, so the
    // second draft supersedes the first and is the one stored.
    expect(await replies).toEqual([supersededReply, okReply]);
    expect((await getSettings()).perProvider.polly?.credentials).toEqual(second);
  });

  it("runs one validation for two concurrent identical drafts and answers both callers with it", async () => {
    const same = draft("EXAMPLEKEYSAME01");

    const replies = Promise.all([sendValidate(same), sendValidate({ ...same })]);
    await vi.waitFor(() => {
      expect(validateProviderCandidate).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(validateProviderCandidate).mock.calls[0]?.[1]).toEqual(same);

    gate.open();
    expect(await replies).toEqual([okReply, okReply]);
    expect(validateProviderCandidate).toHaveBeenCalledTimes(1);
    expect((await getSettings()).perProvider.polly?.credentials).toEqual(same);
  });

  it("stores the newest request's draft when it repeats a superseded one still in flight (A, B, A)", async () => {
    const a = draft("EXAMPLEKEYABA00A");
    const b = draft("EXAMPLEKEYABA00B");

    const replies = Promise.all([sendValidate(a), sendValidate(b), sendValidate({ ...a })]);
    // The last request must not re-attach to the first one's validation, which
    // the second one's claim is aborting: it claims the slot itself.
    await vi.waitFor(() => {
      expect(validateProviderCandidate).toHaveBeenCalledTimes(3);
    });
    expect(validatedDrafts()).toEqual([a, b, a]);

    gate.open();
    expect(await replies).toEqual([supersededReply, supersededReply, okReply]);
    expect(await storedCredentials()).toEqual(a);
  });

  it("keeps the newer draft's in-flight entry when the superseded one settles late", async () => {
    const a = draft("EXAMPLEKEYLATE0A");
    const b = draft("EXAMPLEKEYLATE0B");

    const first = sendValidate(a);
    const second = sendValidate(b);
    await vi.waitFor(() => {
      expect(validateProviderCandidate).toHaveBeenCalledTimes(2);
    });
    gate.open(a.accessKeyId);
    expect(await first).toEqual(supersededReply);

    // A retry of the newer draft, sent while it still validates, re-attaches to
    // that validation instead of starting (and superseding it with) another.
    const retry = sendValidate({ ...b });
    gate.open(b.accessKeyId);
    expect(await Promise.all([second, retry])).toEqual([okReply, okReply]);
    expect(validateProviderCandidate).toHaveBeenCalledTimes(2);
    expect(await storedCredentials()).toEqual(b);
  });
});
