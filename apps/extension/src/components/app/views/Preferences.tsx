import { useEffect, useMemo, useState } from "react";
import { browser } from "#imports";
import { ErrorNotice } from "@/components/app/ErrorNotice";
import { NewerVersionNote } from "@/components/app/NewerVersionNote";
import { resolveVoiceLanguage, VoicePicker } from "@/components/app/VoicePicker";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { LabeledSelect } from "@/components/ui/select";
import { LabeledSlider } from "@/components/ui/slider";
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { getActiveLocale, i18n } from "@/lib/i18n-runtime";
import { hasCommands } from "@/lib/platform";
import { type EncodingPurpose, resolveEncoding, withProviderPrefs } from "@/lib/provider-state";
import { reconcileSettings, rosterUnknown, selectVoice } from "@/lib/reconcile";
import type { Settings } from "@/lib/storage";
import { getProvider } from "@/providers";
import { DEFAULT_RANGES, MULTILINGUAL, type NormalizedVoice } from "@/providers/types";

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
      if (code === MULTILINGUAL) {
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
  const raw =
    typeof suggested === "string"
      ? suggested
      : ((IS_MAC ? suggested?.mac : undefined) ?? suggested?.default ?? "");
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
 *  `loaded` distinguishes "not fetched yet" from "genuinely unassigned".
 *  Only mounted where browser.commands exists (ShortcutsCard). */
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

/** The keyboard shortcuts and where to change them. Rendered only where the
 *  commands API exists: Firefox for Android has no keyboard shortcuts, and a
 *  card listing them there would describe an entry point that does not exist. */
function ShortcutsCard() {
  const shortcuts = useCommandShortcuts();

  // Before load: show the manifest's suggested combo as a placeholder.
  // After load: show the real binding, or "not set" when unassigned.
  const shortcutLabel = (name: string) => {
    if (!shortcuts.loaded) return suggestedShortcut(name);
    return shortcuts.bindings[name] || i18n.t("settings.shortcut_unassigned");
  };

  return (
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
  );
}

export function Preferences() {
  const { settings, update, updateWith, writeFailure, newerVersion } = useSettings();
  const voices = useVoices();
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);

  const langOptions = useMemo(() => languageOptions(voices), [voices]);

  if (settings === null) return null;

  // settings.language can point at a language no current voice offers (voices
  // changed, provider disabled); an unknown filter value would render an
  // empty select AND filter the picker down to nothing.
  const requestedFilter = languageFilter ?? settings.language ?? "all";
  const effectiveFilter = langOptions.some((option) => option.value === requestedFilter)
    ? requestedFilter
    : "all";
  const selection = settings.selection;
  const selectedVoice = selection
    ? voices.find((v) => v.providerId === selection.providerId && v.id === selection.voiceId)
    : undefined;
  // The selection with the voice it names resolved from the cache. While its
  // provider's roster is unknown (enabled and configured, nothing cached) the
  // voice is not, but the selection is kept, so its provider and engine still
  // size the controls and the predicates answer from the voice id. Null with
  // nothing to size the controls against.
  const active =
    selection && (selectedVoice || rosterUnknown(settings, voices, selection.providerId))
      ? { selection, voice: selectedVoice, provider: getProvider(selection.providerId) }
      : null;
  const voiceUnlisted = active !== null && active.voice === undefined;

  const ranges = active ? active.provider.ranges(active.selection.model) : DEFAULT_RANGES;
  const supports = (
    capability: "supportsSpeed" | "supportsPitch" | "supportsVolume" | "supportsStyle",
  ) =>
    active?.provider[capability](
      active.voice ?? { id: active.selection.voiceId },
      active.selection.model,
    ) ?? false;

  const formatOptions = (purpose: EncodingPurpose) =>
    active?.provider.audioFormats
      .filter((f) => (purpose === "readAloud" ? f.forReadAloud : f.forDownload))
      .map((f) => ({ value: f.id, title: f.id.replace(/_/g, " ") })) ?? [];
  const formatLabels: Record<EncodingPurpose, string> = {
    download: i18n.t("preferences.download_format"),
    readAloud: i18n.t("preferences.read_aloud_format"),
  };

  async function handleSelectVoice(voice: NormalizedVoice, model: string) {
    if (!settings) return;
    const language = resolveVoiceLanguage(voice, effectiveFilter);
    await updateWith((current) => selectVoice(current, voice, model, language));
    await reconcileSettings(voices);
  }

  function handleStyleChange(style: string) {
    void updateWith((current) => {
      if (!current.selection) return {};
      const { style: _previous, ...rest } = current.selection;
      return { selection: style ? { ...rest, style } : rest };
    });
  }

  function handleFormatChange(purpose: EncodingPurpose, encoding: string) {
    if (!active) return;
    const providerId = active.provider.id;
    void updateWith((current) =>
      withProviderPrefs(
        current,
        providerId,
        purpose === "readAloud" ? { readAloudEncoding: encoding } : { downloadEncoding: encoding },
      ),
    );
  }

  async function handleToggleFavorite(key: string) {
    await updateWith((current) => ({
      favorites: current.favorites.includes(key)
        ? current.favorites.filter((f) => f !== key)
        : [...current.favorites, key],
    }));
  }

  const hasVoices = voices.length > 0;
  // Radix sliders and selects stay keyboard-operable inside a disabled
  // fieldset (their thumbs are spans, not form controls), and the voice
  // picker's popover renders outside the fieldset altogether, so the lock
  // is passed to each of them explicitly as well.
  const locked = newerVersion !== null;

  return (
    <div className="flex flex-col gap-5">
      {locked && <NewerVersionNote storedVersion={newerVersion} />}
      <fieldset
        disabled={locked}
        className="flex flex-col gap-5 disabled:pointer-events-none disabled:opacity-60"
      >
        <div>
          <SectionTitle>{i18n.t("preferences.title")}</SectionTitle>
          {writeFailure && (
            <ErrorNotice error={writeFailure.value} reportKey={writeFailure.key} className="mb-2" />
          )}
          {!hasVoices && !active && (
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
              disabled={locked || !hasVoices}
              onChange={setLanguageFilter}
            />
            {/* The select alone only filters the picker; playback language
              changes when a voice is chosen. Say so, or a user who switches
              to French and closes the popup still hears the old language. */}
            {languageFilter !== null &&
              effectiveFilter !== "all" &&
              effectiveFilter !== settings.language && (
                <div className="-mt-2 ml-1 text-xxs text-note-text">
                  {i18n.t("preferences.language_hint", [
                    langOptions.find((option) => option.value === effectiveFilter)?.title ??
                      effectiveFilter,
                  ])}
                </div>
              )}

            <VoicePicker
              voices={voices}
              selection={settings.selection}
              rosterUnknown={voiceUnlisted}
              favorites={settings.favorites}
              languageFilter={effectiveFilter}
              disabled={locked}
              onSelect={handleSelectVoice}
              onToggleFavorite={handleToggleFavorite}
            />
            {hasVoices && (
              <div className="ml-1 text-xxs text-faint">{i18n.t("preferences.voice_tip")}</div>
            )}

            <div className="grid gap-3 pt-1">
              {supports("supportsSpeed") && (
                <LabeledSlider
                  label={i18n.t("preferences.speed")}
                  value={settings.speed}
                  min={ranges.speed.min}
                  max={ranges.speed.max}
                  step={ranges.speed.step}
                  unit="x"
                  disabled={locked}
                  onChange={(speed) => void update({ speed })}
                />
              )}
              {supports("supportsPitch") && (
                <LabeledSlider
                  label={i18n.t("preferences.pitch")}
                  value={settings.pitch}
                  min={ranges.pitch.min}
                  max={ranges.pitch.max}
                  step={ranges.pitch.step}
                  disabled={locked}
                  onChange={(pitch) => void update({ pitch })}
                />
              )}
              {supports("supportsVolume") && (
                <LabeledSlider
                  label={i18n.t("preferences.volume")}
                  value={settings.volumeGainDb}
                  min={ranges.volumeGainDb.min}
                  max={ranges.volumeGainDb.max}
                  step={ranges.volumeGainDb.step}
                  unit="dB"
                  disabled={locked}
                  onChange={(volumeGainDb) => void update({ volumeGainDb })}
                />
              )}
              {supports("supportsStyle") && active?.voice?.styles && (
                <LabeledSelect
                  label={i18n.t("preferences.style")}
                  value={active.selection.style ?? ""}
                  options={[
                    { value: "", title: i18n.t("preferences.style_default") },
                    ...active.voice.styles.map((s) => ({ value: s, title: s })),
                  ]}
                  disabled={locked}
                  onChange={handleStyleChange}
                />
              )}
            </div>
          </Card>
        </div>

        <div>
          <SectionTitle>{i18n.t("preferences.formats_title")}</SectionTitle>
          {/* Formats belong to the selected voice's provider: each provider
              remembers its own choice, so switching providers never shows one
              provider's format under another's name. */}
          <Card className="grid grid-cols-2 gap-4">
            {(["download", "readAloud"] as const).map((purpose) => (
              <LabeledSelect
                key={purpose}
                label={formatLabels[purpose]}
                value={active ? resolveEncoding(settings, active.provider, purpose) : ""}
                options={formatOptions(purpose)}
                disabled={locked || !active}
                onChange={(encoding) => handleFormatChange(purpose, encoding)}
              />
            ))}
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
              disabled={locked}
              onChange={(theme) => void update({ theme: theme as Settings["theme"] })}
            />
          </Card>
        </div>
      </fieldset>
      {hasCommands() && <ShortcutsCard />}
    </div>
  );
}
