import { i18n } from "#i18n";

/**
 * Translate a dynamic key (e.g. provider labelKeys from the registry).
 * The generated i18n types only accept literal keys — this is the single
 * sanctioned cast for registry-driven strings.
 */
export function tDynamic(key: string, substitutions?: string[]): string {
  return i18n.t(key as Parameters<typeof i18n.t>[0], substitutions as never);
}
