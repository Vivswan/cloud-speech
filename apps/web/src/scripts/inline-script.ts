/** Base.astro inlines a serialized function with set:html, which escapes nothing, so anything that could end
 *  the <script> element is refused at build time. End tags are case-insensitive, hence the lowercase. */
export function inlineScript(script: string): string {
  const comparable = script.toLowerCase();
  if (comparable.includes("</script") || comparable.includes("<!--")) {
    throw new Error("inlineScript: serialized script contains an HTML terminator sequence");
  }
  return script;
}
