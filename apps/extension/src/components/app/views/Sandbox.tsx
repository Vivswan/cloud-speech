import * as SliderPrimitive from "@radix-ui/react-slider";
import { Download, FastForward, Loader2, Lock, Pause, Play, Rewind } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorNotice, type ErrorNoticeProps } from "@/components/app/ErrorNotice";
import { SettingsUnavailable } from "@/components/app/SettingsUnavailable";
import { Card, SectionTitle } from "@/components/ui/card";
import { usePlayback } from "@/hooks/usePlayback";
import { type Report, useReport } from "@/hooks/useReport";
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import type { Playback } from "@/lib/audio/playback";
import * as player from "@/lib/audio/player-actions";
import { NoVoiceSelectedError } from "@/lib/audio/synthesize";
import { errorText } from "@/lib/errors/error-text";
import { describeFailure } from "@/lib/errors/errors";
import { FailureReplyError, RequestTimeoutError, sendToBackground } from "@/lib/messaging/protocol";
import type { Selection } from "@/lib/settings/storage";
import { textDigest } from "@/lib/text/digest";
import { i18n, tDynamic } from "@/lib/text/i18n-runtime";
import { readActiveTabSelection } from "@/lib/text/page-selection";
import { sanitizeTextForSSML } from "@/lib/text/text";
import { cn } from "@/lib/ui/cn";
import { getProvider } from "@/providers";
import type { NormalizedVoice } from "@/providers/types";

const SPEED_STEPS = [1, 1.25, 1.5, 2, 0.75];

type SandboxNotice = Pick<ErrorNoticeProps, "error" | "tone">;

interface MiniPlayerProps {
  /** Null until the first state read: a default "idle" would let a click restart a read the background still holds. */
  playback: Playback | null;

  /** Play pressed with nothing to resume: idle, or paused on stale audio. */
  onStart: () => void;

  /** The textarea changed since the parked audio was synthesized, so play starts fresh instead of resuming. */
  stale: boolean;

  /** Downloads the text's audio through the background; the player never holds the text, so the parent does the work. */
  onDownload: () => void;

  /** A download in flight: downloads are not a playback status, so `playback` does not show them. */
  downloading: boolean;
}

/** The play button's name (what a press does), what the status region announces, and the icon, for one status. */
interface PlayFace {
  label: string;
  announced: string;
  icon: ReactNode;
}

type PlayControlProps = Pick<MiniPlayerProps, "playback" | "onStart" | "stale">;

/** Where the thumb sits and the seeks that move it; `loaded` is false until audio plays or pauses. */
interface Timeline {
  loaded: boolean;
  duration: number;
  position: number;
  setScrub: (seconds: number | null) => void;
  commitSeek: (seconds: number) => void;
}

/** `downloading` is not a playback status, so the player cannot show it; it lives beside the action. */
interface TextActions {
  downloading: boolean;
  start: () => void;
  download: () => void;
}

interface TextEntryProps {
  value: string;
  notice: Report<SandboxNotice> | null;
  onEdit: (next: string) => void;
}

interface TextFactsProps {
  voice: Selection | null;
  voices: NormalizedVoice[];
  value: string;
}

/** The icons carry no text: the name says what a press does, the status region says what changed. */
function playFace(status: Playback["status"] | null): PlayFace {
  switch (status) {
    case "synthesizing":
      return {
        label: i18n.t("player.synthesizing"),
        announced: i18n.t("player.synthesizing"),
        icon: <Loader2 size={14} className="animate-spin" />,
      };
    case "playing":
      return {
        label: i18n.t("player.pause"),
        announced: i18n.t("player.playing"),
        icon: <Pause size={14} fill="currentColor" />,
      };
    case "paused":
      return {
        label: i18n.t("player.play"),
        announced: i18n.t("player.paused"),
        icon: <Play size={14} fill="currentColor" />,
      };
    default:
      return {
        label: i18n.t("player.play"),
        announced: "",
        icon: <Play size={14} fill="currentColor" />,
      };
  }
}

function PlayControl({ playback, onStart, stale }: PlayControlProps) {
  const status = playback?.status ?? null;
  const face = playFace(status);

  function press() {
    // A click mid-synthesis must not fire a second synthesis of the same text.
    if (!playback || playback.status === "synthesizing") return;

    if (playback.status === "playing") void player.pause();
    else if (playback.status === "paused" && !stale) void player.resume();
    else onStart();
  }

  return (
    <>
      <span role="status" className="sr-only">
        {face.announced}
      </span>
      <button
        type="button"
        title={face.label}
        aria-label={face.label}
        aria-busy={status === "synthesizing"}
        disabled={playback === null}
        className={cn(
          "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand text-ink",
          "transition-[transform,background-color] duration-150 ease-snap hover:bg-amber-500 active:scale-[0.94]",
          "disabled:cursor-default disabled:opacity-40",
        )}
        onClick={press}
      >
        {face.icon}
      </button>
    </>
  );
}

function useTimeline(playback: Playback | null): Timeline {
  // During synthesis there is no loaded audio yet; a position shown would belong to the previous read.
  const loaded =
    playback && (playback.status === "playing" || playback.status === "paused") ? playback : null;

  const duration = loaded?.duration ?? 0;

  // While dragging, the user's position shows so the thumb does not fight the position ticks.
  const [scrub, setScrub] = useState<number | null>(null);

  // A committed seek holds the thumb until the background answered: a position tick written just
  // before the seek would snap it back, and a slow answer would make the next +/-15 start from
  // the old position.
  const [held, setHeld] = useState<number | null>(null);

  // Each seek owns its hold: a stale seek settling late must not release a newer seek's hold.
  const seekSeq = useRef(0);

  const position = scrub ?? held ?? loaded?.currentTime ?? 0;

  function commitSeek(seconds: number) {
    const target = Math.min(Math.max(seconds, 0), duration);
    const seq = ++seekSeq.current;
    setHeld(target);
    // player.seekTo never rejects: the document holds the committed position, or the seek was
    // refused and the document's position stands.
    void player.seekTo(target).then(() => {
      if (seekSeq.current === seq) setHeld(null);
    });
  }

  return { loaded: loaded !== null, duration, position, setScrub, commitSeek };
}

function PositionControls({ playback }: Pick<MiniPlayerProps, "playback">) {
  const { loaded, duration, position, setScrub, commitSeek } = useTimeline(playback);

  return (
    <>
      <SliderPrimitive.Root
        className="relative flex h-4 flex-1 touch-none select-none items-center"
        value={[Math.min(position, duration)]}
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.1}
        disabled={!loaded}
        aria-label={i18n.t("player.position")}
        onValueChange={([v]) => {
          if (v !== undefined) setScrub(v);
        }}
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
            "block h-3 w-3 cursor-pointer rounded-full bg-brand shadow",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong data-[disabled]:hidden",
          )}
        />
      </SliderPrimitive.Root>

      <button
        type="button"
        title={i18n.t("player.back_15")}
        disabled={!loaded}
        className="cursor-pointer text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={() => commitSeek(position - 15)}
      >
        <Rewind size={13} />
      </button>
      <button
        type="button"
        title={i18n.t("player.forward_15")}
        disabled={!loaded}
        className="cursor-pointer text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
        onClick={() => commitSeek(position + 15)}
      >
        <FastForward size={13} />
      </button>
    </>
  );
}

function SpeedControl({ playback }: Pick<MiniPlayerProps, "playback">) {
  function cycleSpeed() {
    if (!playback) return;

    const index = SPEED_STEPS.indexOf(playback.rate);
    const next = SPEED_STEPS[(index + 1) % SPEED_STEPS.length] ?? 1;
    void player.setRate(next);
  }

  return (
    <button
      type="button"
      aria-label={i18n.t("player.speed", [String(playback?.rate ?? 1)])}
      disabled={playback === null}
      className="cursor-pointer rounded border border-edge px-1.5 py-0.5 text-xxs font-semibold text-body tabular-nums transition-colors duration-150 hover:bg-inset disabled:cursor-default disabled:opacity-40"
      onClick={cycleSpeed}
    >
      {playback?.rate ?? 1}x
    </button>
  );
}

function DownloadControl({
  onDownload,
  downloading,
}: Pick<MiniPlayerProps, "onDownload" | "downloading">) {
  return (
    <button
      type="button"
      title={i18n.t("sandbox.download")}
      disabled={downloading}
      className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border border-edge text-muted transition-colors duration-150 hover:bg-inset hover:text-body disabled:cursor-default disabled:opacity-40"
      onClick={onDownload}
    >
      {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
    </button>
  );
}

function MiniPlayer({ playback, onStart, stale, onDownload, downloading }: MiniPlayerProps) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-edge bg-inset px-2 py-1.5">
      <PlayControl playback={playback} onStart={onStart} stale={stale} />
      <PositionControls playback={playback} />
      <SpeedControl playback={playback} />
      <DownloadControl onDownload={onDownload} downloading={downloading} />
    </div>
  );
}

/** What stops a read or a download before it starts. Provider failures do not land here; the background
 *  surfaces them through the popup banner. The detail never includes the text itself. */
function blockingNotice(voice: Selection | null, text: string): SandboxNotice | null {
  if (!voice) return { error: describeFailure(new NoVoiceSelectedError("sandbox.no_voice")) };

  // transport.startReading returns false on blank text; without this the play button on a
  // cleared textarea does nothing, silently.
  if (!text.trim()) {
    return {
      error: {
        title: i18n.t("sandbox.empty_text_title"),
        message: i18n.t("sandbox.empty_text"),
        detail: "EmptyText: sandbox text is empty after trim",
      },
    };
  }

  return null;
}

function downloadFailureNotice(error: unknown): SandboxNotice | null {
  // A timeout is a lost or late reply; the job's own outcome is unknown here, so this is a note.
  if (error instanceof RequestTimeoutError) {
    return {
      tone: "note",
      error: {
        title: i18n.t("sandbox.download_timeout_title"),
        message: i18n.t("sandbox.download_timeout"),
        detail: `DownloadTimeout: ${errorText(error)}`,
      },
    };
  }

  // A failure reply was already surfaced through the popup banner.
  if (error instanceof FailureReplyError) return null;

  // A request that got no answer has no other surface than this one.
  return { error: describeFailure(error, { operation: "download" }) };
}

function useTextActions(
  voice: Selection | null,
  text: string,
  setNotice: (notice: SandboxNotice | null) => void,
): TextActions {
  const [downloading, setDownloading] = useState(false);

  async function start() {
    const blocked = blockingNotice(voice, text);
    if (blocked) {
      setNotice(blocked);
      return;
    }

    setNotice(null);
    await player.play(text);
  }

  async function download() {
    const blocked = blockingNotice(voice, text);
    if (blocked) {
      setNotice(blocked);
      return;
    }

    setNotice(null);
    setDownloading(true);
    try {
      await sendToBackground("download", { text });
    } catch (downloadError) {
      const failure = downloadFailureNotice(downloadError);
      if (failure) setNotice(failure);
    }
    setDownloading(false);
  }

  return { downloading, start: () => void start(), download: () => void download() };
}

function SelectionChip({ selection, onUse }: { selection: string; onUse: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded border border-note-edge bg-highlight/30 dark:bg-highlight/15 p-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-body">
        {i18n.t("sandbox.selection_prefix")} "{selection.slice(0, 80)}"
      </span>
      <button
        type="button"
        className="shrink-0 cursor-pointer font-semibold text-strong underline decoration-brand decoration-[1.5px] underline-offset-2 hover:bg-highlight/50 dark:hover:bg-highlight/25 rounded-[3px]"
        onClick={onUse}
      >
        {i18n.t("sandbox.use_selection")}
      </button>
    </div>
  );
}

function TextEntry({ value, notice, onEdit }: TextEntryProps) {
  return (
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
          "min-h-44 w-full grow resize-none rounded-md border border-edge p-3 text-strong focus:border-edge-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
          notice && notice.value.tone !== "note" && "border-danger",
        )}
        value={value}
        onChange={(e) => onEdit(e.currentTarget.value)}
      />
      {notice && <ErrorNotice {...notice.value} reportKey={notice.key} className="mt-1" />}
    </div>
  );
}

function TextFacts({ voice, voices, value }: TextFactsProps) {
  const selectedVoice = voice
    ? voices.find((v) => v.providerId === voice.providerId && v.id === voice.voiceId)
    : undefined;
  const providerName = voice ? tDynamic(getProvider(voice.providerId).labelKey) : "";

  // Text over the budget is split into several billed calls; the counter says so. It measures the
  // sanitized text the background synthesizes, not the raw textarea: markup and entities are gone
  // before chunking.
  const budget = voice
    ? getProvider(voice.providerId).limits.chunkBudget(
        selectedVoice ?? { id: voice.voiceId },
        voice.model,
      )
    : null;
  const splits = budget !== null && budget.sizeOf(sanitizeTextForSSML(value)) > budget.limit;

  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xxs text-muted">
      <span>{i18n.t("sandbox.characters", [String(value.length)])}</span>
      {splits && (
        <>
          <span>·</span>
          <span className="text-note-text">
            {/* No request-count estimate: chunks end at sentence boundaries, and Google
                measures UTF-8 bytes, so a count from the character length would lie. */}
            {i18n.t("sandbox.will_chunk", [providerName])}
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
  );
}

export function Sandbox() {
  const { settings, writeFailure } = useSettings();
  const playback = usePlayback();
  const voices = useVoices();
  const [text, setText] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [notice, setNotice] = useReport<SandboxNotice>();
  const value = text ?? i18n.t("sandbox.default_text");
  const voice = settings?.selection ?? null;
  const actions = useTextActions(voice, value, setNotice);

  useEffect(() => {
    void readActiveTabSelection().then(setSelection);
  }, []);

  if (settings === null) return <SettingsUnavailable failure={writeFailure} />;

  return (
    <div className="flex grow flex-col">
      <SectionTitle>{i18n.t("sandbox.title")}</SectionTitle>

      {selection && <SelectionChip selection={selection} onUse={() => setText(selection)} />}

      <Card className="flex grow flex-col gap-2">
        <TextEntry
          value={value}
          notice={notice}
          onEdit={(next) => {
            setText(next);
            setNotice(null);
          }}
        />

        <TextFacts voice={voice} voices={voices} value={value} />

        <MiniPlayer
          playback={playback}
          onStart={actions.start}
          // Judged against the background's media identity, not popup-local memory, so a reopened
          // popup still resumes correctly.
          stale={
            playback !== null &&
            playback.status !== "idle" &&
            playback.textDigest !== textDigest(value)
          }
          onDownload={actions.download}
          downloading={actions.downloading}
        />
      </Card>
    </div>
  );
}
