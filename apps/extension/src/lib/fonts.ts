// Swapping a family touches three places: the object here, the @fontsource
// dependency in package.json, and the `--font-sans`/`--font-mono` token in
// packages/ui-tokens/tokens.css. The woff2 files are copied to
// `fonts/<role>-<weight>.woff2` at build time (wxt.config.ts) and loaded
// through lib/font-loader.ts, so the file names never carry the family.

export interface Typeface {
  /** The role the CSS tokens address the family by. */
  readonly role: "sans" | "mono";
  /** The `font-family` name, as the @fontsource CSS declares it. */
  readonly family: string;
  /** The @fontsource package id: `@fontsource/<id>`. */
  readonly package: string;
  readonly weights: readonly number[];
}

export const SANS: Typeface = {
  role: "sans",
  family: "Inter",
  package: "inter",
  // 700 is the sidebar's product name (font-bold); nothing goes heavier.
  weights: [400, 500, 600, 700],
};

export const MONO: Typeface = {
  role: "mono",
  family: "IBM Plex Mono",
  package: "ibm-plex-mono",
  weights: [400],
};

export const TYPEFACES: readonly Typeface[] = [SANS, MONO];

export function facePath(typeface: Typeface, weight: number): `fonts/${string}.woff2` {
  return `fonts/${typeface.role}-${weight}.woff2`;
}

export function facePackageFile(typeface: Typeface, weight: number): string {
  return `@fontsource/${typeface.package}/files/${typeface.package}-latin-${weight}-normal.woff2`;
}
