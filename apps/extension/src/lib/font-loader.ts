import { browser } from "#imports";
import { facePath, type Typeface } from "./fonts";

// One loader for every surface: the popup registers each typeface under its
// own family name (the CSS tokens name it), the content-script toast under an
// alias that cannot collide with a page's own declarations of the family. A
// face is fetched the first time text uses it.
export function addFaces(
  fonts: FontFaceSet,
  typeface: Typeface,
  options: { readonly as?: string; readonly weights?: readonly number[] } = {},
): void {
  const family = options.as ?? typeface.family;
  for (const weight of options.weights ?? typeface.weights) {
    const source = `url(${browser.runtime.getURL(`/${facePath(typeface, weight)}`)})`;
    fonts.add(new FontFace(family, source, { weight: `${weight}`, display: "swap" }));
  }
}
