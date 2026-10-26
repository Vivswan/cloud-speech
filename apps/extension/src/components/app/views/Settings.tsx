import { SITE_LOCALES } from "@cloud-speech/constants";
import { dequal } from "dequal/lite";
import { useState } from "react";
import { browser } from "#imports";
import { ErrorNotice } from "@/components/app/ErrorNotice";
import { NewerVersionNote } from "@/components/app/NewerVersionNote";
import { SettingsUnavailable } from "@/components/app/SettingsUnavailable";
import { BackupSection } from "@/components/app/settings/BackupSection";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LabeledSelect } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type Report, useReport } from "@/hooks/useReport";
import {
  DescribedFailure,
  describeNewerVersion,
  describeWriteError,
  useGuardedSubject,
  useSettings,
} from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { errorText } from "@/lib/errors/error-text";
import { readingAdvice } from "@/lib/errors/errors";
import { type ErrorPayload, sendToBackground } from "@/lib/messaging/protocol";
import type {
  ProviderValidationResult,
  ValidationFailureCode,
} from "@/lib/messaging/provider-validation";
import type { Claim } from "@/lib/messaging/slot";
import {
  type CredentialFieldError,
  credentialFieldError,
  credentialFieldWarning,
  stripEndpointSuffixes,
  trimValues,
} from "@/lib/settings/credential-checks";
import {
  credentialsFor,
  isProviderConnected,
  prefsFor,
  withProviderPrefs,
} from "@/lib/settings/provider-state";
import {
  estimateSyncSizeBytes,
  getSettings,
  peekSyncedSettings,
  type Settings as SettingsType,
  SYNC_QUOTA_BYTES_PER_ITEM,
  setSyncEnabled,
  type UiLanguage,
  updateSettingsWith,
} from "@/lib/settings/storage";
import { guideUrl } from "@/lib/text/guide";
import { getActiveLocale, i18n, type MessageKey, tDynamic } from "@/lib/text/i18n-runtime";
import { SETTINGS_VERSION } from "@/migrations/ladder";
import { providerList } from "@/providers";
import type { CredentialField, ErrorDescription, TtsProvider } from "@/providers/types";

type ShownFailureCode = Exclude<ValidationFailureCode, "superseded">;
/** The provider's verdict on the key; "storage" is the write after it. */
type ProviderFailureCode = Exclude<ShownFailureCode, "storage">;
/** The background's refusal, in any of its codes. */
type Verdict = Extract<ProviderValidationResult, { ok: false }>;
/** Save & test from the click: "testing" until the verdict, "scanning" while a proven key's engine families are checked. */
type CheckPhase = "idle" | "testing" | "scanning";
type GuardedSubject = ReturnType<typeof useGuardedSubject>;

// A synced copy a newer build wrote can only be adopted, never replaced from here.
//   "conflict"        -> another device's synced copy differs: which copy wins
//   "conflict-newer"  -> the synced copy is from a newer build: adopt or cancel
//   "disable"         -> disabling deletes the synced copy for every signed-in browser
type SyncPrompt = "conflict" | "conflict-newer" | "disable";

// The network title takes the provider name as $1; the others ignore it.
const FAILURE_TITLE: Record<ProviderFailureCode, MessageKey> = {
  authentication: "settings.validation_authentication_title",
  permission: "settings.validation_permission_title",
  region: "settings.validation_region_title",
  quota: "settings.validation_quota_title",
  network: "settings.validation_network_title",
  unknown: "settings.validation_unknown_title",
};

// The code's advice, shown when the provider's own reading supplies none.
const FAILURE_MESSAGE: Record<ProviderFailureCode, MessageKey> = {
  authentication: "settings.validation_authentication",
  permission: "settings.validation_permission",
  region: "settings.validation_region",
  quota: "settings.validation_quota",
  network: "settings.validation_network",
  unknown: "settings.validation_unknown",
};

/** Failures the setup guide walks through. A quota, an outage, or a failed write is nothing a guide page fixes. */
const GUIDED_FAILURES: ReadonlySet<ProviderFailureCode> = new Set([
  "authentication",
  "permission",
  "region",
]);

// The deterministic field problems Save & test stops at, each with its inline sentence.
const FIELD_ERROR_MESSAGE: Record<CredentialFieldError, MessageKey> = {
  required: "settings.field_required",
  url: "settings.field_url_invalid",
  invisible: "settings.field_invisible",
};

// The Save & test button's word for each phase.
const SAVE_BUTTON_LABEL: Record<CheckPhase, MessageKey> = {
  idle: "settings.save_and_test",
  testing: "settings.testing",
  scanning: "settings.scan",
};

// What each sync prompt asks, above its buttons.
const SYNC_PROMPT_MESSAGE: Record<SyncPrompt, MessageKey> = {
  conflict: "settings.sync_conflict",
  "conflict-newer": "settings.sync_conflict_newer",
  disable: "settings.sync_disable_warning",
};

interface ValidationFailure {
  /** Never "superseded": a Save & test a newer one overtook shows no failure. */
  code: ShownFailureCode;

  /** The provider's diagnostic, redacted. */
  detail?: string;

  /** A "storage" failure refused by settings a newer build saved: their schema version. */
  storedVersion?: number;

  /** The provider's own reading; its sentence and fix link replace the code's advice and guide link. */
  description?: ErrorDescription;

  /** The provider was already verified: the stored credentials stayed. */
  keptPrevious: boolean;
}

/** The row's inputs: what they show, and what Save & test's reading of the form left on them. */
interface CredentialDraft {
  /** The typed draft, else the stored credentials over the schema's defaults: what the user sees is what Save & test submits. */
  values: Record<string, string>;

  /** Save & test's deterministic verdicts by field key; an edit of the field clears its own. */
  fieldErrors: Record<string, string>;

  /** The auto-fix shown under the inputs: an endpoint path Save & test stripped, never a silent rewrite. */
  notice: string;

  /** One keystroke in the field. */
  edit(key: string, value: string): void;

  /** Save & test's reading of the form: trims and strips the values, flags deterministic problems
   *  on their fields, and shows a stripped endpoint. The candidate to probe, or null when a field
   *  stopped it. */
  prepare(): Record<string, string> | null;

  /** The candidate was stored: the inputs show the stored credentials again. */
  adoptStored(): void;
}

/** Save & test as the footer and the notices read it. */
interface SaveAndTest {
  /** Where the run is; the inputs and the Enabled switch are disabled until it is back at "idle". */
  phase: CheckPhase;

  /** The scan's verdict, shown under the inputs and announced by the status region. */
  scanSummary: string;

  /** The provider's verdict and the scan's; an edit clears it. */
  error: Report<ErrorPayload> | null;

  /** The whole flow, from the form's reading to the scan. */
  run(): Promise<void>;

  /** The last verdict described different credentials. */
  forget(): void;
}

interface SyncSectionProps extends Pick<ReturnType<typeof useSettings>, "syncEnabled"> {
  locked: boolean;
}

/** Every provider has a setup/<id> guide page; the roster-sync test pins their existence. */
function guidePage(provider: TtsProvider): string {
  return guideUrl(`setup/${provider.id}`, getActiveLocale());
}

function describeValidationFailure(
  provider: TtsProvider,
  { code, detail, storedVersion, description, keptPrevious }: ValidationFailure,
): ErrorPayload {
  const technical = `ValidationFailure(code=${code}): ${detail ?? "no diagnostic text"}`;
  const withKept = (sentence: string) =>
    [sentence, keptPrevious ? i18n.t("settings.validation_kept") : undefined]
      .filter(Boolean)
      .join(" ");
  if (code === "storage") {
    // The key was proven; the write after it was refused, the same failure a Preferences change
    // hits, so it gets that notice.
    const refused =
      storedVersion === undefined
        ? describeWriteError(detail ?? "")
        : describeNewerVersion(storedVersion);
    return { ...refused, message: withKept(refused.message), detail: technical };
  }
  const providerName = tDynamic(provider.labelKey);
  const advice = description ? readingAdvice(provider, description) : undefined;
  const payload: ErrorPayload = {
    title: i18n.t(FAILURE_TITLE[code], [providerName]),
    message: withKept(advice?.message ?? i18n.t(FAILURE_MESSAGE[code])),
    detail: technical,
  };
  if (advice?.action) {
    payload.action = advice.action;
  } else if (GUIDED_FAILURES.has(code)) {
    payload.action = {
      label: i18n.t("settings.validation_open_guide", [providerName]),
      url: guidePage(provider),
    };
  }
  return payload;
}

/** The chip's word, also what the row's status region announces when it changes. */
function statusLabel(settings: SettingsType, provider: TtsProvider): string {
  const { verified, enabled } = prefsFor(settings, provider.id);
  if (verified && enabled) return i18n.t("settings.connected");
  return verified ? i18n.t("settings.off") : i18n.t("settings.not_connected");
}

function StatusChip({ provider, settings }: { provider: TtsProvider; settings: SettingsType }) {
  const { verified, enabled } = prefsFor(settings, provider.id);
  const label = statusLabel(settings, provider);

  if (verified && enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-surface px-1.5 py-0.5 text-xxs font-semibold text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        {label}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-inset px-1.5 py-0.5 text-xxs font-semibold text-body">
      {label}
    </span>
  );
}

/** The value of the schema's field in `role`: providers name their region and endpoint fields differently. */
function valueWithRole(
  provider: TtsProvider,
  values: Record<string, string>,
  role: CredentialField["role"],
): string | undefined {
  const field = provider.credentialSchema.find((candidate) => candidate.role === role);
  return field ? values[field.key] : undefined;
}

/** The host stands in for the region in a URL-based provider's summary. */
function endpointHost(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

function rowSummary(
  provider: TtsProvider,
  settings: SettingsType,
  values: Record<string, string>,
  voiceCount: number,
): string {
  const { verified, enabled } = prefsFor(settings, provider.id);
  if (!verified || !enabled) return i18n.t("settings.not_connected");

  const parts = [
    i18n.t("settings.connected"),
    valueWithRole(provider, values, "region") ??
      endpointHost(valueWithRole(provider, values, "endpoint")),
  ];
  if (voiceCount > 0) parts.push(i18n.t("settings.voices_count", [String(voiceCount)]));
  return parts.filter(Boolean).join(" · ");
}

function RowHeader({
  provider,
  settings,
  values,
}: {
  provider: TtsProvider;
  settings: SettingsType;
  values: Record<string, string>;
}) {
  const voices = useVoices();
  const voiceCount = voices.filter((voice) => voice.providerId === provider.id).length;

  return (
    <AccordionTrigger>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-body">{tDynamic(provider.labelKey)}</div>
        <div className="truncate text-xxs text-muted">
          {rowSummary(provider, settings, values, voiceCount)}
        </div>
      </div>
      <StatusChip provider={provider} settings={settings} />
    </AccordionTrigger>
  );
}

/** Defaults are merged into the values, so what the user sees is what Save & test submits. */
function withDefaults(
  provider: TtsProvider,
  stored: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of provider.credentialSchema) {
    if (field.defaultValue) values[field.key] = field.defaultValue;
  }
  return { ...values, ...stored };
}

/** The values as Save & test submits them; `stripped` says an endpoint lost a pasted path, which the inputs then show. */
function cleanCandidate(
  provider: TtsProvider,
  values: Record<string, string>,
): { candidate: Record<string, string>; stripped: boolean } {
  const candidate = trimValues(values);
  let stripped = false;
  for (const field of provider.credentialSchema) {
    const raw = candidate[field.key];
    if (!raw) continue;

    const clean = stripEndpointSuffixes(field, raw);
    if (clean === raw) continue;

    candidate[field.key] = clean;
    stripped = true;
  }
  return { candidate, stripped };
}

/** Deterministic problems, flagged on the fields before any round-trip to the background. */
function fieldErrorsFor(
  provider: TtsProvider,
  candidate: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of provider.credentialSchema) {
    const kind = credentialFieldError(field, candidate[field.key] ?? "");
    if (kind === undefined) continue;

    errors[field.key] = i18n.t(FIELD_ERROR_MESSAGE[kind]);
  }
  return errors;
}

function useCredentialDraft(provider: TtsProvider, settings: SettingsType): CredentialDraft {
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const values = draft ?? withDefaults(provider, credentialsFor(settings, provider.id));

  function edit(key: string, value: string): void {
    setDraft({ ...values, [key]: value });
    setNotice("");
    setFieldErrors(({ [key]: _cleared, ...rest }) => rest);
  }

  function prepare(): Record<string, string> | null {
    const { candidate, stripped } = cleanCandidate(provider, values);
    const errors = fieldErrorsFor(provider, candidate);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return null;

    if (stripped) {
      // Show the auto-fix in the inputs; never silently submit a rewrite.
      setDraft(candidate);
      setNotice(i18n.t("settings.url_endpoint_stripped"));
    } else {
      setNotice("");
    }
    return candidate;
  }

  function adoptStored(): void {
    setDraft(null);
  }

  return { values, fieldErrors, notice, edit, prepare, adoptStored };
}

async function requestValidation(
  provider: TtsProvider,
  credentials: Record<string, string>,
): Promise<ProviderValidationResult> {
  try {
    return await sendToBackground("validateProvider", { providerId: provider.id, credentials });
  } catch (error) {
    return {
      ok: false,
      code: "unknown",
      detail: `validateProvider request failed: ${errorText(error)}`,
    };
  }
}

// Save & test also scans engine families after validating: a key can pass yet lack access
// (Google gates Gemini voices behind a separate API).
async function scanSummaryFor(provider: TtsProvider): Promise<string> {
  const result = await sendToBackground("scanVoices", { providerId: provider.id });
  if (result.familiesUnavailable === 0) {
    return i18n.t("settings.scan_ok", [String(result.familiesChecked)]);
  }
  return i18n.t("settings.scan_issues", [String(result.familiesUnavailable)]);
}

function describeScanFailure(error: unknown): ErrorPayload {
  return {
    title: i18n.t("settings.validation_unknown_title"),
    message: i18n.t("settings.scan_failed"),
    detail: errorText(error),
  };
}

/** The flow reads the draft and, once the key is proven, resets it; a refused store after a proven key settles in `prefs`. */
function useSaveAndTest(
  provider: TtsProvider,
  settings: SettingsType,
  prefs: GuardedSubject,
  draft: CredentialDraft,
): SaveAndTest {
  const [phase, setPhase] = useState<CheckPhase>("idle");
  const [scanSummary, setScanSummary] = useState("");
  const [error, setError] = useReport<ErrorPayload>();
  const { verified } = prefsFor(settings, provider.id);

  function describe(code: ShownFailureCode, verdict: Verdict): ErrorPayload {
    const { detail, storedVersion, description } = verdict;
    return describeValidationFailure(provider, {
      code,
      detail,
      storedVersion,
      description,
      keptPrevious: verified,
    });
  }

  // A proven key is stored with enabled: true, a refused store is the prefs slot's failure, and
  // a verdict against the key stored nothing, so the slot is left as it was.
  function probe(candidate: Record<string, string>): Promise<ProviderValidationResult | undefined> {
    return prefs.run(
      async () => {
        const verdict = await requestValidation(provider, candidate);
        if (!verdict.ok && verdict.code === "storage") {
          throw new DescribedFailure(describe("storage", verdict));
        }
        return verdict;
      },
      (verdict) => verdict.ok,
    );
  }

  async function run(): Promise<void> {
    const candidate = draft.prepare();
    if (candidate === null) return;

    setPhase("testing");
    setScanSummary("");
    setError(null);
    try {
      const verdict = await probe(candidate);
      if (verdict === undefined) return;
      if (!verdict.ok) {
        // A newer Save & test took over; its own outcome is the one to show.
        if (verdict.code === "superseded") return;
        setError(describe(verdict.code, verdict));
        return;
      }

      draft.adoptStored();
      setPhase("scanning");
      try {
        setScanSummary(await scanSummaryFor(provider));
      } catch (scanError) {
        setError(describeScanFailure(scanError));
      }
    } finally {
      setPhase("idle");
    }
  }

  function forget(): void {
    setError(null);
    setScanSummary("");
  }

  return { phase, scanSummary, error, run, forget };
}

// Advisory shape/URL warnings, live while typing; never block anything.
function fieldWarningText(
  provider: TtsProvider,
  field: CredentialField,
  values: Record<string, string>,
): string | undefined {
  const warning = credentialFieldWarning(
    field,
    values[field.key] ?? "",
    provider.credentialSchema,
    values,
  );
  if (!warning) return undefined;
  switch (warning.kind) {
    case "hint":
      return tDynamic(warning.hintKey, [field.placeholder]);
    case "url_parts_ignored":
      return i18n.t("settings.hint_url_parts_ignored");
    case "plain_http_key":
      return i18n.t("settings.hint_url_plain_http");
    case "missing_path":
      return i18n.t("settings.hint_url_missing_path", [field.placeholder]);
  }
}

function CredentialInputs({
  provider,
  draft,
  disabled,
  onChange,
}: {
  provider: TtsProvider;
  draft: CredentialDraft;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {provider.credentialSchema.map((field) => (
        <Input
          key={field.key}
          label={tDynamic(field.labelKey)}
          placeholder={field.placeholder}
          type={field.type}
          value={draft.values[field.key] ?? ""}
          disabled={disabled}
          error={draft.fieldErrors[field.key]}
          warning={
            draft.fieldErrors[field.key]
              ? undefined
              : fieldWarningText(provider, field, draft.values)
          }
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </>
  );
}

function VerdictNotices({
  draft,
  check,
  prefs,
}: {
  draft: CredentialDraft;
  check: SaveAndTest;
  prefs: GuardedSubject;
}) {
  return (
    <>
      {check.error && <ErrorNotice error={check.error.value} reportKey={check.error.key} />}
      {draft.notice && <div className="text-xxs text-muted">{draft.notice}</div>}
      {prefs.failure && <ErrorNotice error={prefs.failure.value} reportKey={prefs.failure.key} />}
      {check.scanSummary && (
        <div className="text-xxs font-semibold text-muted">{check.scanSummary}</div>
      )}
    </>
  );
}

async function writeEnabled(
  prefs: GuardedSubject,
  provider: TtsProvider,
  next: boolean,
): Promise<void> {
  const written = await prefs.run((claim) =>
    updateSettingsWith(claim, (current) =>
      withProviderPrefs(current, provider.id, { enabled: next }),
    ),
  );
  // After a refused write a voice refresh would describe state that was never persisted.
  if (written === undefined) return;
  await sendToBackground("fetchVoices").catch(() => {});
}

function RowActions({
  provider,
  settings,
  prefs,
  check,
}: {
  provider: TtsProvider;
  settings: SettingsType;
  prefs: GuardedSubject;
  check: SaveAndTest;
}) {
  const { enabled, verified } = prefsFor(settings, provider.id);
  const busy = check.phase !== "idle";

  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        className="cursor-pointer text-xxs font-semibold text-body underline decoration-brand decoration-[1.5px] underline-offset-2 hover:text-strong"
        onClick={() => browser.tabs.create({ url: guidePage(provider) })}
      >
        {i18n.t("settings.where_help")}
        <span aria-hidden="true">{" ↗"}</span>
      </button>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-xxs font-semibold text-muted">
          <Switch
            checked={enabled}
            onCheckedChange={(next) => writeEnabled(prefs, provider, next)}
            disabled={!verified || busy}
            aria-label={i18n.t("settings.enabled")}
          />
          {i18n.t("settings.enabled")}
        </span>
        <Button variant="primary" submitting={busy} onClick={check.run}>
          {i18n.t(SAVE_BUTTON_LABEL[check.phase])}
        </Button>
      </div>
    </div>
  );
}

/** No settings subscription of its own: one per row doubled the reads and the read-failure notice. */
function ProviderRow({ provider, settings }: { provider: TtsProvider; settings: SettingsType }) {
  // The provider's stored prefs: the Enabled switch's write and the write behind a proven
  // Save & test settle here, so a refusal of either stays until a write of either succeeds.
  const prefs = useGuardedSubject();

  const draft = useCredentialDraft(provider, settings);
  const check = useSaveAndTest(provider, settings, prefs, draft);

  function changeField(key: string, value: string): void {
    draft.edit(key, value);
    check.forget();
  }

  return (
    <AccordionItem value={provider.id} data-testid={`provider-${provider.id}`}>
      <RowHeader provider={provider} settings={settings} values={draft.values} />
      {/* One region, mounted before anything happens: a live region that appears already filled is
          not announced, and a button's children are presentational, so it cannot sit in the trigger. */}
      <span role="status" className="sr-only">
        <span>{statusLabel(settings, provider)}</span>
        {draft.notice && <span> {draft.notice}</span>}
        {check.scanSummary && <span> {check.scanSummary}</span>}
      </span>
      <AccordionContent>
        <div className="flex flex-col gap-3">
          <CredentialInputs
            provider={provider}
            draft={draft}
            disabled={check.phase !== "idle"}
            onChange={changeField}
          />
          <VerdictNotices draft={draft} check={check} prefs={prefs} />
          <RowActions provider={provider} settings={settings} prefs={prefs} check={check} />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function SyncSection({ syncEnabled, locked }: SyncSectionProps) {
  const [syncPrompt, setSyncPrompt] = useState<SyncPrompt | null>(null);
  /** The switch is the subject: every click on it and every prompt button claims it, so an enable
   *  still reading when the user clicks again neither flips the flag nor settles into anything. */
  const sync = useGuardedSubject();

  async function handleSyncToggle(next: boolean) {
    setSyncPrompt(null);
    // Conflict first: adopting a smaller remote copy must stay possible when this device's settings
    // are too large to upload. A newer remote is a conflict even when its known fields match: its
    // unknown fields would be lost, and storage refuses the overwrite anyway.
    const prompt = await sync.run(async (claim): Promise<SyncPrompt | null> => {
      // Read under the write lock: a move whose flag flip was already landing when this click
      // superseded it has finished by now, and a flag already where the click points leaves
      // nothing to prompt about.
      const { syncEnabled: current, remote, local } = await peekSyncedSettings();
      if (current === next) return null;
      if (!next) return "disable";
      if (remote !== null && remote.storedVersion > SETTINGS_VERSION) return "conflict-newer";
      if (remote !== null && !dequal(remote.settings, local)) return "conflict";
      await uploadLocal(claim);
      return null;
    });
    if (prompt) setSyncPrompt(prompt);
  }

  /** Chrome's per-item quota, refused before any local-copy upload path. */
  async function uploadLocal(claim: Claim): Promise<void> {
    const size = estimateSyncSizeBytes(await getSettings());
    if (size > SYNC_QUOTA_BYTES_PER_ITEM) {
      throw new DescribedFailure({
        title: i18n.t("settings.storage_error_title"),
        message: i18n.t("settings.sync_too_large"),
        detail: `SyncTooLarge: settings estimate ${size} bytes > QUOTA_BYTES_PER_ITEM ${SYNC_QUOTA_BYTES_PER_ITEM}`,
      });
    }
    await setSyncEnabled(claim, true);
  }

  return (
    <div>
      <SectionTitle>{i18n.t("settings.sync_title")}</SectionTitle>
      <Card className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-body">{i18n.t("settings.sync_label")}</div>
          <div className="text-xxs text-muted">
            {syncEnabled ? i18n.t("settings.sync_on_hint") : i18n.t("settings.sync_off_hint")}
          </div>
        </div>
        <Switch
          checked={syncEnabled}
          disabled={locked}
          onCheckedChange={(next) => void handleSyncToggle(next)}
          aria-label={i18n.t("settings.sync_label")}
        />
      </Card>
      {syncPrompt && (
        <div className="mt-2 rounded border border-note-edge bg-note p-2.5 text-xxs text-note-text">
          <div>{i18n.t(SYNC_PROMPT_MESSAGE[syncPrompt])}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {syncPrompt === "conflict" && (
              <Button
                onClick={() => {
                  setSyncPrompt(null);
                  void sync.run(uploadLocal);
                }}
              >
                {i18n.t("settings.sync_keep_local")}
              </Button>
            )}
            {syncPrompt === "disable" ? (
              <Button
                onClick={() => {
                  setSyncPrompt(null);
                  void sync.run((claim) => setSyncEnabled(claim, false));
                }}
              >
                {i18n.t("common.continue")}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setSyncPrompt(null);
                  void sync.run((claim) => setSyncEnabled(claim, true, { adoptRemote: true }));
                }}
              >
                {i18n.t("settings.sync_use_synced")}
              </Button>
            )}
            <Button onClick={() => setSyncPrompt(null)}>{i18n.t("common.cancel")}</Button>
          </div>
        </div>
      )}
      {sync.failure && (
        <ErrorNotice error={sync.failure.value} reportKey={sync.failure.key} className="mt-2" />
      )}
    </div>
  );
}

export function Settings() {
  const { settings, update, syncEnabled, writeFailure, newerVersion } = useSettings();
  if (settings === null) return <SettingsUnavailable failure={writeFailure} />;

  const locked = newerVersion !== null;

  const anyConnected = providerList.some((p) => isProviderConnected(settings, p.id));

  // Endonym labels, deliberately untranslated: whatever language the UI is stuck in, every reader
  // must recognize their own.
  const uiLanguageOptions = [
    { value: "auto", title: i18n.t("settings.ui_language_auto") },
    ...SITE_LOCALES.map((locale) => ({ value: locale.extensionId, title: locale.label })),
  ];

  return (
    <div className="flex flex-col gap-5">
      {locked && <NewerVersionNote storedVersion={newerVersion} />}
      {writeFailure && <ErrorNotice error={writeFailure.value} reportKey={writeFailure.key} />}
      <fieldset
        disabled={locked}
        className="flex flex-col gap-5 disabled:pointer-events-none disabled:opacity-60"
      >
        <div>
          <SectionTitle>{i18n.t("settings.providers_title")}</SectionTitle>
          {!anyConnected && (
            <div className="mb-2 rounded border border-note-edge bg-note p-3 text-xs text-note-text">
              {i18n.t("settings.first_run")}
            </div>
          )}
          <Accordion type="single" collapsible className="flex flex-col gap-2">
            {providerList.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} settings={settings} />
            ))}
          </Accordion>
        </div>

        <SyncSection syncEnabled={syncEnabled} locked={locked} />

        <BackupSection settings={settings} />

        <div>
          <SectionTitle>{i18n.t("settings.ui_language_title")}</SectionTitle>
          <Card className="flex flex-col gap-1.5">
            <LabeledSelect
              label={i18n.t("settings.ui_language_label")}
              value={settings.uiLanguage}
              options={uiLanguageOptions}
              disabled={locked}
              onChange={(value) => void update({ uiLanguage: value as UiLanguage })}
            />
            <div className="text-xxs text-muted">{i18n.t("settings.ui_language_hint")}</div>
          </Card>
        </div>
      </fieldset>
    </div>
  );
}
