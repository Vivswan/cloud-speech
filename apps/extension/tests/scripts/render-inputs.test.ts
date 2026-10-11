import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { RENDER_INPUTS } from "../../../../scripts/lib/render-inputs.mts";

// The roster names paths by hand, and nothing else reads them by name: a renamed or removed input would stay
// listed, match nothing, and silently drop out of both the dev staleness check and the pull-request render.
const ROOT = resolve(__dirname, "../../../..");

it.each(RENDER_INPUTS)("render input exists in the checkout: %s", (input) => {
  expect(existsSync(resolve(ROOT, input))).toBe(true);
});
