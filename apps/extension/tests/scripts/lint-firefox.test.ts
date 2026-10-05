import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  annotation,
  classify,
  type LinterMessage,
  lint,
} from "../../../../scripts/lint-firefox.mts";

const DIR = "apps/extension/.output/firefox-mv3";

/** A linter message as addons-linter shapes it (`_type` is its field name). */
function message(
  type: LinterMessage["_type"],
  code: string,
  text: string,
  file?: string,
  line?: number,
  column?: number,
): LinterMessage {
  // biome-ignore lint/style/useNamingConvention: addons-linter's field name
  return { _type: type, code, message: text, file, line, column };
}

const NOT_ACCEPTED =
  "(not an accepted warning: fix the code, or if a library emits it, add it to ACCEPTED_WARNINGS in scripts/lint-firefox.mts with its source named)";

/** The build's known warnings, on a popup chunk with a fresh hash. */
const POPUP = "chunks/popup-Zz9new0h.js";
const ACCEPTED: LinterMessage[] = [
  message(
    "warning",
    "DANGEROUS_EVAL",
    "The Function constructor is eval.",
    "background.js",
    5,
    2971,
  ),
  message("warning", "UNSAFE_VAR_ASSIGNMENT", "Unsafe assignment to innerHTML", POPUP, 9, 1787),
  message("warning", "UNSAFE_VAR_ASSIGNMENT", "Unsafe assignment to innerHTML", POPUP, 9, 4656),
  message("warning", "DANGEROUS_EVAL", "The Function constructor is eval.", POPUP, 13, 2340),
  message(
    "warning",
    "UNSAFE_VAR_ASSIGNMENT",
    "Unsafe call to import for argument 0",
    POPUP,
    97,
    12869,
  ),
];
const ACCEPTED_ANNOTATIONS = [
  `::warning file=${DIR}/background.js,title=DANGEROUS_EVAL,line=5,col=2971::The Function constructor is eval.`,
  `::warning file=${DIR}/chunks/popup-Zz9new0h.js,title=UNSAFE_VAR_ASSIGNMENT,line=9,col=1787::Unsafe assignment to innerHTML`,
  `::warning file=${DIR}/chunks/popup-Zz9new0h.js,title=UNSAFE_VAR_ASSIGNMENT,line=9,col=4656::Unsafe assignment to innerHTML`,
  `::warning file=${DIR}/chunks/popup-Zz9new0h.js,title=DANGEROUS_EVAL,line=13,col=2340::The Function constructor is eval.`,
  `::warning file=${DIR}/chunks/popup-Zz9new0h.js,title=UNSAFE_VAR_ASSIGNMENT,line=97,col=12869::Unsafe call to import for argument 0`,
];
// The reviewer's control: an accepted code, in a file of ours.
const OWN_INNER_HTML = message(
  "warning",
  "UNSAFE_VAR_ASSIGNMENT",
  "Unsafe assignment to innerHTML",
  "content-scripts/content.js",
  35,
  1,
);

// A two-file extension whose manifest lacks a name and whose script assigns innerHTML and calls eval,
// linted for real: what addons-linter's in-process report carries (the `_type`, `code`, `file`, `line`
// and `column` fields classify reads) is the library's contract, not this repository's.
let extension = "";
beforeAll(() => {
  extension = mkdtempSync(join(tmpdir(), "lint-firefox-"));
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      version: "1.0",
      browser_specific_settings: { gecko: { id: "x@y.z" } },
    }),
  );
  writeFileSync(join(extension, "bg.js"), 'document.body.innerHTML = "<b>x</b>"; eval("1");\n');
});
afterAll(() => {
  rmSync(extension, { recursive: true, force: true });
});

describe("Firefox lint classification", () => {
  const empty = { errors: [], warnings: [], notices: [] };

  it("fails on the linter's error and on each unlisted warning, annotating every message", async () => {
    expect(classify(await lint(extension), DIR)).toEqual({
      findings: [
        `${DIR}/manifest.json MANIFEST_FIELD_REQUIRED: "/" must have required property 'name'`,
        `${DIR}/manifest.json MISSING_DATA_COLLECTION_PERMISSIONS: The "data_collection_permissions" property is missing. ${NOT_ACCEPTED}`,
        `${DIR}/bg.js:1 DANGEROUS_EVAL: eval can be harmful. ${NOT_ACCEPTED}`,
      ],
      annotations: [
        `::error file=${DIR}/manifest.json,title=MANIFEST_FIELD_REQUIRED::"/" must have required property 'name'`,
        `::warning file=${DIR}/manifest.json,title=MISSING_DATA_COLLECTION_PERMISSIONS::The "data_collection_permissions" property is missing.`,
        `::warning file=${DIR}/bg.js,title=DANGEROUS_EVAL,line=1,col=39::eval can be harmful.`,
      ],
    });
  });

  it.each([
    {
      name: "passes the accepted warnings, the popup chunk under a new hash included",
      input: { ...empty, warnings: ACCEPTED },
      expected: { findings: [], annotations: ACCEPTED_ANNOTATIONS },
    },
    {
      name: "fails an accepted code that appears in a file of ours",
      input: { ...empty, warnings: [...ACCEPTED, OWN_INNER_HTML] },
      expected: {
        findings: [
          `${DIR}/content-scripts/content.js:35 UNSAFE_VAR_ASSIGNMENT: Unsafe assignment to innerHTML ${NOT_ACCEPTED}`,
        ],
        annotations: [
          ...ACCEPTED_ANNOTATIONS,
          `::warning file=${DIR}/content-scripts/content.js,title=UNSAFE_VAR_ASSIGNMENT,line=35,col=1::Unsafe assignment to innerHTML`,
        ],
      },
    },
    {
      name: "passes a clean report with nothing to annotate",
      input: empty,
      expected: { findings: [], annotations: [] },
    },
  ])("$name", ({ input, expected }) => {
    expect(classify(input, DIR)).toEqual(expected);
  });

  it.each<{ name: string; message: LinterMessage; line: string }>([
    {
      name: "escapes the file path and title, keeps the message's colons and commas",
      message: message("notice", "A:B,C", "50% done: a, b\nnext line", "chunks/a,b.js", 3, 7),
      line: "::notice file=apps/extension/.output/firefox-mv3/chunks/a%2Cb.js,title=A%3AB%2CC,line=3,col=7::50%25 done: a, b%0Anext line",
    },
    {
      name: "leaves out the position of a message that names no file",
      message: message("error", "MISSING_ADDON_ID", "no id", undefined, 4),
      line: "::error title=MISSING_ADDON_ID::no id",
    },
  ])("$name", ({ message, line }) => {
    expect(annotation(message, DIR)).toBe(line);
  });
});
