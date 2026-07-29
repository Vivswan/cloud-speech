import { SHORTCUTS, shortcutDisplay } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";

// SHORTCUTS drives the manifest's suggested_key; shortcutDisplay is the
// cross-OS rendering the website and README show (check-sync.mjs pins the
// README against it).

describe("shortcutDisplay", () => {
  it("collapses matching Ctrl/Command bindings into one rendering", () => {
    expect(shortcutDisplay(SHORTCUTS.readAloud)).toBe("Ctrl/Cmd+Shift+S");
    expect(shortcutDisplay(SHORTCUTS.download)).toBe("Ctrl/Cmd+Shift+E");
  });

  it("shows both bindings when they diverge beyond the modifier", () => {
    expect(shortcutDisplay({ default: "Ctrl+Shift+E", mac: "Command+Option+E" })).toBe(
      "Ctrl+Shift+E / Command+Option+E",
    );
  });
});
