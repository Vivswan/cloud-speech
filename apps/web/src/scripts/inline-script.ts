/** Base.astro inlines serialized functions with set:html, which escapes nothing, so anything that could end
 *  the <script> element is refused at build time. End tags are case-insensitive, hence the lowercase. */
export function assertSafeInlineScript(script: string): string {
  const comparable = script.toLowerCase();
  if (comparable.includes("</script") || comparable.includes("<!--")) {
    throw new Error(
      "assertSafeInlineScript: serialized script contains an HTML terminator sequence",
    );
  }
  return script;
}

/** A JSON value as a JavaScript literal safe to concatenate into script source: JSON permits raw U+2028 and
 *  U+2029, which end a JavaScript line, and a `<` could open `</script` or `<!--` inside the element. */
export function scriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c");
}
