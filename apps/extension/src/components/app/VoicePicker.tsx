import Fuse from "fuse.js";
import { ChevronDown, Play, Search, Star, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ErrorNoticeBody } from "@/components/app/ErrorNotice";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePreview } from "@/hooks/usePreview";
import { useVoiceIssues } from "@/hooks/useVoiceIssues";
import { sameVoiceModelRef } from "@/lib/audio/playback";
import { togglePreview } from "@/lib/audio/player-actions";
import type { ErrorPayload } from "@/lib/messaging/protocol";
import {
  type Selection,
  type VoiceIssue,
  type VoiceIssues,
  type VoiceModelRef,
  voiceIssue,
} from "@/lib/settings/storage";
import { voiceKey } from "@/lib/settings/voice-key";
import { getActiveLocale, i18n, tDynamic } from "@/lib/text/i18n-runtime";
import { languageDisplayName } from "@/lib/text/language-name";
import { cn } from "@/lib/ui/cn";
import { getProvider, providerList } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Audition never changes the selection. Composite keys come from lib/settings/voice-key
// (`providerId:voiceId`, split on the FIRST colon only).
// ---------------------------------------------------------------------------

/** A filter chip: "all", "fav", or a provider id, with its label. */
type Chip = [value: string, label: string];

/** One list row: a voice on one of its engines, with the cached failure for that pair when there is one. */
interface Entry {
  voice: NormalizedVoice;
  model: string;
  multiModel: boolean;
  issue: VoiceIssue | undefined;
}

/** One flagged row's identity, so pinning another row remounts the panel and its Details start collapsed again. */
interface PinnedIssue {
  row: string;
  name: string;
  reason: ErrorPayload;
}

interface VoiceFilter {
  voices: NormalizedVoice[];
  languageFilter: string;
  chip: string;
  query: string;
  favoriteSet: Set<string>;
}

export interface VoicePickerProps {
  /** The cached roster; the chips and the search narrow it here. */
  voices: NormalizedVoice[];

  /** The saved voice and engine; null while nothing has been picked. */
  selection: Selection | null;

  /** The selection's provider has nothing in the cache, so the trigger describes the selection from its own fields. */
  rosterUnknown?: boolean;

  /** Composite voice keys (`providerId:voiceId`); a disabled provider's stars are hidden here, never pruned. */
  favorites: string[];

  /** A language code, or "all". */
  languageFilter: string;

  /** The popover content is portaled outside any enclosing disabled fieldset, so the lock has to be passed in. */
  disabled?: boolean;

  /** Called per row, so `model` is the row's engine, not necessarily the voice's first. */
  onSelect: (voice: NormalizedVoice, model: string) => void;

  /** Takes the voice's composite key, the form `favorites` holds. */
  onToggleFavorite: (key: string) => void;
}

/** The active language filter wins when the voice speaks it (a multilingual voice auditioned while
 *  filtering French means French); otherwise the voice's first language. */
export function resolveVoiceLanguage(voice: NormalizedVoice, languageFilter: string): string {
  return languageFilter !== "all" && voice.languageCodes.includes(languageFilter)
    ? languageFilter
    : voice.languageCodes[0];
}

function modelLabel(providerId: ProviderId, model: string): string {
  const option = getProvider(providerId).models.find((m) => m.value === model);
  return option ? tDynamic(option.labelKey) : model;
}

function filterVoices({
  voices,
  languageFilter,
  chip,
  query,
  favoriteSet,
}: VoiceFilter): NormalizedVoice[] {
  let list = voices;
  if (languageFilter && languageFilter !== "all") {
    list = list.filter((v) => v.languageCodes.includes(languageFilter));
  }

  if (chip === "fav") {
    list = list.filter((v) => favoriteSet.has(voiceKey(v)));
  } else if (chip !== "all") {
    list = list.filter((v) => v.providerId === chip);
  }

  if (query.trim()) {
    const fuse = new Fuse(list, {
      keys: ["displayName", "id", "providerId", "languageCodes", "gender", "models"],
      threshold: 0.35,
    });
    list = fuse.search(query.trim()).map((r) => r.item);
  }

  return list;
}

/** Issues are per (voice, engine): a dual-engine voice can work on neural and fail on standard,
 *  so entries are partitioned, not voices. */
function partitionEntries(
  voices: NormalizedVoice[],
  issues: VoiceIssues,
): { available: Entry[]; unavailable: Entry[] } {
  const entries = voices.flatMap((voice) =>
    voice.models.map((model) => ({
      voice,
      model,
      multiModel: voice.models.length > 1,
      issue: voiceIssue(issues, { providerId: voice.providerId, voiceId: voice.id, model }),
    })),
  );

  return {
    available: entries.filter((entry) => !entry.issue),
    unavailable: entries.filter((entry) => entry.issue),
  };
}

function isSelectedEntry(entry: Entry, selection: Selection | null): boolean {
  return (
    selection?.providerId === entry.voice.providerId &&
    selection.voiceId === entry.voice.id &&
    (!entry.multiModel || entry.model === selection.model)
  );
}

/** Favorites persist forever but the chip filters against the live cache, so after disabling a
 *  provider its stars vanish. The count tells the user they are hidden, not deleted; never prune. */
function hiddenFavoriteCount(favorites: string[], voices: NormalizedVoice[]): number {
  return favorites.filter((key) => !voices.some((voice) => voiceKey(voice) === key)).length;
}

/** All, Favorites, then one chip per provider in the roster. The choice itself is kept while its
 *  provider is off the roster, so the pressed chip falls back to All until the provider returns. */
function useChipFilter(voices: NormalizedVoice[]): {
  chips: Chip[];
  chip: string;
  setChosenChip: (value: string) => void;
} {
  const [chosenChip, setChosenChip] = useState("all");
  const providersWithVoices = providerList.filter((p) => voices.some((v) => v.providerId === p.id));
  const chips: Chip[] = [
    ["all", i18n.t("preferences.chips_all")],
    ["fav", i18n.t("preferences.chips_favorites")],
    ...providersWithVoices.map((p): Chip => [p.id, tDynamic(p.labelKey)]),
  ];
  const chip = chips.some(([value]) => value === chosenChip) ? chosenChip : "all";

  return { chips, chip, setChosenChip };
}

function ProviderDot({ providerId }: { providerId: ProviderId }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: getProvider(providerId).color }}
    />
  );
}

function PreviewButton({
  voice,
  model,
  language,
  auditioning,
  size = 6,
  disabled,
}: {
  /** The row's voice; auditioning it never changes the selection. */
  voice: NormalizedVoice;

  /** The row's engine: the trigger passes the selection's, a list row its own. */
  model?: string;

  /** Must be one of voice.languageCodes. */
  language?: string;

  /** Read once by the picker and passed down, so no button subscribes to storage itself. */
  auditioning: VoiceModelRef | null;

  /** Tailwind spacing units: 6 in a list row, 7 on the trigger. */
  size?: 6 | 7;

  /** The picker's lock; only the trigger's button passes it, since the list closes while locked. */
  disabled?: boolean;
}) {
  // Distinct engines sound different, so audition exactly the row's variant.
  const row: VoiceModelRef = {
    providerId: voice.providerId,
    voiceId: voice.id,
    model: model ?? voice.models[0],
  };
  const active = auditioning !== null && sameVoiceModelRef(auditioning, row);

  return (
    <button
      type="button"
      title={i18n.t("preferences.preview")}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full cursor-pointer transition-[transform,background-color] duration-150 ease-snap active:scale-[0.94]",
        size === 6 ? "h-6 w-6" : "h-7 w-7",
        active
          ? "bg-amber-100 text-amber-900 dark:bg-note dark:text-note-text"
          : "bg-inset text-muted hover:bg-fill",
      )}
      onClick={(e) => {
        e.stopPropagation();
        void togglePreview({ ...row, language: language ?? voice.languageCodes[0] });
      }}
    >
      {active ? (
        <span className="flex h-3 items-end gap-[2px]">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-[3px] animate-pulse rounded bg-brand"
              style={{ height: `${[7, 12, 9][i]}px`, animationDelay: `${i * 150}ms` }}
            />
          ))}
        </span>
      ) : (
        <Play size={11} fill="currentColor" />
      )}
    </button>
  );
}

function TriggerSummary({
  selection,
  selectedVoice,
  rosterUnknown,
}: {
  selection: Selection | null;
  selectedVoice: NormalizedVoice | undefined;
  rosterUnknown: boolean;
}) {
  if (selectedVoice && selection) {
    return (
      <span className="min-w-0 flex-1">
        <span className="block truncate text-strong">
          {selectedVoice.displayName}
          {selectedVoice.models.length > 1 && (
            <span className="font-medium text-muted">
              {" "}
              · {modelLabel(selectedVoice.providerId, selection.model)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 truncate text-xxs text-muted">
          <ProviderDot providerId={selectedVoice.providerId} />
          {languageDisplayName(selectedVoice.languageCodes[0], getActiveLocale())} ·{" "}
          {tDynamic(getProvider(selectedVoice.providerId).labelKey)} · {selectedVoice.gender}
        </span>
      </span>
    );
  }

  // Shown from its own fields: the voice id stands in for the display name, and the engine always
  // shows since which engines the voice offers is unknown too.
  if (rosterUnknown && selection) {
    return (
      <span className="min-w-0 flex-1">
        <span className="block truncate text-strong">
          {selection.voiceId}
          <span className="font-medium text-muted">
            {" "}
            · {modelLabel(selection.providerId, selection.model)}
          </span>
        </span>
        <span className="flex items-center gap-1 truncate text-xxs text-muted">
          <ProviderDot providerId={selection.providerId} />
          {tDynamic(getProvider(selection.providerId).labelKey)}
        </span>
        <span className="flex items-center gap-1 truncate text-xxs font-medium text-note-text">
          <TriangleAlert size={11} className="shrink-0" />
          {i18n.t("preferences.voice_list_unavailable")}
        </span>
      </span>
    );
  }

  return <span className="flex-1 text-muted">{i18n.t("preferences.no_voices")}</span>;
}

/** The Voice label, the trigger, and the selection's preview button floating over the trigger as a
 *  sibling, since a <button> cannot nest another one. */
function PickerTrigger({
  voices,
  selection,
  rosterUnknown,
  languageFilter,
  auditioning,
  disabled,
}: {
  voices: NormalizedVoice[];
  selection: Selection | null;
  rosterUnknown: boolean;
  languageFilter: string;
  auditioning: VoiceModelRef | null;
  disabled: boolean;
}) {
  const labelId = useId();
  const triggerId = useId();
  const selectedVoice = selection
    ? voices.find((v) => v.providerId === selection.providerId && v.id === selection.voiceId)
    : undefined;

  return (
    <div className="relative font-semibold text-xs">
      <span id={labelId} className="bg-card absolute text-xxs -top-2 left-1.5 px-1 text-muted z-10">
        {i18n.t("preferences.voice")}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          // Label first, then the trigger's own content: the selected voice and its engine.
          aria-labelledby={`${labelId} ${triggerId}`}
          disabled={disabled}
          className={cn(
            "flex min-h-[42px] w-full cursor-pointer items-center gap-2 rounded-md border border-edge bg-card py-1.5 pr-2.5 text-left",
            // Room for the preview button floating over the trigger.
            selectedVoice ? "pl-12" : "pl-2.5",
          )}
        >
          <TriggerSummary
            selection={selection}
            selectedVoice={selectedVoice}
            rosterUnknown={rosterUnknown}
          />
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      {selectedVoice && selection && (
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2">
          <PreviewButton
            voice={selectedVoice}
            model={selection.model}
            language={resolveVoiceLanguage(selectedVoice, languageFilter)}
            auditioning={auditioning}
            size={7}
            disabled={disabled}
          />
        </span>
      )}
    </div>
  );
}

function SearchAndChips({
  query,
  onQueryChange,
  chips,
  chip,
  onChipChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  chips: Chip[];
  chip: string;
  onChipChange: (value: string) => void;
}) {
  return (
    <div className="sticky top-0 rounded-t border-b border-edge-soft bg-card p-1.5">
      <div className="relative">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
        <input
          // biome-ignore lint/a11y/noAutofocus: search-first picker UX
          autoFocus
          value={query}
          placeholder={i18n.t("preferences.voice_search")}
          className="w-full rounded-md border border-edge py-1.5 pl-6 pr-2 text-xs focus:border-edge-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong"
          onChange={(e) => onQueryChange(e.currentTarget.value)}
        />
      </div>
      <fieldset className="mt-1.5 flex flex-wrap gap-1">
        <legend className="sr-only">{i18n.t("preferences.voice_filters")}</legend>
        {chips.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={chip === value}
            className={cn(
              "cursor-pointer rounded-full border px-2 py-0.5 text-xxs font-semibold transition-colors duration-150",
              chip === value
                ? "border-amber-600/50 bg-brand text-ink"
                : "border-edge text-body hover:bg-inset",
            )}
            onClick={() => onChipChange(value)}
          >
            {value === "fav" && <span aria-hidden="true">{"★ "}</span>}
            {label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

function IssueMark({ issue, onPin }: { issue: ErrorPayload; onPin: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={i18n.t("preferences.show_issue")}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-danger hover:text-danger/80"
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
        >
          <TriangleAlert size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        className="max-w-64 border border-danger-edge bg-danger-surface px-2.5 py-2 text-xxs text-danger"
      >
        {/* The message alone: Radix closes the tooltip when focus leaves the trigger,
            so a link or Details toggle inside it could never be reached by keyboard. */}
        {issue.message}
      </TooltipContent>
    </Tooltip>
  );
}

function FavoriteStar({ favorite, onToggle }: { favorite: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={i18n.t("preferences.favorite")}
      aria-pressed={favorite}
      className={cn(
        "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center",
        favorite ? "text-amber-700 dark:text-amber-500" : "text-muted hover:text-body",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Star size={14} fill={favorite ? "currentColor" : "none"} />
    </button>
  );
}

function VoiceRow({
  entry,
  selected,
  favorite,
  language,
  auditioning,
  onSelect,
  onToggleFavorite,
  onPinIssue,
}: {
  entry: Entry;
  selected: boolean;
  favorite: boolean;
  language: string;
  auditioning: VoiceModelRef | null;
  onSelect: (voice: NormalizedVoice, model: string) => void;
  onToggleFavorite: (key: string) => void;
  onPinIssue: (issue: PinnedIssue) => void;
}) {
  const { voice, model, multiModel, issue } = entry;
  const key = voiceKey(voice);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1.5",
        selected
          ? "bg-highlight/40 ring-1 ring-amber-300/70 dark:bg-highlight/15 dark:ring-amber-300/30"
          : "hover:bg-inset",
      )}
    >
      <PreviewButton voice={voice} model={model} language={language} auditioning={auditioning} />
      <button
        type="button"
        // Only the words dim, and only to where body text still passes 4.5:1; the preview,
        // issue, and favorite controls stay at full strength.
        className={cn("min-w-0 flex-1 cursor-pointer text-left", issue && "opacity-75")}
        onClick={() => onSelect(voice, model)}
      >
        <div className="truncate text-xs font-semibold text-body">
          {voice.displayName}
          {multiModel && (
            <span className="font-medium text-body"> · {modelLabel(voice.providerId, model)}</span>
          )}
        </div>
        <div
          className={cn(
            "flex items-center gap-1 truncate text-xxs",
            issue ? "text-body" : "text-muted",
          )}
        >
          <ProviderDot providerId={voice.providerId} />
          {languageDisplayName(voice.languageCodes[0], getActiveLocale())} ·{" "}
          {tDynamic(getProvider(voice.providerId).labelKey)} · {voice.gender}
        </div>
      </button>
      {issue && (
        <IssueMark
          issue={issue}
          onPin={() =>
            onPinIssue({ row: `${key}:${model}`, name: voice.displayName, reason: issue })
          }
        />
      )}
      <FavoriteStar favorite={favorite} onToggle={() => onToggleFavorite(key)} />
    </div>
  );
}

function VoiceList({
  voices,
  issues,
  selection,
  favoriteSet,
  languageFilter,
  auditioning,
  staleFavoriteCount,
  onSelect,
  onToggleFavorite,
  onPinIssue,
}: {
  voices: NormalizedVoice[];
  issues: VoiceIssues;
  selection: Selection | null;
  favoriteSet: Set<string>;
  languageFilter: string;
  auditioning: VoiceModelRef | null;
  staleFavoriteCount: number;
  onSelect: (voice: NormalizedVoice, model: string) => void;
  onToggleFavorite: (key: string) => void;
  onPinIssue: (issue: PinnedIssue) => void;
}) {
  const { available, unavailable } = partitionEntries(voices, issues);

  return (
    <div className="max-h-60 overflow-auto p-1">
      {voices.length === 0 && (
        <div className="py-6 text-center text-xs text-muted">
          {i18n.t("preferences.no_results")}
        </div>
      )}
      {[...available, ...unavailable].map((entry) => (
        <div key={`${voiceKey(entry.voice)}:${entry.model}`}>
          {entry === unavailable[0] && (
            <div className="mt-1 flex items-center gap-1.5 border-t border-edge-soft px-2 pb-0.5 pt-2 text-xxs font-semibold text-muted">
              <TriangleAlert size={11} />
              {i18n.t("preferences.unavailable")}
            </div>
          )}
          <VoiceRow
            entry={entry}
            selected={isSelectedEntry(entry, selection)}
            favorite={favoriteSet.has(voiceKey(entry.voice))}
            language={resolveVoiceLanguage(entry.voice, languageFilter)}
            auditioning={auditioning}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
            onPinIssue={onPinIssue}
          />
        </div>
      ))}
      {staleFavoriteCount > 0 && (
        <div className="mt-1 border-t border-edge-soft px-2 pb-0.5 pt-1.5 text-xxs text-muted">
          {i18n.t("preferences.favorites_unavailable", [String(staleFavoriteCount)])}
        </div>
      )}
    </div>
  );
}

/** The notice body without its title (the voice name is the heading) or close (the panel has its own). */
function IssueReason({ reason }: { reason: ErrorPayload }) {
  return (
    <div className="space-y-1 text-xxs text-danger">
      <ErrorNoticeBody error={reason} />
    </div>
  );
}

/** The pinned reason under the list; the caller keys it by the row so a new occupant starts collapsed. */
function PinnedIssuePanel({ issue, onDismiss }: { issue: PinnedIssue; onDismiss: () => void }) {
  return (
    <div className="sticky bottom-0 flex items-start gap-2 rounded-b-md border-t border-danger-edge bg-danger-surface px-2.5 py-2">
      <div className="min-w-0 flex-1 cursor-text select-text">
        <div className="mb-1 text-xxs font-semibold text-danger">{issue.name}</div>
        <IssueReason reason={issue.reason} />
      </div>
      <button
        type="button"
        title={i18n.t("common.dismiss")}
        className="shrink-0 cursor-pointer rounded p-0.5 text-danger/70 hover:bg-danger-edge/40 hover:text-danger"
        onClick={onDismiss}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function VoicePicker({
  voices,
  selection,
  rosterUnknown = false,
  favorites,
  languageFilter,
  disabled = false,
  onSelect,
  onToggleFavorite,
}: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pinnedIssue, setPinnedIssue] = useState<PinnedIssue | null>(null);
  const { chips, chip, setChosenChip } = useChipFilter(voices);
  const issues = useVoiceIssues();
  const auditioning = usePreview();
  const close = () => {
    setOpen(false);
    setPinnedIssue(null);
  };
  // Closed for good, not hidden: the picker would otherwise pop back open the moment it is enabled again.
  if (disabled && open) close();

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const filtered = useMemo(
    () => filterVoices({ voices, languageFilter, chip, query, favoriteSet }),
    [voices, languageFilter, chip, query, favoriteSet],
  );
  const staleFavoriteCount = chip === "fav" ? hiddenFavoriteCount(favorites, voices) : 0;

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PickerTrigger
        voices={voices}
        selection={selection}
        rosterUnknown={rosterUnknown}
        languageFilter={languageFilter}
        auditioning={auditioning}
        disabled={disabled}
      />

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <SearchAndChips
          query={query}
          onQueryChange={setQuery}
          chips={chips}
          chip={chip}
          onChipChange={setChosenChip}
        />
        <VoiceList
          voices={filtered}
          issues={issues}
          selection={selection}
          favoriteSet={favoriteSet}
          languageFilter={languageFilter}
          auditioning={auditioning}
          staleFavoriteCount={staleFavoriteCount}
          onSelect={(voice, model) => {
            onSelect(voice, model);
            setOpen(false);
          }}
          onToggleFavorite={onToggleFavorite}
          onPinIssue={setPinnedIssue}
        />
        {pinnedIssue && (
          <PinnedIssuePanel
            key={pinnedIssue.row}
            issue={pinnedIssue}
            onDismiss={() => setPinnedIssue(null)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
