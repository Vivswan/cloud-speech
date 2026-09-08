import * as SliderPrimitive from "@radix-ui/react-slider";
import { Download, FastForward, Loader2, Lock, Pause, Play, Rewind } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { browser } from "#imports";
import { ErrorNotice, type ErrorNoticeProps } from "@/components/app/ErrorNotice";
import { Card, SectionTitle } from "@/components/ui/card";
import { usePlayback } from "@/hooks/usePlayback";
import { useReport } from "@/hooks/useReport";
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { cn } from "@/lib/cn";
import { textDigest } from "@/lib/digest";
import { describeFailure } from "@/lib/errors";
import { i18n, tDynamic } from "@/lib/i18n-runtime";
import type { Playback } from "@/lib/playback";
import * as player from "@/lib/player-actions";
import { FailureReplyError, sendToBackground } from "@/lib/protocol";
import { getProvider } from "@/providers";

const SPEED_STEPS = [1, 1.25, 1.5, 2, 0.75];

/** What the view tells the user under the text box: a failure, or a note
 *  about a download still running. */
type SandboxNotice = Pick<ErrorNoticeProps, "error" | "tone">;

/** The view's own refusals, before anything reaches the background: nothing
 *  to read with, or nothing to read. Provider failures do not land here; the
 *  background surfaces those through the popup banner. */
function noVoiceNotice(): SandboxNotice {
  return {
    error: { title: i18n.t("errors.no_voice_title"), message: i18n.t("sandbox.no_voice") },
  };
}

function emptyTextNotice(): SandboxNotice {
  return {
    error: { title: i18n.t("sandbox.empty_text_title"), message: i18n.t("sandbox.empty_text") },
  };
}

interface MiniPlayerProps {
  /** The background's playback document; null until first read, which
   *  renders the playback controls disabled (a default "idle" would restart a
   *  read the background is still holding). Download does not depend on it. */
  playback: Playback | null;
  /** Start a new read of the current text. */
  onStart: () => void;
  /** True when the textarea changed since the parked audio was synthesized;
   *  play then starts fresh instead of resuming stale audio. */
  stale: boolean;
  onDownload: () => void;
  downloading: boolean;
}

function MiniPlayer({ playback, onStart, stale, onDownload, downloading }: MiniPlayerProps) {
  const status = playback?.status ?? null;
  // The timeline/seek controls act on loaded audio; during synthesis there
  // is none yet (any position shown would belong to the previous read).
  const timeline =
    playback && (playback.status === "playing" || playback.status === "paused") ? playback : null;
  const duration = timeline?.duration ?? 0;
  // While the user drags the timeline, show their position instead of the
  // document's so the thumb doesn't fight the position ticks.
  const [scrub, setScrub] = useState<number | null>(null);
  // A committed seek holds the thumb where the user dropped it until the
  // background answered: a position tick written just before the seek would
  // otherwise snap the thumb back, and a slow answer (a worker still booting)
  // would make the next +/-15 start from the old position.
  const [held, setHeld] = useState<number | null>(null);
  // Each seek owns its hold: a stale seek settling late must not release a
  // newer seek's hold.
  const seekSeq = useRef(0);
  const position = scrub ?? held ?? timeline?.currentTime ?? 0;

  function commitSeek(seconds: number) {
    const target = Math.min(Math.max(seconds, 0), duration);
    const seq = ++seekSeq.current;
    setHeld(target);
    // Settled either way: the document now holds the committed position, or
    // the seek was refused and the document's position stands.
    void player.seekTo(target).then(() => {
      if (seekSeq.current === seq) setHeld(null);
    });
  }

  function cycleSpeed() {
    if (!playback) return;
    const index = SPEED_STEPS.indexOf(playback.rate);
    const next = SPEED_STEPS[(index + 1) % SPEED_STEPS.length] ?? 1;
    void player.setRate(next);
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-edge bg-inset px-2 py-1.5">
      <button
        type="button"
        title={status === "playing" ? i18n.t("player.pause") : i18n.t("player.play")}
        disabled={playback === null}
        className={cn(
          "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand text-ink",
          "transition-[transform,background-color] duration-150 ease-snap hover:bg-amber-500 active:scale-[0.94]",
          "disabled:cursor-default disabled:opacity-40",
        )}
        onClick={() => {
          // A click mid-synthesis must not fire a SECOND synthesis of the
          // same text; the first one is already on its way.
          if (!playback || playback.status === "synthesizing") return;
          if (playback.status === "playing") void player.pause();
          else if (playback.status === "paused" && !stale) void player.resume();
          else onStart();
        }}
      >
        {status === "synthesizing" ? (
          <Loader2 size={14} className="animate-spin" />
        ) : status === "playing" ? (
          <Pause size={14} fill="currentColor" />
        ) : (
          <Play size={14} fill="currentColor" />
        )}
      </button>
      <SliderPrimitive.Root
        className="relative flex h-4 flex-1 touch-none select-none items-center"
        value={[Math.min(position, duration)]}
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.1}
        disabled={timeline === null}
        aria-label={i18n.t("player.position")}
        onValueChange={([v]) => v !== undefined && setScrub(v)}
        onValueCommit={([v]) => {
          setScrub(null);
          if (v !== undefined) commitSeek(v);
        }}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow rounded bg-fill">
          <SliderPrimitive.Range className="absolute h-full rounded bg-brand" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className={cn(
            "block h-3 w-3 cursor-pointer rounded-full bg-brand shadow outline-none",
            "focus-visible:ring-2 focus-visible:ring-edge-strong data-[disabled]:hidden",
          )}
        />
      </SliderPrimitive.Root>

      <button
        type="button"
        title={i18n.t("player.back_15")}
        disabled={timeline === null}
        className="cursor-pointer text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={() => commitSeek(position - 15)}
      >
        <Rewind size={13} />
      </button>
      <button
        type="button"
        title={i18n.t("player.forward_15")}
        disabled={timeline === null}
        className="cursor-pointer text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={() => commitSeek(position + 15)}
      >
        <FastForward size={13} />
      </button>
      <button
        type="button"
        disabled={playback === null}
        className="cursor-pointer rounded border border-edge px-1.5 py-0.5 text-xxs font-semibold text-body tabular-nums transition-colors duration-150 hover:bg-inset disabled:cursor-default disabled:opacity-40"
        onClick={cycleSpeed}
      >
        {playback?.rate ?? 1}x
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
  const { settings } = useSettings();
  const playback = usePlayback();
  const voices = useVoices();
  const [text, setText] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [notice, setNotice] = useReport<SandboxNotice>();
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

  if (settings === null) return null;

  const value = text ?? i18n.t("sandbox.default_text");
  const voice = settings.selection;
  const selectedVoice = voice
    ? voices.find((v) => v.providerId === voice.providerId && v.id === voice.voiceId)
    : undefined;
  const providerName = voice ? tDynamic(getProvider(voice.providerId).labelKey) : "";
  // Text over the provider's per-request limit is split into several billed
  // API calls; say so next to the counter instead of surprising the user.
  const maxChars = voice ? getProvider(voice.providerId).limits.maxChars : null;

  async function handleStart() {
    if (!settings?.selection) {
      setNotice(noVoiceNotice());
      return;
    }
    // transport.startReading returns false on blank text; without this the
    // play button on a cleared textarea does nothing, silently.
    if (!value.trim()) {
      setNotice(emptyTextNotice());
      return;
    }
    setNotice(null);
    await player.play(value);
  }

  async function handleDownload() {
    if (!settings?.selection) {
      setNotice(noVoiceNotice());
      return;
    }
    if (!value.trim()) {
      setNotice(emptyTextNotice());
      return;
    }
    setNotice(null);
    setDownloading(true);
    try {
      await sendToBackground("download", { text: value });
    } catch (downloadError) {
      if (String(downloadError).includes("timed out")) {
        // The popup-side 120s timeout only means "still running": the
        // background keeps synthesizing and triggers the download when done.
        setNotice({
          tone: "note",
          error: {
            title: i18n.t("sandbox.download_timeout_title"),
            message: i18n.t("sandbox.download_timeout"),
          },
        });
      } else if (!(downloadError instanceof FailureReplyError)) {
        // A failure reply was already surfaced by the background through the
        // popup banner; a request that got no answer at all has no other
        // surface than this one.
        setNotice({ error: describeFailure(downloadError) });
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
              notice && notice.value.tone !== "note" && "border-danger",
            )}
            value={value}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setNotice(null);
            }}
          />
          {notice && <ErrorNotice {...notice.value} reportKey={notice.key} className="mt-1" />}
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
          playback={playback}
          onStart={() => void handleStart()}
          // Staleness is judged against the BACKGROUND's media identity, not
          // popup-local memory, so a reopened popup still resumes correctly.
          stale={
            playback !== null &&
            playback.status !== "idle" &&
            playback.textDigest !== textDigest(value)
          }
          onDownload={() => void handleDownload()}
          downloading={downloading}
        />
      </Card>
    </div>
  );
}
