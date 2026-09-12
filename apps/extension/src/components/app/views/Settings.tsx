import { SITE_LOCALES } from "@cloud-speech/constants";
import { useState } from "react";
import { browser } from "#imports";
import { ErrorNotice } from "@/components/app/ErrorNotice";
import { NewerVersionNote } from "@/components/app/NewerVersionNote";
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
import { useReport } from "@/hooks/useReport";
import { describeNewerVersion, describeWriteError, useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { cn } from "@/lib/cn";
import {
  credentialFieldError,
  credentialFieldWarning,
  stripEndpointSuffixes,
  trimValues,
} from "@/lib/credential-checks";
import { errorText } from "@/lib/error-text";
import { readingAdvice } from "@/lib/errors";
import { guideUrl } from "@/lib/guide";
import { getActiveLocale, i18n, type MessageKey, tDynamic } from "@/lib/i18n-runtime";
import { type ErrorPayload, sendToBackground } from "@/lib/protocol";
import {
  credentialsFor,
  isProviderConnected,
  prefsFor,
  withProviderPrefs,
} from "@/lib/provider-state";
import type { ProviderValidationResult, ValidationFailureCode } from "@/lib/provider-validation";
import {
  estimateSyncSizeBytes,
  peekSyncedSettings,
  SETTINGS_VERSION,
  type Settings as SettingsType,
  SYNC_QUOTA_BYTES_PER_ITEM,
  type UiLanguage,
} from "@/lib/storage";
import { providerList } from "@/providers";
import type { CredentialField, ErrorDescription, TtsProvider } from "@/providers/types";

type ShownFailureCode = Exclude<ValidationFailureCode, "superseded">;
/** The provider's verdict on the key; "storage" is the write after it. */
type ProviderFailureCode = Exclude<ShownFailureCode, "storage">;

// The network title takes the provider name as $1; the others ignore it.
const FAILURE_TITLE: Record<ProviderFailureCode, MessageKey> = {
  authentication: "settings.validation_authentication_title",
  permission: "settings.validation_permission_title",
  region: "settings.validation_region_title",
  quota: "settings.validation_quota_title",
  network: "settings.validation_network_title",
  unknown: "settings.validation_unknown_title",
};

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

interface ValidationFailure {
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

function describeValidationFailure(
  provider: TtsProvider,
  guide: string,
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
      url: guide,
    };
  }
  return payload;
}

function StatusChip({ provider, settings }: { provider: TtsProvider; settings: SettingsType }) {
  const { verified, enabled } = prefsFor(settings, provider.id);

  if (verified && enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-surface px-1.5 py-0.5 text-xxs font-semibold text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        {i18n.t("settings.connected")}
      </span>
    );
  }
  if (verified && !enabled) {
    return (
      <span className="rounded-full bg-inset px-1.5 py-0.5 text-xxs font-semibold text-muted">
        {i18n.t("settings.off")}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-inset px-1.5 py-0.5 text-xxs font-semibold text-faint">
      {i18n.t("settings.not_connected")}
    </span>
  );
}

function ProviderRow({ provider }: { provider: TtsProvider }) {
  const { settings, updateWith, writeFailure } = useSettings();
  const voices = useVoices();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [testing, setTesting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState("");
  const [error, setError] = useReport<ErrorPayload>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  if (!settings) return null;

  const stored = credentialsFor(settings, provider.id);
  // Defaults are merged into the values, so what the user sees is what Save & test submits.
  const defaults = Object.fromEntries(
    provider.credentialSchema.flatMap((field) =>
      field.defaultValue ? [[field.key, field.defaultValue]] : [],
    ),
  );
  const values = draft ?? { ...defaults, ...stored };
  const voiceCount = voices.filter((v) => v.providerId === provider.id).length;
  const { enabled, verified } = prefsFor(settings, provider.id);

  // The host stands in for the region in a URL-based provider's summary.
  const baseUrlHost = (() => {
    if (!values.baseUrl) return undefined;
    try {
      return new URL(values.baseUrl).host;
    } catch {
      return undefined;
    }
  })();

  const summary =
    verified && enabled
      ? [
          i18n.t("settings.connected"),
          values.region ?? baseUrlHost,
          voiceCount > 0 ? i18n.t("settings.voices_count", [String(voiceCount)]) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : i18n.t("settings.not_connected");

  // Every provider has a setup/<id> guide page; the roster-sync test pins their existence.
  const helpPath = `setup/${provider.id}`;

  // Save & test also scans engine families after validating: a key can pass yet lack access
  // (Google gates Gemini voices behind a separate API).
  async function handleSaveAndTest() {
    // Deterministic problems are flagged on the fields before any round-trip to the background.
    const candidate = trimValues(values);
    let strippedAny = false;
    for (const field of provider.credentialSchema) {
      const raw = candidate[field.key];
      if (!raw) continue;
      const stripped = stripEndpointSuffixes(field, raw);
      if (stripped !== raw) {
        candidate[field.key] = stripped;
        strippedAny = true;
      }
    }

    const errors: Record<string, string> = {};
    for (const field of provider.credentialSchema) {
      const kind = credentialFieldError(field, candidate[field.key] ?? "");
      if (kind === "required") errors[field.key] = i18n.t("settings.field_required");
      else if (kind === "url") errors[field.key] = i18n.t("settings.field_url_invalid");
      else if (kind === "invisible") errors[field.key] = i18n.t("settings.field_invisible");
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (strippedAny) {
      // Show the auto-fix in the inputs; never silently submit a rewrite.
      setDraft(candidate);
      setNotice(i18n.t("settings.url_endpoint_stripped"));
    } else {
      setNotice("");
    }

    setTesting(true);
    setScanning(false);
    setScanSummary("");
    setError(null);
    try {
      let result: ProviderValidationResult;
      try {
        result = await sendToBackground("validateProvider", {
          providerId: provider.id,
          credentials: candidate,
        });
      } catch (error) {
        result = {
          ok: false,
          code: "unknown",
          detail: `validateProvider request failed: ${errorText(error)}`,
        };
      }
      if (!result.ok) {
        // A newer Save & test took over; its own outcome is the one to show.
        if (result.code === "superseded") return;
        setError(
          describeValidationFailure(provider, guideUrl(helpPath, getActiveLocale()), {
            code: result.code,
            detail: result.detail,
            storedVersion: result.storedVersion,
            description: result.description,
            keptPrevious: verified,
          }),
        );
        return;
      }
      setDraft(null);
      setScanning(true);
      try {
        const result = await sendToBackground("scanVoices", { providerId: provider.id });
        setScanSummary(
          result.familiesUnavailable === 0
            ? i18n.t("settings.scan_ok", [String(result.familiesChecked)])
            : i18n.t("settings.scan_issues", [String(result.familiesUnavailable)]),
        );
      } catch (error) {
        setError({
          title: i18n.t("settings.validation_unknown_title"),
          message: i18n.t("settings.scan_failed"),
          detail: errorText(error),
        });
      }
    } finally {
      setTesting(false);
      setScanning(false);
    }
  }

  async function handleEnabledChange(next: boolean) {
    const written = await updateWith((current) =>
      withProviderPrefs(current, provider.id, { enabled: next }),
    );
    // After a failed write a voice refresh would describe state that was never persisted.
    if (!written) return;
    await sendToBackground("fetchVoices").catch(() => {});
  }

  // Advisory shape/URL warnings, live while typing; never block anything.
  function fieldWarningText(field: CredentialField): string | undefined {
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

  return (
    <AccordionItem value={provider.id} data-testid={`provider-${provider.id}`}>
      <AccordionTrigger>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-body">{tDynamic(provider.labelKey)}</div>
          <div className="truncate text-xxs text-muted">{summary}</div>
        </div>
        <StatusChip provider={provider} settings={settings} />
      </AccordionTrigger>
      <AccordionContent>
        <div className="flex flex-col gap-3">
          {provider.credentialSchema.map((field) => (
            <Input
              key={field.key}
              label={tDynamic(field.labelKey)}
              placeholder={field.placeholder}
              type={field.type}
              value={values[field.key] ?? ""}
              disabled={testing}
              error={fieldErrors[field.key]}
              warning={fieldErrors[field.key] ? undefined : fieldWarningText(field)}
              onChange={(value) => {
                setDraft({ ...values, [field.key]: value });
                setError(null);
                setNotice("");
                setFieldErrors(({ [field.key]: _cleared, ...rest }) => rest);
                // The old scan verdict described different credentials.
                setScanSummary("");
              }}
            />
          ))}
          {error && <ErrorNotice error={error.value} reportKey={error.key} />}
          {notice && <div className="text-xxs text-muted">{notice}</div>}
          {writeFailure && <ErrorNotice error={writeFailure.value} reportKey={writeFailure.key} />}
          {scanSummary && <div className="text-xxs font-semibold text-muted">{scanSummary}</div>}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="cursor-pointer text-xxs font-semibold text-body underline decoration-brand decoration-[1.5px] underline-offset-2 hover:text-strong"
              onClick={() => browser.tabs.create({ url: guideUrl(helpPath, getActiveLocale()) })}
            >
              {i18n.t("settings.where_help")}
            </button>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xxs font-semibold text-muted">
                <Switch
                  checked={enabled}
                  onCheckedChange={handleEnabledChange}
                  disabled={!verified || testing}
                  aria-label={i18n.t("settings.enabled")}
                />
                {i18n.t("settings.enabled")}
              </span>
              <Button variant="primary" submitting={testing} onClick={handleSaveAndTest}>
                {scanning
                  ? i18n.t("settings.scan")
                  : testing
                    ? i18n.t("settings.testing")
                    : i18n.t("settings.save_and_test")}
              </Button>
            </div>
          </div>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function Settings() {
  const { settings, update, syncEnabled, setSyncEnabled, writeFailure, newerVersion } =
    useSettings();
  // A synced copy a newer build wrote can only be adopted, never replaced from here.
  //   "conflict"        -> another device's synced copy differs: which copy wins
  //   "conflict-newer"  -> the synced copy is from a newer build: adopt or cancel
  //   "disable"         -> disabling deletes the synced copy for every signed-in browser
  const [syncPrompt, setSyncPrompt] = useState<"conflict" | "conflict-newer" | "disable" | null>(
    null,
  );
  const [syncError, setSyncError] = useReport<ErrorPayload>();
  const syncFailure = syncError ?? writeFailure;
  if (settings === null) return null;

  async function handleSyncToggle(next: boolean) {
    setSyncError(null);
    setSyncPrompt(null);
    if (!settings) return;
    if (!next) {
      setSyncPrompt("disable");
      return;
    }
    // Conflict first: adopting a smaller remote copy must stay possible when this device's settings
    // are too large to upload. A newer remote is a conflict even when its known fields match: its
    // unknown fields would be lost, and storage refuses the overwrite anyway.
    const remote = await peekSyncedSettings();
    if (remote !== null && remote.storedVersion > SETTINGS_VERSION) {
      setSyncPrompt("conflict-newer");
      return;
    }
    if (remote !== null && JSON.stringify(remote.settings) !== JSON.stringify(settings)) {
      setSyncPrompt("conflict");
      return;
    }
    if (!checkLocalFitsSync()) return;
    await setSyncEnabled(true);
  }

  /** Chrome's per-item quota, checked before any local-copy upload path. */
  function checkLocalFitsSync(): boolean {
    const size = settings ? estimateSyncSizeBytes(settings) : 0;
    if (size > SYNC_QUOTA_BYTES_PER_ITEM) {
      setSyncError({
        title: i18n.t("settings.storage_error_title"),
        message: i18n.t("settings.sync_too_large"),
        detail: `SyncTooLarge: settings estimate ${size} bytes > QUOTA_BYTES_PER_ITEM ${SYNC_QUOTA_BYTES_PER_ITEM}`,
      });
      return false;
    }
    return true;
  }

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
              <ProviderRow key={provider.id} provider={provider} />
            ))}
          </Accordion>
        </div>

        <div>
          <SectionTitle>{i18n.t("settings.sync_title")}</SectionTitle>
          <Card className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-body">{i18n.t("settings.sync_label")}</div>
              <div className={cn("text-xxs", syncEnabled ? "text-faint" : "text-muted")}>
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
              <div>
                {syncPrompt === "conflict"
                  ? i18n.t("settings.sync_conflict")
                  : syncPrompt === "conflict-newer"
                    ? i18n.t("settings.sync_conflict_newer")
                    : i18n.t("settings.sync_disable_warning")}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {syncPrompt === "conflict" && (
                  <Button
                    onClick={() => {
                      setSyncPrompt(null);
                      if (!checkLocalFitsSync()) return;
                      void setSyncEnabled(true);
                    }}
                  >
                    {i18n.t("settings.sync_keep_local")}
                  </Button>
                )}
                {syncPrompt === "disable" ? (
                  <Button
                    onClick={() => {
                      setSyncPrompt(null);
                      void setSyncEnabled(false);
                    }}
                  >
                    {i18n.t("common.continue")}
                  </Button>
                ) : (
                  <Button
                    onClick={() => {
                      setSyncPrompt(null);
                      void setSyncEnabled(true, { adoptRemote: true });
                    }}
                  >
                    {i18n.t("settings.sync_use_synced")}
                  </Button>
                )}
                <Button onClick={() => setSyncPrompt(null)}>{i18n.t("common.cancel")}</Button>
              </div>
            </div>
          )}
          {syncFailure && (
            <ErrorNotice error={syncFailure.value} reportKey={syncFailure.key} className="mt-2" />
          )}
        </div>

        <BackupSection />

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
