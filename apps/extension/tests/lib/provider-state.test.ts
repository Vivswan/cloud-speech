import { describe, expect, it } from "vitest";
import {
  credentialsFor,
  isProviderConfigured,
  isProviderConnected,
  isProviderEnabled,
} from "@/lib/provider-state";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/storage";
import { openai } from "@/providers/openai";

// One row per provider state; every predicate is asserted on every row so a
// predicate that drifts toward another's meaning fails here.
const cases: Array<{
  name: string;
  patch: Partial<Settings>;
  expected: { enabled: boolean; configured: boolean; connected: boolean };
}> = [
  {
    name: "untouched provider",
    patch: {},
    expected: { enabled: false, configured: false, connected: false },
  },
  {
    name: "enabled without credentials",
    patch: { enabledProviders: { openai: true } },
    expected: { enabled: true, configured: false, connected: false },
  },
  {
    name: "enabled with a blank required field",
    patch: { enabledProviders: { openai: true }, credentials: { openai: { apiKey: " " } } },
    expected: { enabled: true, configured: false, connected: false },
  },
  {
    name: "enabled with untested credentials",
    patch: { enabledProviders: { openai: true }, credentials: { openai: { apiKey: "sk-x" } } },
    expected: { enabled: true, configured: true, connected: false },
  },
  {
    name: "enabled with validated credentials",
    patch: {
      enabledProviders: { openai: true },
      credentials: { openai: { apiKey: "sk-x" } },
      credentialsValid: { openai: true },
    },
    expected: { enabled: true, configured: true, connected: true },
  },
  {
    name: "validated credentials but switched off",
    patch: {
      enabledProviders: { openai: false },
      credentials: { openai: { apiKey: "sk-x" } },
      credentialsValid: { openai: true },
    },
    expected: { enabled: false, configured: false, connected: false },
  },
];

describe("provider state predicates", () => {
  it.each(cases)("$name", ({ patch, expected }) => {
    const settings: Settings = { ...DEFAULT_SETTINGS, ...patch };
    expect({
      enabled: isProviderEnabled(settings, "openai"),
      configured: isProviderConfigured(settings, openai),
      connected: isProviderConnected(settings, "openai"),
    }).toEqual(expected);
  });

  it("credentialsFor returns the stored map, or an empty one to spread over", () => {
    expect(credentialsFor(DEFAULT_SETTINGS, "openai")).toEqual({});
    const stored = { apiKey: "sk-x" };
    expect(credentialsFor({ ...DEFAULT_SETTINGS, credentials: { openai: stored } }, "openai")).toBe(
      stored,
    );
  });
});
