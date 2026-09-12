import fc from "fast-check";
import { isXmlIllegalCodePoint } from "./xml";

// Text arbitraries for the chunking and SSML properties: the shapes a UTF-16 code-unit splitter gets wrong (astral code
// points, marks glued to a base, bidi controls, joiner sequences) and the shape a sentence splitter gets wrong (one word longer than any provider limit).

/** Astral code points: emoji, historic scripts, CJK extension B. */
export const astralText: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.integer({ min: 0x1f300, max: 0x1f64f }),
      fc.integer({ min: 0x10000, max: 0x1047f }),
      fc.integer({ min: 0x20000, max: 0x2a6df }),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((codePoints) => String.fromCodePoint(...codePoints));

/** A base letter followed by one to four combining marks. */
export const combiningClusters: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(
      fc.integer({ min: 0x61, max: 0x7a }),
      fc.array(fc.integer({ min: 0x300, max: 0x36f }), { minLength: 1, maxLength: 4 }),
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((clusters) =>
    clusters.map(([base, marks]) => String.fromCodePoint(base, ...marks)).join(""),
  );

/** Hebrew and Arabic letters between bidi controls (marks, embeddings, isolates), the way copied right-to-left text arrives. */
export const bidiText: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("\u200e", "\u200f", "\u202b", "\u202e", "\u2067", "\u2068"),
    fc.array(
      fc.oneof(fc.integer({ min: 0x5d0, max: 0x5ea }), fc.integer({ min: 0x627, max: 0x64a })),
      { minLength: 1, maxLength: 10 },
    ),
    fc.constantFrom("", "\u202c", "\u2069", "\u200f"),
  )
  .map(([open, letters, close]) => open + String.fromCodePoint(...letters) + close);

/** Zero-width joiner sequences: family emoji, and joiners or non-joiners between plain letters (Devanagari and Persian text use them). */
export const joinerText: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.constantFrom("\u{1f468}", "\u{1f469}", "\u{1f467}", "\u{1f466}"), {
      minLength: 2,
      maxLength: 4,
    })
    .map((people) => people.join("\u200d")),
  fc
    .array(fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 4 }), {
      minLength: 2,
      maxLength: 4,
    })
    .map((parts) => parts.join("\u200d")),
  fc.array(fc.integer({ min: 0x627, max: 0x64a }), { minLength: 2, maxLength: 6 }).map((letters) =>
    String.fromCodePoint(...letters)
      .split("")
      .join("\u200c"),
  ),
);

/** One word with no whitespace at all, longer than a small chunk limit. */
export const longWord: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.integer({ min: 0x61, max: 0x7a }),
      fc.integer({ min: 0x4e00, max: 0x9fff }),
      fc.integer({ min: 0x1f300, max: 0x1f5ff }),
      fc.integer({ min: 0x300, max: 0x36f }),
    ),
    { minLength: 60, maxLength: 400 },
  )
  .map((codePoints) => String.fromCodePoint(...codePoints));

const fragment = fc.oneof(
  // "binary": every code point, printable or not, never a lone surrogate.
  { arbitrary: fc.string({ unit: "binary", maxLength: 40 }), weight: 3 },
  { arbitrary: fc.string({ unit: "grapheme", maxLength: 40 }), weight: 2 },
  astralText,
  combiningClusters,
  bidiText,
  joinerText,
  { arbitrary: longWord, weight: 1 },
);

/** Fragments joined by spaces and sentence punctuation, so the sentence splitter has boundaries to find; occasionally a bare fragment. */
export const unicodeText: fc.Arbitrary<string> = fc.oneof(
  {
    arbitrary: fc
      .array(fc.tuple(fragment, fc.constantFrom(" ", ". ", "! ", "? ", "\n", ", ", "")), {
        minLength: 1,
        maxLength: 12,
      })
      .map((parts) => parts.map(([text, separator]) => text + separator).join("")),
    weight: 4,
  },
  fragment,
);

/** The same texts without the code points XML 1.0 forbids: the SSML builders embed text without stripping them,
 *  and a document holding one is malformed however well it is escaped. */
export const xmlSafeText: fc.Arbitrary<string> = unicodeText.map((text) =>
  [...text].filter((char) => !isXmlIllegalCodePoint(char.codePointAt(0) as number)).join(""),
);
