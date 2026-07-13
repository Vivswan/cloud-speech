import type { CredentialField } from "@/providers/types";

// ---------------------------------------------------------------------------
// Client-side credential checks the Settings form runs BEFORE Save & test.
// Hard errors are deterministic (the live test could never succeed); warnings
// are advisory only and never block, since key/region formats drift.
// ---------------------------------------------------------------------------

/** Invisible characters that ride along in copy-paste from PDFs and rich
 *  text. No real credential contains them, so blocking is safe. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching pasted control chars is the point
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/;

/** Keys copied from consoles and PDFs routinely carry a trailing newline; a
 *  header value with one makes fetch throw before any request is sent. */
export function trimValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
}

/** An absolute, fetchable http(s) URL, or null. The protocol check is
 *  load-bearing: "localhost:4000/v1" parses fine with protocol "localhost:"
 *  and would otherwise normalize to the garbage origin "null". */
export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host ? url : null;
  } catch {
    return null;
  }
}

export type CredentialFieldError = "required" | "url" | "invisible";

/** Deterministic problems that make the live test pointless. The caller maps
 *  each kind to a localized inline field error and skips Save & test. */
export function credentialFieldError(
  field: CredentialField,
  value: string,
): CredentialFieldError | undefined {
  if (!value) return field.optional ? undefined : "required";
  if (field.type === "password" && INVISIBLE_CHARS.test(value)) return "invisible";
  if (field.format === "url" && !parseHttpUrl(value)) return "url";
  return undefined;
}

/** Remove pasted endpoint paths (server docs show the full URL) so the
 *  provider doesn't request .../audio/speech/audio/speech. Matches on the
 *  parsed PATHNAME, so a trailing query or fragment can't hide the suffix.
 *  The caller shows a note whenever the returned value differs - never a
 *  silent rewrite. */
export function stripEndpointSuffixes(field: CredentialField, value: string): string {
  const url = field.stripSuffixes ? parseHttpUrl(value) : null;
  if (!url || !field.stripSuffixes) return value;
  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of field.stripSuffixes) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, "");
    }
  }
  if (path === url.pathname.replace(/\/+$/, "")) return value;
  return `${url.origin}${path}${url.search}${url.hash}`;
}

export type CredentialFieldWarning =
  | { kind: "hint"; hintKey: string }
  | { kind: "url_parts_ignored" }
  | { kind: "plain_http_key" }
  | { kind: "missing_path" };

// Loopback ONLY: traffic to LAN/mDNS/private-range hosts still crosses a
// network unencrypted, so those DO warn when a key is configured.
const LOOPBACK_HOST = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Advisory-only shape/URL warnings, first match wins. `values` provides the
 *  cross-field context (an http URL only risks a key that actually exists). */
export function credentialFieldWarning(
  field: CredentialField,
  value: string,
  schema: CredentialField[],
  values: Record<string, string>,
): CredentialFieldWarning | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (field.hintPattern && field.hintKey && !field.hintPattern.test(trimmed)) {
    return { kind: "hint", hintKey: field.hintKey };
  }

  if (field.format === "url") {
    const url = parseHttpUrl(trimmed);
    if (!url) return undefined; // the hard-error path owns unparseable URLs
    if (url.username || url.password || url.search || url.hash) {
      return { kind: "url_parts_ignored" };
    }
    const hasSecret = schema.some(
      (other) => other.type === "password" && Boolean(values[other.key]?.trim()),
    );
    if (url.protocol === "http:" && !LOOPBACK_HOST.test(url.hostname) && hasSecret) {
      return { kind: "plain_http_key" };
    }
    if (url.pathname === "" || url.pathname === "/") {
      return { kind: "missing_path" };
    }
  }
  return undefined;
}
