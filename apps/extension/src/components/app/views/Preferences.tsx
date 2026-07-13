import { useEffect, useMemo, useState } from "react";
import { browser } from "#imports";
import { VoicePicker } from "@/components/app/VoicePicker";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { LabeledSelect } from "@/components/ui/select";
import { LabeledSlider } from "@/components/ui/slider";
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { getActiveLocale, i18n } from "@/lib/i18n-runtime";
import { reconcileSettings } from "@/lib/reconcile";
import type { Settings } from "@/lib/storage";
import { getProvider } from "@/providers";
import type { NormalizedVoice } from "@/providers/types";

function languageOptions(voices: NormalizedVoice[]) {
  const codes = [...new Set(voices.flatMap((v) => v.languageCodes))].sort();
  const displayNames = (() => {
    try {
      // Language names in the CHOSEN display language (the uiLanguage
      // setting), not the browser's.
      return new Intl.DisplayNames([getActiveLocale().replace("_", "-"), "en"], {
        type: "language",
      });
    } catch {
      return null;
    }
  })();

  return [
    { value: "all", title: i18n.t("preferences.chips_all") },
    ...codes.map((code) => {
      if (code === "multilingual") {
        return { value: code, title: i18n.t("preferences.multilingual") };
      }
      const parts = code.split("-");
      const normalized = parts.length > 2 ? `${parts[0]}-${parts[1]}` : code;
      let title = code;
      try {
        title = displayNames?.of(normalized) ?? code;
      } catch {
        // keep raw code
      }
      const region = parts.length > 1 ? ` (${parts.slice(1).join("-")})` : "";
      return { value: code, title: `${title.split(" (")[0]}${region}` };
    }),
  ];
}

// Chrome binds the manifest shortcuts to Cmd on macOS and Ctrl elsewhere.
// This renders a manifest SUGGESTED combo (read from the manifest itself, so
// the fallback can't drift from wxt.config.ts), shown only when
// commands.getAll reports no live binding (e.g. a conflict unassigned it).
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

function suggestedShortcut(name: string): string {
  const suggested = browser.runtime.getManifest().commands?.[name]?.suggested_key;
  const raw = (IS_MAC ? suggested?.mac : undefined) ?? suggested?.default ?? "";
  return raw.replace("Command", "Cmd");
}

// Chrome reports Mac bindings with bare glyphs ("⇧⌘S"); spell them out.
const SHORTCUT_GLYPHS: Record<string, string> = {
  "⌘": "Cmd",
  "⇧": "Shift",
  "⌥": "Option",
  "⌃": "Ctrl",
  "^": "Ctrl",
};

function formatShortcut(raw: string): string {
  return raw
    .split("")
    .map((ch) => (SHORTCUT_GLYPHS[ch] ? `${SHORTCUT_GLYPHS[ch]}+` : ch))
    .join("")
    .replace(/\+\+/g, "+");
}

/** The user's ACTUAL bindings (they may have re-mapped or unassigned them).
 *  `loaded` distinguishes "not fetched yet" from "genuinely unassigned". */
function useCommandShortcuts(): { loaded: boolean; bindings: Record<string, string> } {
  const [state, setState] = useState<{ loaded: boolean; bindings: Record<string, string> }>({
    loaded: false,
    bindings: {},
  });
  useEffect(() => {
    browser.commands
      .getAll()
      .then((commands) => {
        const bindings: Record<string, string> = {};
        for (const command of commands) {
          if (command.name) bindings[command.name] = formatShortcut(command.shortcut ?? "");
        }
        setState({ loaded: true, bindings });
      })
      .catch(() => setState({ loaded: true, bindings: {} }));
  }, []);
  return state;
}

export function Preferences() {
  const { ready, settings, update, updateWith } = useSettings();
  const voices = useVoices();
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);
  const shortcuts = useCommandShortcuts();

  // Before load: show the manifest's suggested combo as a placeholder.
  // After load: show the real binding, or "not set" when unassigned.
  const shortcutLabel = (name: string) => {
    if (!shortcuts.loaded) return suggestedShortcut(name);
    return shortcuts.bindings[name] || i18n.t("settings.shortcut_unassigned");
  };

  const langOptions = useMemo(() => languageOptions(voices), [voices]);

  if (!ready || !settings) return null;

  // settings.language can point at a language no current voice offers (voices
  // changed, provider disabled); an unknown filter value would render an
  // empty select AND filter the picker down to nothing.
  const requestedFilter = languageFilter ?? settings.language ?? "all";
  const effectiveFilter = langOptions.some((option) => option.value === requestedFilter)
    ? requestedFilter
    : "all";
  const selectedVoice = settings.selectedVoice
    ? voices.find(
        (v) =>
          v.providerId === settings.selectedVoice?.providerId &&
          v.id === settings.selectedVoice?.voiceId,
      )
    : undefined;
  const provider = selectedVoice ? getProvider(selectedVoice.providerId) : null;

  const ranges = provider ? provider.ranges(settings.model) : null;
  const supportsSpeed = provider?.supportsSpeed(selectedVoice, settings.model) ?? false;
  const supportsPitch = provider?.supportsPitch(selectedVoice, settings.model) ?? false;
  const supportsVolume = provider?.supportsVolume(selectedVoice, settings.model) ?? false;
  const supportsStyle = provider?.supportsStyle(selectedVoice, settings.model) ?? false;

  const downloadFormats =
    provider?.audioFormats
      .filter((f) => f.forDownload)
      .map((f) => ({ value: f.id, title: f.id.replace(/_/g, " ") })) ?? [];
  const readAloudFormats =
    provider?.audioFormats
      .filter((f) => f.forReadAloud)
      .map((f) => ({ value: f.id, title: f.id.replace(/_/g, " ") })) ?? [];

  async function handleSelectVoice(voice: NormalizedVoice, model: string) {
    if (!settings) return;
    const selection = { providerId: voice.providerId, voiceId: voice.id };
    // Keep the user's active language filter when the voice speaks it: a
    // multilingual voice picked while filtering French should remember French,
    // not whatever languageCodes[0] happens to be.
    const language =
      effectiveFilter !== "all" && voice.languageCodes.includes(effectiveFilter)
        ? effectiveFilter
        : (voice.languageCodes[0] ?? settings.language);
    await updateWith((current) => ({
      selectedVoice: selection,
      model,
      language,
      voicesByLanguage: { ...current.voicesByLanguage, [language]: selection },
    }));
    await reconcileSettings(voices);
  }

  async function handleToggleFavorite(key: string) {
    await updateWith((current) => ({
      favorites: current.favorites.includes(key)
        ? current.favorites.filter((f) => f !== key)
        : [...current.favorites, key],
    }));
  }

  const hasVoices = voices.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionTitle>{i18n.t("preferences.title")}</SectionTitle>
        {!hasVoices && (
          <div className="mb-2 rounded border border-note-edge bg-note p-3 text-xs text-note-text">
            {i18n.t("preferences.no_voices")}
          </div>
        )}
        <Card className="flex flex-col gap-4">
          {/* No engine selector: multi-engine voices appear as one row per
              engine in the picker, so choosing a row chooses both. */}
          <LabeledSelect
            label={i18n.t("preferences.language")}
            value={effectiveFilter}
            options={langOptions}
            disabled={!hasVoices}
            onChange={setLanguageFilter}
          />

          <VoicePicker
            voices={voices}
            selected={settings.selectedVoice}
            selectedModel={settings.model}
            favorites={settings.favorites}
            languageFilter={effectiveFilter}
            onSelect={handleSelectVoice}
            onToggleFavorite={handleToggleFavorite}
          />
          {hasVoices && (
            <div className="ml-1 text-xxs text-faint">{i18n.t("preferences.voice_tip")}</div>
          )}

          <div className="grid gap-3 pt-1">
            {supportsSpeed && (
              <LabeledSlider
                label={i18n.t("preferences.speed")}
                value={settings.speed}
                min={ranges?.speed.min ?? 0.5}
                max={ranges?.speed.max ?? 3}
                step={ranges?.speed.step ?? 0.05}
                unit="×"
                disabled={!hasVoices}
                onChange={(speed) => void update({ speed })}
              />
            )}
            {supportsPitch && (
              <LabeledSlider
                label={i18n.t("preferences.pitch")}
                value={settings.pitch}
                min={ranges?.pitch.min ?? -10}
                max={ranges?.pitch.max ?? 10}
                step={ranges?.pitch.step ?? 0.1}
                onChange={(pitch) => void update({ pitch })}
              />
            )}
            {supportsVolume && (
              <LabeledSlider
                label={i18n.t("preferences.volume")}
                value={settings.volumeGainDb}
                min={ranges?.volumeGainDb.min ?? -16}
                max={ranges?.volumeGainDb.max ?? 16}
                step={ranges?.volumeGainDb.step ?? 1}
                unit="dB"
                onChange={(volumeGainDb) => void update({ volumeGainDb })}
              />
            )}
            {supportsStyle && selectedVoice?.styles && (
              <LabeledSelect
                label={i18n.t("preferences.style")}
                value={settings.style ?? ""}
                options={[
                  { value: "", title: i18n.t("preferences.style_default") },
                  ...selectedVoice.styles.map((s) => ({ value: s, title: s })),
                ]}
                onChange={(style) => void update({ style: style || undefined })}
              />
            )}
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle>{i18n.t("preferences.formats_title")}</SectionTitle>
        <Card className="grid grid-cols-2 gap-4">
          <LabeledSelect
            label={i18n.t("preferences.download_format")}
            value={settings.downloadEncoding}
            options={
              downloadFormats.length > 0
                ? downloadFormats
                : [{ value: settings.downloadEncoding, title: settings.downloadEncoding }]
            }
            disabled={!hasVoices}
            onChange={(downloadEncoding) => void update({ downloadEncoding })}
          />
          <LabeledSelect
            label={i18n.t("preferences.read_aloud_format")}
            value={settings.readAloudEncoding}
            options={
              readAloudFormats.length > 0
                ? readAloudFormats
                : [{ value: settings.readAloudEncoding, title: settings.readAloudEncoding }]
            }
            disabled={!hasVoices}
            onChange={(readAloudEncoding) => void update({ readAloudEncoding })}
          />
        </Card>
      </div>
      <div>
        <SectionTitle>{i18n.t("preferences.appearance_title")}</SectionTitle>
        <Card>
          <LabeledSelect
            label={i18n.t("preferences.theme")}
            value={settings.theme}
            options={[
              { value: "system", title: i18n.t("preferences.theme_system") },
              { value: "light", title: i18n.t("preferences.theme_light") },
              { value: "dark", title: i18n.t("preferences.theme_dark") },
            ]}
            onChange={(theme) => void update({ theme: theme as Settings["theme"] })}
          />
        </Card>
      </div>
      <div>
        <SectionTitle>{i18n.t("settings.shortcuts_title")}</SectionTitle>
        <Card className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted">{i18n.t("settings.shortcut_read")}</span>
            <kbd className="rounded border border-edge bg-inset px-1.5 text-xxs">
              {shortcutLabel("readAloudShortcut")}
            </kbd>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">{i18n.t("settings.shortcut_download")}</span>
            <kbd className="rounded border border-edge bg-inset px-1.5 text-xxs">
              {shortcutLabel("downloadShortcut")}
            </kbd>
          </div>
          {import.meta.env.FIREFOX ? (
            // Firefox blocks tabs.create for privileged about: pages, so the
            // shortcuts editor can't be opened programmatically; point the
            // user at it instead (about:addons → gear → Manage Extension
            // Shortcuts).
            <p className="mt-1 text-xxs text-faint">{i18n.t("settings.edit_shortcuts_firefox")}</p>
          ) : (
            <Button
              className="mt-1 w-full"
              onClick={() => browser.tabs.create({ url: "chrome://extensions/shortcuts" })}
            >
              {i18n.t("settings.edit_shortcuts")}
            </Button>
          )}
        </Card>
      </div>
    </div>
  );
}
