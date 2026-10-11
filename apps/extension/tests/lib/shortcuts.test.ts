import { shortcutDisplay } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";

// shortcutDisplay is the cross-OS rendering the website and README show; check-sync.mts pins the README
// against the shipped SHORTCUTS, so the bindings here are hand-written and exercise only the two branches.

describe("shortcutDisplay", () => {
  it.each([
    [
      "collapses matching Ctrl/Command bindings into one rendering",
      "Command+Shift+S",
      "Ctrl/Cmd+Shift+S",
    ],
    [
      "shows both bindings when they diverge beyond the modifier",
      "Command+Option+S",
      "Ctrl+Shift+S / Command+Option+S",
    ],
  ])("%s", (_case, mac, rendered) => {
    expect(shortcutDisplay({ default: "Ctrl+Shift+S", mac })).toBe(rendered);
  });
});
