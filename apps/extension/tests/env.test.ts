import { expect, it } from "vitest";

// Guards the dual-browser CI matrix against passing vacuously: the suite runs once per target (plain run =
// chrome, WXT_TEST_BROWSER=firefox = firefox), and a vitest define wiring regression would leave the requested
// target short of the build-time constants.
it("the build-time browser constants match the requested test target", () => {
  const expected = process.env.WXT_TEST_BROWSER === "firefox" ? "firefox" : "chrome";
  expect(import.meta.env.BROWSER).toBe(expected);
  // Vitest injects defines as strings; truthiness is the contract the source
  // relies on (see vitest.config.ts).
  expect(Boolean(import.meta.env.FIREFOX)).toBe(expected === "firefox");
  expect(Boolean(import.meta.env.CHROME)).toBe(expected === "chrome");
});
