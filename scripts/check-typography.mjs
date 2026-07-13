#!/usr/bin/env bun

// Guards against typographic look-alike and invisible characters that sneak
// in via copy-paste or generated text. Policy:
//
// Forbidden everywhere:
//   - curly quotes (U+2018..201F), guillemets, primes, modifier apostrophes
//   - the ellipsis U+2026 - use "..."
//   - every dash/minus look-alike (U+2010..2015, U+2212) - use "-"
//   - multiplication/division signs U+00D7 U+00F7 - use "x" and "/"
//   - typographic spaces (U+2000..200A, NBSP U+00A0, narrow NBSP U+202F,
//     figure space U+2007, ideographic space U+3000) - use a regular space
//   - invisible & bidi control characters (zero-width family U+200B..200F,
//     word joiner U+2060, BOM U+FEFF, soft hyphen U+00AD, bidi embeddings/
//     overrides/isolates U+202A..202E U+2066..2069 - the "Trojan Source"
//     class - and line/paragraph separators U+2028 U+2029)
//   - full-width ASCII variants U+FF01..U+FF5E (use the ASCII form)
//   - everything VS Code's unicode-highlight feature treats as invisible or
//     ambiguous, imported directly from the monaco-editor package (VS Code's
//     editor on npm): the InvisibleCharacters set plus the AmbiguousCharacters
//     confusables, e.g. Cyrillic "a" for Latin "a", mathematical
//     alphanumerics, Ogham spaces
//
// Context-dependent (mirrors VS Code's "allowed locales" concept, since this
// repo ships hi/zh_CN/zh_TW content):
//   - CJK sentence punctuation with no sensible ASCII twin (U+3001 U+3002
//     U+300C U+300D) is allowed in files that contain CJK text (Chinese
//     locale files and pages) and flagged everywhere else. The full-width
//     comma U+FF0C is NOT exempt: use ", " (comma + space) everywhere.
//   - Devanagari characters (some are in the ambiguous set, e.g. the visarga
//     U+0903 which resembles ":") are allowed in files containing Devanagari
//     text (the Hindi locale and pages)
//
// Deliberately allowed:
//   - functional/iconographic glyphs (shortcut parsing, UI icons, arrows in
//     setup guides, password-dot placeholders, script status marks, emoji
//     test fixtures). NOTE: composite emoji join with U+200D; the current
//     fixtures are single code points, so exempt a file here if that changes.
//
// Runs under bun (not node) so it can import the workspace monaco-editor
// ESM modules directly.
// Run: bun scripts/check-typography.mjs   (wired into `bun run check`, which
// both CI and the husky pre-commit hook execute)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AmbiguousCharacters,
  InvisibleCharacters,
} from "monaco-editor/esm/vs/base/common/strings.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  ".astro",
  "dist",
  "coverage",
  "sources",
  ".claude",
]);
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".astro",
  ".yml",
  ".yaml",
  ".json",
  ".md",
  ".html",
  ".css",
  ".toml",
  ".txt",
  ".template",
  ".sh",
  ".svg",
  ".xml",
  ".lock",
]);

/** Extensionless text files (hooks, licenses) are checked too; "forbidden
 *  everywhere" must include .husky/pre-commit and friends. */
function isCheckable(name) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return true;
  return EXTENSIONS.has(name.slice(dot));
}

// VS Code's unicode-highlight data, straight from monaco-editor. An empty
// locale set selects the _common + _default confusables (what VS Code
// highlights regardless of user locale).
const AMBIGUOUS = AmbiguousCharacters.getInstance(new Set());

// CJK sentence punctuation, allowed only in files that also carry CJK text
// (file-level, not line-level: Chinese sentences wrap across lines in JSX).
// U+FF0C deliberately absent: the full-width comma is banned everywhere.
const CJK_PUNCTUATION = new Set([0x3001, 0x3002, 0x300c, 0x300d]);
// Hiragana/Katakana, CJK ideographs (+ ext A), Hangul, compatibility forms.
const CJK_TEXT = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u;
// Devanagari block; exempt in files with Devanagari letters (Hindi locale).
const DEVANAGARI_BLOCK = [0x0900, 0x097f];
const DEVANAGARI_TEXT = /[\u0904-\u0939\u0958-\u095F]/u;

// Escapes, not literals: this file must never fail its own check.
const FORBIDDEN =
  /[\u00A0\u00AB\u00AD\u00B1\u00B4\u00BB\u00D7\u00F7\u02BC\u2000-\u2015\u2018-\u201F\u2026\u2028-\u202F\u2032-\u2037\u2039\u203A\u2060\u2066-\u2069\u2212\u2248\u3000\uFEFF\uFF01-\uFF5E]/u;

const RANGES = [
  [0x2018, 0x201f, "curly quote (use ' or \")"],
  [0x2010, 0x2015, "dash look-alike (use -)"],
  [0x2000, 0x200a, "typographic space (use a regular space)"],
  [0x200b, 0x200f, "invisible character (delete it)"],
  [0x202a, 0x202e, "bidi control character (delete it)"],
  [0x2032, 0x2037, "prime/reversed prime (use ' or \")"],
  [0x2066, 0x2069, "bidi control character (delete it)"],
  [0xff01, 0xff5e, "full-width character (use the ASCII form)"],
];

const NAMES = {
  65292: 'full-width comma (use ", " with a trailing space)',
  160: "non-breaking space (use a regular space)",
  8239: "narrow non-breaking space (use a regular space)",
  12288: "ideographic space (use a regular space)",
  173: "soft hyphen (delete it)",
  8288: "word joiner (delete it)",
  65279: "byte-order mark (delete it)",
  8232: "line separator (use a newline)",
  8233: "paragraph separator (use a newline)",
  8230: 'ellipsis (use "...")',
  8722: "minus sign look-alike (use -)",
  215: 'multiplication sign (use "x")',
  247: 'division sign (use "/")',
  177: 'plus-minus sign (use "+/-")',
  8776: 'almost-equal sign (use "~")',
  171: "guillemet (use quotes)",
  187: "guillemet (use quotes)",
  8249: "guillemet (use quotes)",
  8250: "guillemet (use quotes)",
  8242: "prime (use ')",
  8243: 'double prime (use ")',
  700: "modifier apostrophe (use ')",
  180: "acute accent used as apostrophe (use ')",
};

function hex(code) {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Returns the failure message for a code point, or null when allowed.
 *  `context` carries the file-level script exemptions. */
function violation(code, context) {
  // Control characters: tab is biome's domain and \n never reaches here
  // (lines are split on it); the rest of monaco's invisible-control trio is
  // flagged explicitly so the ASCII fast path below can't hide them.
  if (code === 0x0b || code === 0x0c) return "vertical tab/form feed (delete it)";
  if (code === 0x0d) return "carriage return (use LF line endings)";
  if (code <= 0x7e) return null;
  if (CJK_PUNCTUATION.has(code)) {
    return context.cjk ? null : `CJK punctuation ${hex(code)} in a non-CJK file (use ASCII)`;
  }
  if (context.devanagari && code >= DEVANAGARI_BLOCK[0] && code <= DEVANAGARI_BLOCK[1]) {
    return null;
  }
  if (NAMES[code]) return NAMES[code];
  if (FORBIDDEN.test(String.fromCodePoint(code))) {
    for (const [lo, hi, label] of RANGES) {
      if (code >= lo && code <= hi) return label;
    }
    return `disallowed character ${hex(code)}`;
  }
  if (InvisibleCharacters.isInvisibleCharacter(code)) {
    return `invisible character ${hex(code)} (delete it)`;
  }
  const twin = AMBIGUOUS.getPrimaryConfusable(code);
  if (twin !== undefined) {
    const ascii = twin === 0x20 ? "a regular space" : `"${String.fromCodePoint(twin)}"`;
    return `ambiguous character ${hex(code)} (use ${ascii})`;
  }
  return null;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
    } else if (isCheckable(entry)) {
      yield path;
    }
  }
}

const failures = [];
for (const path of walk(ROOT)) {
  const content = readFileSync(path, "utf-8");
  const context = { cjk: CJK_TEXT.test(content), devanagari: DEVANAGARI_TEXT.test(content) };
  content.split("\n").forEach((line, index) => {
    for (const ch of line) {
      const message = violation(ch.codePointAt(0), context);
      if (message) failures.push(`${relative(ROOT, path)}:${index + 1} ${message}`);
    }
  });
}

if (failures.length > 0) {
  console.error("Typographic look-alike characters found:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`\n${failures.length} occurrence(s). Replace them with plain ASCII equivalents.`);
  process.exit(1);
}
console.log("Typography check passed.");
