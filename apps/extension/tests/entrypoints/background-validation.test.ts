import { beforeAll, describe, expect, it, vi } from "vitest";
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
  // Every validation waits here until the test opens it, so requests sent
  // together are in flight together.
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { fakeProvider, gate: { opened, open: () => open() } };
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
    _credentials,
    commit,
  ) => {
    await gate.opened;
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

function sendValidate(credentials: Record<string, string>): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({
    to: "background",
    id: "validateProvider",
    payload: { providerId: "polly", credentials },
  });
}

describe("background Save & test", () => {
  it("validates each of two concurrent drafts even when their 32-bit digests collide, and stores exactly one", async () => {
    const draft = (accessKeyId: string) => ({
      accessKeyId,
      secretAccessKey: "EXAMPLE-secret-not-real",
      region: "us-east-1",
    });
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
    expect(vi.mocked(validateProviderCandidate).mock.calls.map(([, c]) => c)).toEqual(
      expect.arrayContaining([first, second]),
    );

    gate.open();
    // The later claimant of the provider slot supersedes the other's commit.
    // Each request digests its draft before claiming, so drafts sent in one
    // tick may claim in either order; whichever caller was told ok is the
    // one whose draft is stored.
    const okReply = { ok: true, value: { ok: true } };
    const supersededReply = { ok: true, value: { ok: false, code: "superseded" } };
    const [firstReply, secondReply] = await replies;
    expect([firstReply, secondReply]).toEqual(expect.arrayContaining([okReply, supersededReply]));
    const stored = (await getSettings()).perProvider.polly?.credentials;
    expect(stored).toEqual(
      JSON.stringify(secondReply) === JSON.stringify(okReply) ? second : first,
    );
  });
});
