import { useState } from "react";
import { browser } from "#imports";
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
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { cn } from "@/lib/cn";
import {
  credentialFieldError,
  credentialFieldWarning,
  stripEndpointSuffixes,
  trimValues,
} from "@/lib/credential-checks";
import { localizeGuideUrl } from "@/lib/guide";
import { getActiveLocale, i18n, tDynamic } from "@/lib/i18n-runtime";
import { sendToBackground } from "@/lib/messages";
import type { ProviderValidationResult, ValidationFailureCode } from "@/lib/provider-validation";
import {
  estimateSyncSizeBytes,
  peekSyncedSettings,
  type Settings as SettingsType,
  SYNC_QUOTA_BYTES_PER_ITEM,
  type UiLanguage,
} from "@/lib/storage";
import { providerList } from "@/providers";
import type { CredentialField, TtsProvider } from "@/providers/types";

interface ProviderError {
  message: string;
  detail?: string;
}

function validationFailureMessage(code: ValidationFailureCode): string {
  switch (code) {
    case "authentication":
      return i18n.t("settings.validation_authentication");
    case "permission":
      return i18n.t("settings.validation_permission");
    case "region":
      return i18n.t("settings.validation_region");
    case "quota":
      return i18n.t("settings.validation_quota");
    case "network":
      return i18n.t("settings.validation_network");
    case "storage":
      return i18n.t("settings.validation_storage");
    case "unknown":
      return i18n.t("settings.validation_unknown");
  }
}

function StatusChip({ provider, settings }: { provider: TtsProvider; settings: SettingsType }) {
  const valid = settings.credentialsValid[provider.id];
  const enabled = settings.enabledProviders[provider.id];

  if (valid && enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-xxs font-semibold text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {i18n.t("settings.connected")}
      </span>
    );
  }
  if (valid && !enabled) {
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
  const { settings, updateWith, writeError } = useSettings();
  const voices = useVoices();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [testing, setTesting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState("");
  const [error, setError] = useState<ProviderError | null>(null);
  // Per-field hard errors from the last Save & test attempt (localized text).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Non-error note, e.g. "endpoint path removed" after a URL auto-fix.
  const [notice, setNotice] = useState("");

  if (!settings) return null;

  const stored = settings.credentials[provider.id] ?? {};
  // Schema defaults (e.g. the most common region) prefill fields with nothing
  // stored yet, so the value the user sees is the value Save & test submits.
  const defaults = Object.fromEntries(
    provider.credentialSchema.flatMap((field) =>
      field.defaultValue ? [[field.key, field.defaultValue]] : [],
    ),
  );
  const values = draft ?? { ...defaults, ...stored };
  const voiceCount = voices.filter((v) => v.providerId === provider.id).length;
  const enabled = settings.enabledProviders[provider.id] ?? false;
  const valid = settings.credentialsValid[provider.id] ?? false;

  // For URL-based providers the host is the meaningful "where" (region-style
  // summary for the cloud providers).
  const baseUrlHost = (() => {
    if (!values.baseUrl) return undefined;
    try {
      return new URL(values.baseUrl).host;
    } catch {
      return undefined;
    }
  })();

  const summary =
    valid && enabled
      ? [
          i18n.t("settings.connected"),
          values.region ?? baseUrlHost,
          voiceCount > 0 ? i18n.t("settings.voices_count", [String(voiceCount)]) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : i18n.t("settings.not_connected");

  // One button does the whole health check: validate the credentials, then
  // immediately scan which engine families this key can actually use (each
  // provider defines its own access rules; Google gates Gemini voices behind
  // a separate API, for example).
  async function handleSaveAndTest() {
    // Client-side pass first: trim paste artifacts, auto-remove pasted
    // endpoint paths, and flag deterministic problems on the fields
    // themselves (native-form style) instead of round-tripping to the
    // background for a live test that cannot succeed.
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
        const response = await sendToBackground("validateProvider", {
          providerId: provider.id,
          credentials: candidate,
        });
        result = response ?? {
          ok: false,
          code: "unknown",
          detail: i18n.t("settings.validation_background_unavailable"),
        };
      } catch {
        result = {
          ok: false,
          code: "unknown",
          detail: i18n.t("settings.validation_background_unavailable"),
        };
      }
      if (!result.ok) {
        const message = [
          validationFailureMessage(result.code),
          valid ? i18n.t("settings.validation_kept") : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        setError({ message, detail: result.detail });
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
      } catch {
        setError({ message: i18n.t("settings.scan_failed") });
      }
    } finally {
      setTesting(false);
      setScanning(false);
    }
  }

  async function handleEnabledChange(next: boolean) {
    const written = await updateWith((current) => ({
      enabledProviders: { ...current.enabledProviders, [provider.id]: next },
    }));
    // Failed write (quota/rate): the hook's writeError renders below; a voice
    // refresh would only describe state that was never persisted.
    if (!written) return;
    await sendToBackground("fetchVoices").catch(() => {});
  }

  const helpUrl = provider.credentialSchema[0]?.helpUrl;

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
          {error && (
            <div className="flex flex-col gap-1 text-xxs text-danger">
              <div className="font-semibold">{error.message}</div>
              {error.detail && (
                <div className="cursor-text select-text break-words">
                  {i18n.t("settings.validation_details", [error.detail])}
                </div>
              )}
            </div>
          )}
          {notice && <div className="text-xxs text-muted">{notice}</div>}
          {writeError && <div className="text-xxs text-danger">{writeError}</div>}
          {scanSummary && <div className="text-xxs font-semibold text-muted">{scanSummary}</div>}
          <div className="flex items-center justify-between gap-2">
            {helpUrl ? (
              <button
                type="button"
                className="cursor-pointer text-xxs font-semibold text-body underline decoration-brand decoration-[1.5px] underline-offset-2 hover:text-strong"
                onClick={() =>
                  browser.tabs.create({ url: localizeGuideUrl(helpUrl, getActiveLocale()) })
                }
              >
                {i18n.t("settings.where_help")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xxs font-semibold text-muted">
                <Switch
                  checked={enabled}
                  onCheckedChange={handleEnabledChange}
                  disabled={!valid || testing}
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
  const { ready, settings, update, syncEnabled, setSyncEnabled, writeError } = useSettings();
  // Two-step sync flows: enabling over another device's differing synced
  // copy needs a which-copy-wins choice; disabling deletes the synced copy
  // for every signed-in browser and needs a confirm.
  const [syncPrompt, setSyncPrompt] = useState<"conflict" | "disable" | null>(null);
  const [syncError, setSyncError] = useState("");
  if (!ready || !settings) return null;

  async function handleSyncToggle(next: boolean) {
    setSyncError("");
    setSyncPrompt(null);
    if (!settings) return;
    if (!next) {
      setSyncPrompt("disable");
      return;
    }
    // Conflict first: adopting a smaller remote copy must stay possible even
    // when THIS device's settings are too large to upload.
    const remote = await peekSyncedSettings();
    if (remote !== null && JSON.stringify(remote) !== JSON.stringify(settings)) {
      setSyncPrompt("conflict");
      return;
    }
    if (!checkLocalFitsSync()) return;
    await setSyncEnabled(true);
  }

  /** Chrome's per-item quota, checked before any local-copy upload path. */
  function checkLocalFitsSync(): boolean {
    if (settings && estimateSyncSizeBytes(settings) > SYNC_QUOTA_BYTES_PER_ITEM) {
      setSyncError(i18n.t("settings.sync_too_large"));
      return false;
    }
    return true;
  }

  const anyConnected = providerList.some(
    (p) => settings.credentialsValid[p.id] && settings.enabledProviders[p.id],
  );

  // The non-auto titles are endonyms and deliberately NOT translated (no
  // locale keys): whatever language the UI is stuck in, every reader must
  // recognize their own language in this list.
  const uiLanguageOptions = [
    { value: "auto", title: i18n.t("settings.ui_language_auto") },
    { value: "en", title: "English" },
    { value: "hi", title: "हिन्दी" },
    { value: "zh_CN", title: "简体中文" },
    { value: "zh_TW", title: "繁體中文" },
  ];

  return (
    <div className="flex flex-col gap-5">
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
            onCheckedChange={(next) => void handleSyncToggle(next)}
            aria-label={i18n.t("settings.sync_label")}
          />
        </Card>
        {syncPrompt && (
          <div className="mt-2 rounded border border-note-edge bg-note p-2.5 text-xxs text-note-text">
            <div>
              {syncPrompt === "conflict"
                ? i18n.t("settings.sync_conflict")
                : i18n.t("settings.sync_disable_warning")}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {syncPrompt === "conflict" ? (
                <>
                  <Button
                    onClick={() => {
                      setSyncPrompt(null);
                      if (!checkLocalFitsSync()) return;
                      void setSyncEnabled(true);
                    }}
                  >
                    {i18n.t("settings.sync_keep_local")}
                  </Button>
                  <Button
                    onClick={() => {
                      setSyncPrompt(null);
                      void setSyncEnabled(true, { adoptRemote: true });
                    }}
                  >
                    {i18n.t("settings.sync_use_synced")}
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => {
                    setSyncPrompt(null);
                    void setSyncEnabled(false);
                  }}
                >
                  {i18n.t("common.continue")}
                </Button>
              )}
              <Button onClick={() => setSyncPrompt(null)}>{i18n.t("common.cancel")}</Button>
            </div>
          </div>
        )}
        {(syncError || writeError) && (
          <div className="mt-2 text-xxs text-danger">{syncError || writeError}</div>
        )}
      </div>

      <div>
        <SectionTitle>{i18n.t("settings.ui_language_title")}</SectionTitle>
        <Card className="flex flex-col gap-1.5">
          <LabeledSelect
            label={i18n.t("settings.ui_language_label")}
            value={settings.uiLanguage}
            options={uiLanguageOptions}
            onChange={(value) => void update({ uiLanguage: value as UiLanguage })}
          />
          <div className="text-xxs text-muted">{i18n.t("settings.ui_language_hint")}</div>
        </Card>
      </div>
    </div>
  );
}
