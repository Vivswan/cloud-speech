import { useEffect, useMemo, useState } from "react";
import { browser } from "#imports";
import { ErrorNotice } from "@/components/app/ErrorNotice";
import { NewerVersionNote } from "@/components/app/NewerVersionNote";
import { SettingsUnavailable } from "@/components/app/SettingsUnavailable";
import { resolveVoiceLanguage, VoicePicker } from "@/components/app/VoicePicker";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { LabeledSelect } from "@/components/ui/select";
import { LabeledSlider } from "@/components/ui/slider";
import { useGuardedSubject, useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import {
  type EncodingPurpose,
  resolveEncoding,
  withProviderPrefs,
} from "@/lib/settings/provider-state";
import { reconcileSettings, rosterUnknown, selectVoice } from "@/lib/settings/reconcile";
import type { Settings } from "@/lib/settings/storage";
import { getActiveLocale, i18n, type UiLocale } from "@/lib/text/i18n-runtime";
import { languageBaseName, languageDisplayName } from "@/lib/text/language-name";
import { hasCommands } from "@/lib/ui/platform";
import { getProvider } from "@/providers";
import { DEFAULT_RANGES, type NormalizedVoice, type TtsProvider } from "@/providers/types";

// Chrome binds the manifest shortcuts to Cmd on macOS and Ctrl elsewhere.
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

// Chrome reports Mac bindings with bare glyphs; spell them out.
const SHORTCUT_GLYPHS: Record<string, string> = {
  "⌘": "Cmd",
  "⇧": "Shift",
  "⌥": "Option",
  "⌃": "Ctrl",
  "^": "Ctrl",
};

type Capability = "supportsSpeed" | "supportsPitch" | "supportsVolume" | "supportsStyle";

/** The stored selection with what sizes the controls: its provider always, its voice once the roster lists it. */
interface ActiveSelection {
  selection: NonNullable<Settings["selection"]>;
  voice: NormalizedVoice | undefined;
  provider: TtsProvider;
}

interface ProsodyControlsProps {
  settings: Settings;
  active: ActiveSelection | null;
  locked: boolean;
  onUpdate: ReturnType<typeof useSettings>["update"];
  onStyleChange: (style: string) => void;
}

interface VoiceCardProps {
  settings: Settings;
  voices: NormalizedVoice[];
  active: ActiveSelection | null;
  locked: boolean;
  onPickVoice: (voice: NormalizedVoice, model: string, language: string) => void;
  onStyleChange: (style: string) => void;
  onToggleFavorite: (key: string) => void;
  onUpdate: ReturnType<typeof useSettings>["update"];
}

interface FormatsCardProps {
  settings: Settings;
  active: ActiveSelection | null;
  locked: boolean;
  onUpdateWith: ReturnType<typeof useSettings>["updateWith"];
}

interface AppearanceCardProps {
  theme: Settings["theme"];
  locked: boolean;
  onChange: (theme: Settings["theme"]) => void;
}

/** One row per tag, titled by the language alone plus the tag's own region in place of ICU's, so
 *  `zh-CN` and `zh-CN-shaanxi` (both named "Chinese (China)" by ICU) stay distinct rows. */
function languageOptions(voices: NormalizedVoice[], locale: UiLocale) {
  const codes = [...new Set(voices.flatMap((v) => v.languageCodes))].sort();
  return [
    { value: "all", title: i18n.t("preferences.chips_all") },
    ...codes.map((code) => {
      const [, ...region] = code.split("-");
      const title =
        region.length > 0
          ? `${languageBaseName(code, locale)} (${region.join("-")})`
          : languageDisplayName(code, locale);
      return { value: code, title };
    }),
  ];
}

/** Read from the manifest itself, so the suggested combo cannot drift from wxt.config.ts. */
function suggestedShortcut(name: string): string {
  const suggested = browser.runtime.getManifest().commands?.[name]?.suggested_key;
  const raw =
    typeof suggested === "string"
      ? suggested
      : ((IS_MAC ? suggested?.mac : undefined) ?? suggested?.default ?? "");
  return raw.replace("Command", "Cmd");
}

function formatShortcut(raw: string): string {
  return raw
    .split("")
    .map((ch) => (SHORTCUT_GLYPHS[ch] ? `${SHORTCUT_GLYPHS[ch]}+` : ch))
    .join("")
    .replace(/\+\+/g, "+");
}

/** `loaded` tells "not fetched yet" from "answered"; a rejected getAll reads as every shortcut
 *  unassigned. Only mounted where browser.commands exists (ShortcutsCard). */
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

/** Rendered only where the commands API exists: Firefox for Android has no keyboard shortcuts. */
function ShortcutsCard() {
  const shortcuts = useCommandShortcuts();

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
          // Firefox blocks tabs.create for privileged about: pages, so the shortcuts editor cannot
          // be opened programmatically; the text points the user there instead.
          <p className="mt-1 text-xxs text-muted">{i18n.t("settings.edit_shortcuts_firefox")}</p>
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

/** While the selection's provider roster is unknown the voice is unresolved but the selection is
 *  kept, so its provider and engine still size the controls. */
function activeSelection(settings: Settings, voices: NormalizedVoice[]): ActiveSelection | null {
  const selection = settings.selection;
  if (!selection) return null;

  const voice = voices.find(
    (v) => v.providerId === selection.providerId && v.id === selection.voiceId,
  );
  if (!voice && !rosterUnknown(settings, voices, selection.providerId)) return null;

  return { selection, voice, provider: getProvider(selection.providerId) };
}

/** Answered from the voice id while the voice is unresolved: Google knows its no-pitch voices by name. */
function supports(active: ActiveSelection | null, capability: Capability): boolean {
  if (!active) return false;
  const voice = active.voice ?? { id: active.selection.voiceId };
  return active.provider[capability](voice, active.selection.model);
}

/** The voice selection is the subject: a pick's write, the reconcile after it, and a style
 *  change settle here, and a pick overtaken by a later action on it settles into nothing. Every
 *  write lands reconciled, in one locked write under the subject's claim: a refused issues read
 *  or write stores nothing, and whatever an action superseded, the stored selection fits its
 *  voice and provider. */
function useSelectionSubject(voices: NormalizedVoice[]) {
  const pick = useGuardedSubject();

  function write(update: (current: Settings) => Partial<Settings>) {
    void pick.run((claim) => reconcileSettings(claim, voices, update));
  }

  function pickVoice(voice: NormalizedVoice, model: string, language: string) {
    write((current) => selectVoice(current, voice, model, language));
  }

  function changeStyle(style: string) {
    write((current) => {
      if (!current.selection) return {};
      const { style: _previous, ...rest } = current.selection;
      return { selection: style ? { ...rest, style } : rest };
    });
  }

  return { failure: pick.failure, pickVoice, changeStyle };
}

function ProsodyControls({
  settings,
  active,
  locked,
  onUpdate,
  onStyleChange,
}: ProsodyControlsProps) {
  const ranges = active ? active.provider.ranges(active.selection.model) : DEFAULT_RANGES;

  return (
    <div className="grid gap-3 pt-1">
      {supports(active, "supportsSpeed") && (
        <LabeledSlider
          label={i18n.t("preferences.speed")}
          value={settings.speed}
          min={ranges.speed.min}
          max={ranges.speed.max}
          step={ranges.speed.step}
          unit="x"
          disabled={locked}
          onChange={(speed) => void onUpdate({ speed })}
        />
      )}
      {supports(active, "supportsPitch") && (
        <LabeledSlider
          label={i18n.t("preferences.pitch")}
          value={settings.pitch}
          min={ranges.pitch.min}
          max={ranges.pitch.max}
          step={ranges.pitch.step}
          disabled={locked}
          onChange={(pitch) => void onUpdate({ pitch })}
        />
      )}
      {supports(active, "supportsVolume") && (
        <LabeledSlider
          label={i18n.t("preferences.volume")}
          value={settings.volumeGainDb}
          min={ranges.volumeGainDb.min}
          max={ranges.volumeGainDb.max}
          step={ranges.volumeGainDb.step}
          unit="dB"
          disabled={locked}
          onChange={(volumeGainDb) => void onUpdate({ volumeGainDb })}
        />
      )}
      {supports(active, "supportsStyle") && active?.voice?.styles && (
        <LabeledSelect
          label={i18n.t("preferences.style")}
          value={active.selection.style ?? ""}
          options={[
            { value: "", title: i18n.t("preferences.style_default") },
            ...active.voice.styles.map((s) => ({ value: s, title: s })),
          ]}
          disabled={locked}
          onChange={onStyleChange}
        />
      )}
    </div>
  );
}

/** The language select only filters the picker; the chosen voice carries the playback language
 *  and decides which prosody controls show. */
function VoiceCard({
  settings,
  voices,
  active,
  locked,
  onPickVoice,
  onStyleChange,
  onToggleFavorite,
  onUpdate,
}: VoiceCardProps) {
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);
  const locale = getActiveLocale();
  const langOptions = useMemo(() => languageOptions(voices, locale), [voices, locale]);
  // settings.language can name a language no current voice offers (voices changed, provider
  // disabled); an unknown filter value would show the raw code in the select and filter the picker to nothing.
  const requestedFilter = languageFilter ?? settings.language ?? "all";
  const effectiveFilter = langOptions.some((option) => option.value === requestedFilter)
    ? requestedFilter
    : "all";
  const hasVoices = voices.length > 0;
  const voiceUnlisted = active !== null && active.voice === undefined;

  function handleSelectVoice(voice: NormalizedVoice, model: string) {
    onPickVoice(voice, model, resolveVoiceLanguage(voice, effectiveFilter));
  }

  return (
    <Card className="flex flex-col gap-4">
      {/* No engine selector: multi-engine voices appear as one row per engine in the picker,
        so choosing a row chooses both. */}
      <LabeledSelect
        label={i18n.t("preferences.language")}
        value={effectiveFilter}
        options={langOptions}
        disabled={locked || !hasVoices}
        onChange={setLanguageFilter}
      />
      {/* The select alone only filters the picker; playback language changes when a voice is
        chosen. Without the hint a user who switches to French and closes the popup still
        hears the old language. */}
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
        onToggleFavorite={onToggleFavorite}
      />
      {hasVoices && (
        <div className="ml-1 text-xxs text-muted">{i18n.t("preferences.voice_tip")}</div>
      )}

      <ProsodyControls
        settings={settings}
        active={active}
        locked={locked}
        onUpdate={onUpdate}
        onStyleChange={onStyleChange}
      />
    </Card>
  );
}

/** Formats belong to the selected voice's provider: each remembers its own choice, so switching
 *  providers never shows one provider's format under another's name. */
function FormatsCard({ settings, active, locked, onUpdateWith }: FormatsCardProps) {
  const formatLabels: Record<EncodingPurpose, string> = {
    download: i18n.t("preferences.download_format"),
    readAloud: i18n.t("preferences.read_aloud_format"),
  };

  function formatOptions(purpose: EncodingPurpose) {
    if (!active) return [];
    return active.provider.audioFormats
      .filter((f) => (purpose === "readAloud" ? f.forReadAloud : f.forDownload))
      .map((f) => ({ value: f.id, title: f.label }));
  }

  function handleFormatChange(purpose: EncodingPurpose, encoding: string) {
    if (!active) return;
    const providerId = active.provider.id;
    const patch =
      purpose === "readAloud" ? { readAloudEncoding: encoding } : { downloadEncoding: encoding };
    void onUpdateWith((current) => withProviderPrefs(current, providerId, patch));
  }

  return (
    <div>
      <SectionTitle>{i18n.t("preferences.formats_title")}</SectionTitle>
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
  );
}

function AppearanceCard({ theme, locked, onChange }: AppearanceCardProps) {
  return (
    <div>
      <SectionTitle>{i18n.t("preferences.appearance_title")}</SectionTitle>
      <Card>
        <LabeledSelect
          label={i18n.t("preferences.theme")}
          value={theme}
          options={[
            { value: "system", title: i18n.t("preferences.theme_system") },
            { value: "light", title: i18n.t("preferences.theme_light") },
            { value: "dark", title: i18n.t("preferences.theme_dark") },
          ]}
          disabled={locked}
          onChange={(value) => onChange(value as Settings["theme"])}
        />
      </Card>
    </div>
  );
}

export function Preferences() {
  const { settings, update, updateWith, writeFailure, newerVersion } = useSettings();
  const voices = useVoices();
  const subject = useSelectionSubject(voices);

  if (settings === null) return <SettingsUnavailable failure={writeFailure} />;

  const active = activeSelection(settings, voices);
  const hasVoices = voices.length > 0;
  // Slider thumbs are spans, not form controls, and the picker's popover renders outside the
  // fieldset altogether, so the lock is passed to every control as well.
  const locked = newerVersion !== null;

  async function handleToggleFavorite(key: string) {
    await updateWith((current) => ({
      favorites: current.favorites.includes(key)
        ? current.favorites.filter((f) => f !== key)
        : [...current.favorites, key],
    }));
  }

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
          {subject.failure && (
            <ErrorNotice
              error={subject.failure.value}
              reportKey={subject.failure.key}
              className="mb-2"
            />
          )}
          {!hasVoices && !active && (
            <div className="mb-2 rounded border border-note-edge bg-note p-3 text-xs text-note-text">
              {i18n.t("preferences.no_voices")}
            </div>
          )}
          <VoiceCard
            settings={settings}
            voices={voices}
            active={active}
            locked={locked}
            onPickVoice={subject.pickVoice}
            onStyleChange={subject.changeStyle}
            onToggleFavorite={handleToggleFavorite}
            onUpdate={update}
          />
        </div>
        <FormatsCard
          settings={settings}
          active={active}
          locked={locked}
          onUpdateWith={updateWith}
        />
        <AppearanceCard
          theme={settings.theme}
          locked={locked}
          onChange={(theme) => void update({ theme })}
        />
      </fieldset>
      {hasCommands() && <ShortcutsCard />}
    </div>
  );
}
