import Fuse from "fuse.js";
import { ChevronDown, Play, Search, Star, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVoiceIssues } from "@/hooks/useVoiceIssues";
import { cn } from "@/lib/cn";
import { i18n, tDynamic } from "@/lib/i18n-runtime";
import type { SelectedVoice } from "@/lib/storage";
import { getProvider, providerList } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";
import { usePlayerStore } from "@/stores/player";

// ---------------------------------------------------------------------------
// VoicePicker: flat searchable list with provider filter chips, ▶ audition
// on every row (never changes the selection), and ★ favorites.
// Composite keys are `providerId:voiceId`, split on the FIRST colon only.
// ---------------------------------------------------------------------------

export function voiceKey(voice: NormalizedVoice): string {
  return `${voice.providerId}:${voice.id}`;
}

export function parseVoiceKey(key: string): SelectedVoice | null {
  const colon = key.indexOf(":");
  if (colon === -1) return null;
  const providerId = key.slice(0, colon) as ProviderId;
  const voiceId = key.slice(colon + 1);
  if (!voiceId) return null;
  return { providerId, voiceId };
}

function languageLabel(code: string): string {
  if (code === "multilingual") return i18n.t("preferences.multilingual");
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    const parts = code.split("-");
    const normalized = parts.length > 2 ? `${parts[0]}-${parts[1]}` : code;
    return displayNames.of(normalized) ?? code;
  } catch {
    return code;
  }
}

function modelLabel(providerId: ProviderId, model: string): string {
  const option = getProvider(providerId).models.find((m) => m.value === model);
  return option ? tDynamic(option.labelKey) : model;
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
  size = 6,
}: {
  voice: NormalizedVoice;
  model?: string;
  /** Language to audition in; must be one of voice.languageCodes. Falls back
   *  to the voice's first language. */
  language?: string;
  size?: 6 | 7;
}) {
  const previewingKey = usePlayerStore((s) => s.previewingKey);
  const preview = usePlayerStore((s) => s.preview);
  const effectiveModel = model ?? voice.models[0] ?? "neural";
  // Distinct engines sound different, so audition exactly the row's variant.
  const key = `${voiceKey(voice)}:${effectiveModel}`;
  const active = previewingKey === key;

  return (
    <button
      type="button"
      title={i18n.t("preferences.preview")}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full cursor-pointer transition-[transform,background-color] duration-150 ease-snap active:scale-[0.94]",
        size === 6 ? "h-6 w-6" : "h-7 w-7",
        active
          ? "bg-amber-100 text-amber-900 dark:bg-note dark:text-note-text"
          : "bg-inset text-muted hover:bg-fill",
      )}
      onClick={(e) => {
        e.stopPropagation();
        void preview(key, {
          providerId: voice.providerId,
          voiceId: voice.id,
          model: effectiveModel,
          language: language ?? voice.languageCodes[0],
        });
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

export interface VoicePickerProps {
  voices: NormalizedVoice[];
  selected: SelectedVoice | null;
  /** The engine of the current selection (settings.model). */
  selectedModel: string;
  favorites: string[];
  languageFilter: string;
  onSelect: (voice: NormalizedVoice, model: string) => void;
  onToggleFavorite: (key: string) => void;
}

export function VoicePicker({
  voices,
  selected,
  selectedModel,
  favorites,
  languageFilter,
  onSelect,
  onToggleFavorite,
}: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("all");
  const issues = useVoiceIssues();
  // Full error pinned to the popover's bottom (selectable) via the ⚠ icon.
  const [pinnedIssue, setPinnedIssue] = useState<{ name: string; text: string } | null>(null);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const selectedVoice = selected
    ? voices.find((v) => v.providerId === selected.providerId && v.id === selected.voiceId)
    : undefined;

  const providersWithVoices = providerList.filter((p) => voices.some((v) => v.providerId === p.id));

  const filtered = useMemo(() => {
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
  }, [voices, languageFilter, chip, query, favoriteSet]);

  // Multi-engine voices (dual-engine Polly, OpenAI quality tiers) get one row
  // per engine; selecting a row picks voice AND engine, no separate selector.
  const expand = (voice: NormalizedVoice) =>
    (voice.models.length > 1 ? voice.models : [voice.models[0] ?? "neural"]).map((model) => ({
      voice,
      model,
      multiModel: voice.models.length > 1,
    }));

  // Issues are recorded per (voice, engine), since a dual-engine voice can
  // work on neural and fail on standard. So the ROWS are partitioned, not the
  // voices: broken engines sink into their own section.
  const entries = filtered.flatMap(expand);
  const entryIssue = (entry: { voice: NormalizedVoice; model: string }) =>
    issues[`${voiceKey(entry.voice)}:${entry.model}`];
  const availableEntries = entries.filter((entry) => !entryIssue(entry));
  const unavailableEntries = entries.filter((entry) => entryIssue(entry));

  // Audition the language the row would actually configure: selecting while
  // filtering French sets French, so the ▶ preview must speak French too,
  // not whatever languageCodes[0] happens to be.
  const previewLanguage = (voice: NormalizedVoice) =>
    voice.languageCodes.includes(languageFilter) ? languageFilter : undefined;

  const chips: Array<[string, string]> = [
    ["all", i18n.t("preferences.chips_all")],
    ["fav", i18n.t("preferences.chips_favorites")],
    ...providersWithVoices.map((p) => [p.id, tDynamic(p.labelKey)] as [string, string]),
  ];

  // Favorites persist forever, but the fav chip filters against the live
  // voice cache: after disabling a provider its stars silently vanish. Count
  // them so the user learns they are hidden, not deleted (never prune).
  const staleFavoriteCount =
    chip === "fav"
      ? favorites.filter((key) => !voices.some((voice) => voiceKey(voice) === key)).length
      : 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPinnedIssue(null);
      }}
    >
      <div className="relative font-semibold text-xs">
        <span className="bg-card absolute text-xxs -top-2 left-1.5 px-1 text-muted z-10">
          {i18n.t("preferences.voice")}
        </span>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-h-[42px] w-full cursor-pointer items-center gap-2 rounded-md border border-edge bg-card py-1.5 pr-2.5 text-left",
              // Reserve room for the preview button, which floats over the
              // trigger as a sibling, since a <button> can't nest another one.
              selectedVoice ? "pl-12" : "pl-2.5",
            )}
          >
            {selectedVoice ? (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-strong">
                  {selectedVoice.displayName}
                  {selectedVoice.models.length > 1 && (
                    <span className="font-medium text-faint">
                      {" "}
                      · {modelLabel(selectedVoice.providerId, selectedModel)}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1 truncate text-xxs text-muted">
                  <ProviderDot providerId={selectedVoice.providerId} />
                  {languageLabel(selectedVoice.languageCodes[0] ?? "")} ·{" "}
                  {tDynamic(getProvider(selectedVoice.providerId).labelKey)} ·{" "}
                  {selectedVoice.gender}
                </span>
              </span>
            ) : (
              <span className="flex-1 text-faint">{i18n.t("preferences.no_voices")}</span>
            )}
            <ChevronDown size={14} className="shrink-0 text-faint" />
          </button>
        </PopoverTrigger>
        {selectedVoice && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2">
            {/* Audition exactly the engine that's selected, not models[0]. */}
            <PreviewButton
              voice={selectedVoice}
              model={selectedModel}
              language={previewLanguage(selectedVoice)}
              size={7}
            />
          </span>
        )}
      </div>

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <div className="sticky top-0 rounded-t border-b border-edge-soft bg-card p-1.5">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
            <input
              // biome-ignore lint/a11y/noAutofocus: search-first picker UX
              autoFocus
              value={query}
              placeholder={i18n.t("preferences.voice_search")}
              className="w-full rounded-md border border-edge py-1.5 pl-6 pr-2 text-xs outline-none focus:border-edge-strong"
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {chips.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "cursor-pointer rounded-full border px-2 py-0.5 text-xxs font-semibold transition-colors duration-150",
                  chip === value
                    ? "border-amber-600/50 bg-brand text-ink"
                    : "border-edge text-body hover:bg-inset",
                )}
                onClick={() => setChip(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-60 overflow-auto p-1">
          {filtered.length === 0 && (
            <div className="py-6 text-center text-xs text-faint">
              {i18n.t("preferences.no_results")}
            </div>
          )}
          {[...availableEntries, ...unavailableEntries].map((entry) => {
            const { voice, model, multiModel } = entry;
            const key = voiceKey(voice);
            const issue = entryIssue(entry);
            const isSelected =
              selected?.providerId === voice.providerId &&
              selected?.voiceId === voice.id &&
              (!multiModel || model === selectedModel);
            const isFavorite = favoriteSet.has(key);
            const firstUnavailable = unavailableEntries[0] === entry;

            return (
              <div key={`${key}:${model}`}>
                {firstUnavailable && (
                  <div className="mt-1 flex items-center gap-1.5 border-t border-edge-soft px-2 pb-0.5 pt-2 text-xxs font-semibold text-faint">
                    <TriangleAlert size={11} />
                    {i18n.t("preferences.unavailable")}
                  </div>
                )}
                <div
                  className={cn(
                    "flex items-center gap-2 rounded px-2 py-1.5",
                    isSelected
                      ? "bg-highlight/40 ring-1 ring-amber-300/70 dark:bg-highlight/15 dark:ring-amber-300/30"
                      : "hover:bg-inset",
                    issue && "opacity-55",
                  )}
                >
                  <PreviewButton voice={voice} model={model} language={previewLanguage(voice)} />
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    onClick={() => {
                      onSelect(voice, model);
                      setOpen(false);
                    }}
                  >
                    <div className="truncate text-xs font-semibold text-body">
                      {voice.displayName}
                      {multiModel && (
                        <span className="font-medium text-faint">
                          {" "}
                          · {modelLabel(voice.providerId, model)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 truncate text-xxs text-muted">
                      <ProviderDot providerId={voice.providerId} />
                      {languageLabel(voice.languageCodes[0] ?? "")} ·{" "}
                      {tDynamic(getProvider(voice.providerId).labelKey)} · {voice.gender}
                    </div>
                  </button>
                  {issue && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={i18n.t("preferences.show_issue")}
                          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-danger hover:text-danger/80"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPinnedIssue({
                              name: voice.displayName,
                              text: issue.replace(/^Error:\s*/, ""),
                            });
                          }}
                        >
                          <TriangleAlert size={13} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">{issue.replace(/^Error:\s*/, "")}</TooltipContent>
                    </Tooltip>
                  )}
                  <button
                    type="button"
                    title={i18n.t("preferences.favorite")}
                    className={cn(
                      "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center",
                      isFavorite ? "text-amber-400" : "text-faint hover:text-muted",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(key);
                    }}
                  >
                    <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
                  </button>
                </div>
              </div>
            );
          })}
          {staleFavoriteCount > 0 && (
            <div className="mt-1 border-t border-edge-soft px-2 pb-0.5 pt-1.5 text-xxs text-faint">
              {i18n.t("preferences.favorites_unavailable", [String(staleFavoriteCount)])}
            </div>
          )}
        </div>

        {pinnedIssue && (
          <div className="sticky bottom-0 flex items-start gap-2 rounded-b-md border-t border-danger-edge bg-danger-surface px-2.5 py-2">
            <div className="min-w-0 flex-1 cursor-text select-text">
              <div className="text-xxs font-semibold text-danger">{pinnedIssue.name}</div>
              <div className="whitespace-pre-wrap break-words text-xxs text-danger/90">
                {pinnedIssue.text}
              </div>
            </div>
            <button
              type="button"
              title={i18n.t("common.dismiss")}
              className="shrink-0 cursor-pointer rounded p-0.5 text-danger/70 hover:bg-danger-edge/40 hover:text-danger"
              onClick={() => setPinnedIssue(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
