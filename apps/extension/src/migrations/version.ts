/** The blob's own version; a missing or malformed field means v1 (the only
 *  version ever written without one). The ONE classification of a version
 *  stamp: the runner and every step that guards on "already past me" use it,
 *  so no step can disagree with the runner about what a stamp means. */
export function peekSchemaVersion(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 1;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1;
}
