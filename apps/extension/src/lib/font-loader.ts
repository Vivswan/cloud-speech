import { browser } from "#imports";
import { facePath, type Typeface } from "./fonts";

// The popup registers each typeface under the family name the CSS tokens use;
// the content-script toast registers under an alias that cannot collide with
// a page's own declarations of the family.
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
