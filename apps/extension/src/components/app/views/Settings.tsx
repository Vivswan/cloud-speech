import { useState } from "react";
import { i18n } from "#i18n";
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
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/useSettings";
import { useVoices } from "@/hooks/useVoices";
import { cn } from "@/lib/cn";
import { tDynamic } from "@/lib/i18n";
import { sendToBackground } from "@/lib/messages";
import type { Settings as SettingsType } from "@/lib/storage";
import { providerList } from "@/providers";
import type { TtsProvider } from "@/providers/types";

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
      <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-xxs font-semibold text-stone-500">
        {i18n.t("settings.off")}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-xxs font-semibold text-stone-400">
      {i18n.t("settings.not_connected")}
    </span>
  );
}

function ProviderRow({ provider }: { provider: TtsProvider }) {
  const { settings, updateWith } = useSettings();
  const voices = useVoices();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [testing, setTesting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState("");
  const [error, setError] = useState("");

  if (!settings) return null;

  const stored = settings.credentials[provider.id] ?? {};
  const values = draft ?? stored;
  const voiceCount = voices.filter((v) => v.providerId === provider.id).length;
  const enabled = settings.enabledProviders[provider.id] ?? false;
  const valid = settings.credentialsValid[provider.id] ?? false;

  const summary =
    valid && enabled
      ? [
          i18n.t("settings.connected"),
          values.region,
          voiceCount > 0 ? i18n.t("settings.voices_count", [String(voiceCount)]) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : i18n.t("settings.not_connected");

  // One button does the whole health check: validate the credentials, then
  // immediately scan which engine families this key can actually use (each
  // provider defines its own access rules — Google gates Gemini voices behind
  // a separate API, for example).
  async function handleSaveAndTest() {
    setTesting(true);
    setScanning(false);
    setScanSummary("");
    setError("");
    try {
      let ok = false;
      try {
        ok = await sendToBackground("validateProvider", {
          providerId: provider.id,
          credentials: values,
        });
      } catch {
        ok = false;
      }
      if (!ok) {
        setError(i18n.t("settings.invalid_credentials"));
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
        setError(i18n.t("settings.scan_failed"));
      }
    } finally {
      setTesting(false);
      setScanning(false);
    }
  }

  async function handleEnabledChange(next: boolean) {
    await updateWith((current) => ({
      enabledProviders: { ...current.enabledProviders, [provider.id]: next },
    }));
    await sendToBackground("fetchVoices").catch(() => {});
  }

  const helpUrl = provider.credentialSchema[0]?.helpUrl;

  return (
    <AccordionItem value={provider.id}>
      <AccordionTrigger>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-stone-800">{tDynamic(provider.labelKey)}</div>
          <div className="truncate text-xxs text-stone-500">{summary}</div>
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
              onChange={(value) => {
                setDraft({ ...values, [field.key]: value });
                setError("");
                // The old scan verdict described different credentials.
                setScanSummary("");
              }}
            />
          ))}
          {error && <div className="text-xxs font-semibold text-red-500">{error}</div>}
          {scanSummary && (
            <div className="text-xxs font-semibold text-stone-500">{scanSummary}</div>
          )}
          <div className="flex items-center justify-between gap-2">
            {helpUrl ? (
              <button
                type="button"
                className="cursor-pointer text-xxs font-semibold text-stone-700 underline decoration-brand decoration-[1.5px] underline-offset-2 hover:text-ink"
                onClick={() => browser.tabs.create({ url: helpUrl })}
              >
                {i18n.t("settings.where_help")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xxs font-semibold text-stone-500">
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
  const { ready, settings, syncEnabled, setSyncEnabled } = useSettings();
  if (!ready || !settings) return null;

  const anyConnected = providerList.some(
    (p) => settings.credentialsValid[p.id] && settings.enabledProviders[p.id],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionTitle>{i18n.t("settings.providers_title")}</SectionTitle>
        {!anyConnected && (
          <div className="mb-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
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
            <div className="text-xs font-semibold text-stone-700">
              {i18n.t("settings.sync_label")}
            </div>
            <div className={cn("text-xxs", syncEnabled ? "text-stone-400" : "text-stone-500")}>
              {syncEnabled ? i18n.t("settings.sync_on_hint") : i18n.t("settings.sync_off_hint")}
            </div>
          </div>
          <Switch
            checked={syncEnabled}
            onCheckedChange={setSyncEnabled}
            aria-label={i18n.t("settings.sync_label")}
          />
        </Card>
      </div>
    </div>
  );
}
