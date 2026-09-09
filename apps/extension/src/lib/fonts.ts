// The bundled typefaces, one object per role. Swapping a family means
// changing its object here, the matching @fontsource dependency in
// package.json, and the shared `--font-sans`/`--font-mono` token in
// packages/ui-tokens/tokens.css. The woff2 files are copied out of the
// package into `fonts/<role>-<weight>.woff2` at build time (wxt.config.ts),
// a stable path the popup and the content-script toast both load through
// runtime.getURL (lib/font-loader.ts); the file names never carry the family.

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

/** Output path (relative to the extension root) of one bundled face. */
export function facePath(typeface: Typeface, weight: number): `fonts/${string}.woff2` {
  return `fonts/${typeface.role}-${weight}.woff2`;
}

/** The module specifier of the face's latin woff2 inside its @fontsource package. */
export function facePackageFile(typeface: Typeface, weight: number): string {
  return `@fontsource/${typeface.package}/files/${typeface.package}-latin-${weight}-normal.woff2`;
}
