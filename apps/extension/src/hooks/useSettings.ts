import { useEffect, useState } from "react";
import {
  getSettings,
  type Settings,
  setSyncEnabled as setSyncEnabledStorage,
  syncEnabledItem,
  updateSettings,
  updateSettingsWith,
  watchSettings,
} from "@/lib/storage";

/** Reactive settings backed by wxt/storage (sync or local per user toggle). */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [syncEnabled, setSyncEnabledState] = useState(true);

  useEffect(() => {
    let mounted = true;
    getSettings().then((s) => mounted && setSettings(s));
    syncEnabledItem.getValue().then((v) => mounted && setSyncEnabledState(v));

    const unwatchSettings = watchSettings((s) => mounted && setSettings(s));
    const unwatchSync = syncEnabledItem.watch((v) => mounted && setSyncEnabledState(v ?? true));
    return () => {
      mounted = false;
      unwatchSettings();
      unwatchSync();
    };
  }, []);

  return {
    ready: settings !== null,
    settings,
    /** Flat patch of independent fields. */
    update: updateSettings,
    /** Patch computed from FRESH state inside the write lock — required for
     *  nested structures (favorites, credential maps, voicesByLanguage). */
    updateWith: updateSettingsWith,
    syncEnabled,
    setSyncEnabled: async (enabled: boolean) => {
      await setSyncEnabledStorage(enabled);
      setSettings(await getSettings());
    },
  };
}
