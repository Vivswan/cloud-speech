import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Settings } from "@/components/app/views/Settings";
import { withProviderPrefs } from "@/lib/provider-state";
import { DEFAULT_SETTINGS } from "@/lib/storage";
import type { ProviderId, TtsProvider } from "@/providers/types";

vi.mock("@/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/providers")>();
  const renamed = (provider: TtsProvider, keys: Record<string, string>): TtsProvider => ({
    ...provider,
    credentialSchema: provider.credentialSchema.map((field) => ({
      ...field,
      key: keys[field.key] ?? field.key,
    })),
  });
  const providers = {
    azure: renamed(original.getProvider("azure"), { region: "location" }),
    custom: renamed(original.getProvider("custom"), { baseUrl: "endpoint" }),
  };
  return {
    ...original,
    providerList: Object.values(providers),
    getProvider: (id: ProviderId) =>
      id in providers ? providers[id as keyof typeof providers] : original.getProvider(id),
  };
});

interface Case {
  shows: string;
  id: ProviderId;
  credentials: Record<string, string>;
  place: string;
}

describe("provider row summary", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it.each<Case>([
    {
      shows: "the region field's value",
      id: "azure",
      credentials: { subscriptionKey: "k", location: "westeurope" },
      place: "westeurope",
    },
    {
      shows: "the endpoint field's host",
      id: "custom",
      credentials: { endpoint: "http://tts.example.com:4000/v1" },
      place: "tts.example.com:4000",
    },
  ])("by the schema's role, not the field's name: $shows", async ({ id, credentials, place }) => {
    await fakeBrowser.storage.sync.set({
      settings: {
        ...DEFAULT_SETTINGS,
        ...withProviderPrefs(DEFAULT_SETTINGS, id, { credentials, verified: true, enabled: true }),
      },
    });

    render(<Settings />);

    const row = await screen.findByTestId(`provider-${id}`);
    expect(within(row).getByText(["settings.connected", place].join(" · "))).toBeVisible();
  });
});
