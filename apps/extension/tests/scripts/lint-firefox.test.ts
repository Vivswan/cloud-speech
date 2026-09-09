import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  annotation,
  classify,
  type LinterMessage,
  parseReport,
} from "../../../../scripts/lint-firefox.mts";

// Captured from `web-ext lint --output json` on a two-file extension whose
// manifest lacks a name and whose script assigns innerHTML and calls eval:
// one error, three warnings, no notice.
const FIXTURE = readFileSync(resolve(__dirname, "fixtures/addons-linter-report.json"), "utf8");
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

const ERROR_ANNOTATION = `::error file=${DIR}/manifest.json,title=MANIFEST_FIELD_REQUIRED::"/" must have required property 'name'`;
// None of the fixture's warnings is in ACCEPTED_WARNINGS: two are in a file
// the build never produces, and the manifest one is a code the list lacks.
const WARNING_ANNOTATIONS = [
  `::warning file=${DIR}/manifest.json,title=MISSING_DATA_COLLECTION_PERMISSIONS::The "data_collection_permissions" property is missing.`,
  `::warning file=${DIR}/bg.js,title=UNSAFE_VAR_ASSIGNMENT,line=1,col=1::Unsafe assignment to innerHTML`,
  `::warning file=${DIR}/bg.js,title=DANGEROUS_EVAL,line=1,col=40::eval can be harmful.`,
];
const NOT_ACCEPTED =
  "(not an accepted warning: fix the code, or if a library emits it, add it to ACCEPTED_WARNINGS in scripts/lint-firefox.mts with its source named)";
const WARNING_FINDINGS = [
  `${DIR}/manifest.json MISSING_DATA_COLLECTION_PERMISSIONS: The "data_collection_permissions" property is missing. ${NOT_ACCEPTED}`,
  `${DIR}/bg.js:1 UNSAFE_VAR_ASSIGNMENT: Unsafe assignment to innerHTML ${NOT_ACCEPTED}`,
  `${DIR}/bg.js:1 DANGEROUS_EVAL: eval can be harmful. ${NOT_ACCEPTED}`,
];

/** The build's known warnings, on a popup chunk with a fresh hash. */
const POPUP = "chunks/popup-Zz9new0h.js";
const ACCEPTED: LinterMessage[] = [
  message(
    "warning",
    "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
    "Manifest key not supported by the specified minimum Firefox for Android version",
    "manifest.json",
  ),
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
  `::warning file=${DIR}/manifest.json,title=KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION::Manifest key not supported by the specified minimum Firefox for Android version`,
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

describe("Firefox lint classification", () => {
  const report = parseReport(FIXTURE);
  const empty = { errors: [], warnings: [], notices: [] };

  it.each([
    {
      name: "fails on the error and on each unlisted warning, annotating every message",
      input: report,
      expected: {
        findings: [
          `${DIR}/manifest.json MANIFEST_FIELD_REQUIRED: "/" must have required property 'name'`,
          ...WARNING_FINDINGS,
        ],
        annotations: [ERROR_ANNOTATION, ...WARNING_ANNOTATIONS],
      },
    },
    {
      name: "fails on unlisted warnings alone, still annotating each",
      input: { ...report, errors: [] },
      expected: { findings: WARNING_FINDINGS, annotations: WARNING_ANNOTATIONS },
    },
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

  it.each([
    ["a crash or prompt instead of JSON", "Error: something broke\n", /printed no JSON report/],
    [
      "JSON without the message lists",
      '{"summary":{"errors":0}}',
      /lacks its errors\/warnings\/notices lists/,
    ],
  ])("rejects %s", (_name, stdout, error) => {
    expect(() => parseReport(stdout)).toThrow(error);
  });

  it("quotes the exit status and stderr when the process printed no report", () => {
    const run = { status: 1, stderr: "node: bad option: --frozen\n" };
    expect(() => parseReport("", run)).toThrow(
      "web-ext lint printed no JSON report; exit status 1\nstdout:\n\nstderr:\nnode: bad option: --frozen",
    );
    expect(() => parseReport("", { status: null, stderr: "" })).toThrow(/exit status \(signal\)/);
  });
});
