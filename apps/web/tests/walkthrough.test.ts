import { expect, test } from "bun:test";
import { SCREENSHOT_SCENES } from "@cloud-speech/store-screenshots";
import { WALKTHROUGH_STEPS } from "../src/lib/walkthrough";

// `satisfies` ties each step to a real scene, but not the other way round: a scene the renderer captures without a
// step typechecks and ships on no page. Every scene is shown once.
test("the walkthrough shows every scene the renderer captures, each once", () => {
  expect(WALKTHROUGH_STEPS.map((step) => step.scene).sort()).toEqual([...SCREENSHOT_SCENES].sort());
});
