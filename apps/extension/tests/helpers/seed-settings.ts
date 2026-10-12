import { NEVER_SUPERSEDED } from "@/lib/messaging/slot";
import { type Settings, updateSettingsWith } from "@/lib/settings/storage";

/** A test's starting settings, stored over the current ones through the extension's own locked
 *  write, so a stored blob a newer build wrote refuses the seed as it would any write. */
export function seedSettings(patch: Partial<Settings>): Promise<Settings> {
  return updateSettingsWith(NEVER_SUPERSEDED, () => patch);
}
