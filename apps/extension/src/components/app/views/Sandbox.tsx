import * as SliderPrimitive from "@radix-ui/react-slider";
import { Download, FastForward, Loader2, Lock, Pause, Play, Rewind } from "lucide-react";
import { useEffect, useState } from "react";
import { browser } from "#imports";
import { Card, SectionTitle } from "@/components/ui/card";
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { cn } from "@/lib/cn";
import { textDigest } from "@/lib/digest";
import { i18n, tDynamic } from "@/lib/i18n-runtime";
import { sendToBackground } from "@/lib/messages";
import { getProvider } from "@/providers";
import { usePlayerStore } from "@/stores/player";

const SPEED_STEPS = [1, 1.25, 1.5, 2, 0.75];

interface MiniPlayerProps {
  /** Start a new read of the current text. */
  onStart: () => void;
  /** True when the textarea changed since the parked audio was synthesized;
   *  play then starts fresh instead of resuming stale audio. */
  stale: boolean;
  onDownload: () => void;
  downloading: boolean;
}

function MiniPlayer({ onStart, stale, onDownload, downloading }: MiniPlayerProps) {
  const player = usePlayerStore();
  // The timeline/seek controls act on loaded audio; during synthesis there
  // is none yet (any position shown would belong to the previous read).
  const active = player.status === "playing" || player.status === "paused";
  // While the user drags the timeline, show their position instead of the
  // progress stream so the thumb doesn't fight the broadcast updates.
  const [scrub, setScrub] = useState<number | null>(null);
  const position = scrub ?? player.currentTime;

  function cycleSpeed() {
    // Read-modify-write on player.rate: acting on the unhydrated default
    // (1x) would silently discard the user's persisted rate.
    if (!player.hydrated) return;
    const index = SPEED_STEPS.indexOf(player.rate);
    const next = SPEED_STEPS[(index + 1) % SPEED_STEPS.length] ?? 1;
    void player.setRate(next);
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-edge bg-inset px-2 py-1.5">
      <button
        type="button"
        title={player.status === "playing" ? i18n.t("player.pause") : i18n.t("player.play")}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand text-ink transition-[transform,background-color] duration-150 ease-snap hover:bg-amber-500 active:scale-[0.94]"
        onClick={() => {
          // A click mid-synthesis must not fire a SECOND synthesis of the
          // same text; the first one is already on its way. Same for the
          // unhydrated store: its default "idle" would restart instead of
          // resuming a parked read the background still holds.
          if (player.status === "synthesizing" || !player.hydrated) return;
          if (player.status === "playing") void player.pause();
          else if (player.status === "paused" && !stale) void player.resume();
          else onStart();
        }}
      >
        {player.status === "synthesizing" ? (
          <Loader2 size={14} className="animate-spin" />
        ) : player.status === "playing" ? (
          <Pause size={14} fill="currentColor" />
        ) : (
          <Play size={14} fill="currentColor" />
        )}
      </button>
      <SliderPrimitive.Root
        className="relative flex h-4 flex-1 touch-none select-none items-center"
        value={[Math.min(position, player.duration || 0)]}
        min={0}
        max={player.duration > 0 ? player.duration : 1}
        step={0.1}
        disabled={!active}
        aria-label={i18n.t("player.position")}
        onValueChange={([v]) => v !== undefined && setScrub(v)}
        onValueCommit={([v]) => {
          setScrub(null);
          if (v !== undefined) void player.seekTo(v);
        }}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow rounded bg-fill">
          <SliderPrimitive.Range className="absolute h-full rounded bg-brand" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block h-3 w-3 cursor-pointer rounded-full bg-brand shadow outline-none focus-visible:ring-2 focus-visible:ring-edge-strong data-[disabled]:hidden" />
      </SliderPrimitive.Root>

      <button
        type="button"
        title={i18n.t("player.back_15")}
        disabled={!active}
        className="cursor-pointer text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={() => void player.seekBy(-15)}
      >
        <Rewind size={13} />
      </button>
      <button
        type="button"
        title={i18n.t("player.forward_15")}
        disabled={!active}
        className="cursor-pointer text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={() => void player.seekBy(15)}
      >
        <FastForward size={13} />
      </button>
      <button
        type="button"
        className="cursor-pointer rounded border border-edge px-1.5 py-0.5 text-xxs font-semibold text-body tabular-nums transition-colors duration-150 hover:bg-inset"
        onClick={cycleSpeed}
      >
        {player.rate}x
      </button>
      <button
        type="button"
        title={i18n.t("sandbox.download")}
        disabled={downloading}
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border border-edge text-muted transition-colors duration-150 hover:bg-inset hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={onDownload}
      >
        {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      </button>
    </div>
  );
}

export function Sandbox() {
  const { ready, settings } = useSettings();
  const player = usePlayerStore();
  const voices = useVoices();
  const [text, setText] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    // Best-effort: current page selection for the "Use selection" banner.
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab?.id) return;
        const result = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.getSelection()?.toString() ?? "",
        });
        setSelection((result[0]?.result ?? "").trim());
      })
      .catch(() => {});
  }, []);

  if (!ready || !settings) return null;

  const value = text ?? i18n.t("sandbox.default_text");
  const selectedVoice = settings.selectedVoice
    ? voices.find(
        (v) =>
          v.providerId === settings.selectedVoice?.providerId &&
          v.id === settings.selectedVoice?.voiceId,
      )
    : undefined;
  const providerName = settings.selectedVoice
    ? tDynamic(getProvider(settings.selectedVoice.providerId).labelKey)
    : "";
  // Text over the provider's per-request limit is split into several billed
  // API calls; say so next to the counter instead of surprising the user.
  const maxChars = settings.selectedVoice
    ? getProvider(settings.selectedVoice.providerId).limits.maxChars
    : null;

  async function handleStart() {
    if (!settings?.selectedVoice) {
      setError(i18n.t("sandbox.no_voice"));
      return;
    }
    // transport.startReading returns false on blank text; without this the
    // play button on a cleared textarea does nothing, silently.
    if (!value.trim()) {
      setError(i18n.t("sandbox.empty_text"));
      return;
    }
    setError("");
    await player.play(value);
  }

  async function handleDownload() {
    if (!settings?.selectedVoice) {
      setError(i18n.t("sandbox.no_voice"));
      return;
    }
    if (!value.trim()) {
      setError(i18n.t("sandbox.empty_text"));
      return;
    }
    setError("");
    setDownloading(true);
    try {
      await sendToBackground("download", { text: value });
    } catch (downloadError) {
      // The popup-side 120s timeout only means "still running": the
      // background keeps synthesizing and triggers the download when done.
      // Real failures arrive separately through the background error banner.
      if (String(downloadError).includes("timed out")) {
        setError(i18n.t("sandbox.download_timeout"));
      }
    }
    setDownloading(false);
  }

  return (
    <div className="flex grow flex-col">
      <SectionTitle>{i18n.t("sandbox.title")}</SectionTitle>

      {selection && (
        <div className="mb-2 flex items-center gap-2 rounded border border-note-edge bg-highlight/30 dark:bg-highlight/15 p-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-body">
            {i18n.t("sandbox.selection_prefix")} "{selection.slice(0, 80)}"
          </span>
          <button
            type="button"
            className="shrink-0 cursor-pointer font-semibold text-strong underline decoration-brand decoration-[1.5px] underline-offset-2 hover:bg-highlight/50 dark:hover:bg-highlight/25 rounded-[3px]"
            onClick={() => setText(selection)}
          >
            {i18n.t("sandbox.use_selection")}
          </button>
        </div>
      )}

      <Card className="flex grow flex-col gap-2">
        <div className="relative flex grow flex-col font-semibold text-xs">
          <label
            htmlFor="sandbox-text"
            className="bg-card absolute text-xxs -top-2 left-1.5 px-1 text-muted z-10"
          >
            {i18n.t("sandbox.textarea_label")}
          </label>
          <textarea
            id="sandbox-text"
            className={cn(
              "min-h-44 w-full grow resize-none rounded-md border border-edge p-3 text-strong outline-none focus:border-edge-strong",
              error && "border-danger",
            )}
            value={value}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setError("");
            }}
          />
          {error && <span className="pl-2 pt-0.5 text-xxs text-danger">{error}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 text-xxs text-faint">
          <span>{i18n.t("sandbox.characters", [String(value.length)])}</span>
          {maxChars !== null && value.length > maxChars && (
            <>
              <span>·</span>
              <span className="text-note-text">
                {/* No request-count estimate: chunking is per sentence (and
                    per UTF-8 byte for Google), so any number would lie. */}
                {i18n.t("sandbox.will_chunk", [String(maxChars), providerName])}
              </span>
            </>
          )}
          {selectedVoice && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Lock size={10} aria-hidden />
                {i18n.t("sandbox.privacy", [providerName])}
              </span>
            </>
          )}
        </div>

        <MiniPlayer
          onStart={() => void handleStart()}
          // Staleness is judged against the BACKGROUND's media identity, not
          // popup-local memory, so a reopened popup still resumes correctly.
          stale={player.textDigest !== textDigest(value)}
          onDownload={() => void handleDownload()}
          downloading={downloading}
        />
      </Card>
    </div>
  );
}
