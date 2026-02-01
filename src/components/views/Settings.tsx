import React, { useState } from "react";
import { useSync } from "../../hooks/useSync";
import { Text } from "../inputs/Text";
import { Button } from "../buttons/Button";
import { Dropdown } from "../inputs/Dropdown";
import { Command, Key } from "react-feather";
import { getLanguageDisplayName, useTranslation } from "../../localization/translation";

export function Settings() {
	const { ready: syncReady, sync, setSync } = useSync();
	const { t, locale, setLocale, availableLocales } = useTranslation();
	const [credentialsValidating, setCredentialsValidating] = useState(false);
	const [credentialsError, setCredentialsError] = useState("");

	if (!syncReady) return null;

	async function handleCredentialsValidation() {
		setCredentialsValidating(true);

		const voices = await chrome.runtime.sendMessage({ id: "fetchVoices" });
		if (!voices) {
			setCredentialsError(t("settings.errors.credentials_invalid"));
			setCredentialsValidating(false);
			return setSync({ ...sync, credentialsValid: false });
		}

		setSync({ ...sync, credentialsValid: true });
		setCredentialsValidating(false);
		setCredentialsError("");
	}

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
					{t("settings.localization_title")}
				</div>
				<div className="bg-white p-3 rounded shadow-sm border">
					<Dropdown
						label={t("settings.language_label")}
						placeholder={t("settings.language_placeholder")}
						value={locale}
						onChange={setLocale}
						options={availableLocales.map((code) => ({
							value: code,
							title: getLanguageDisplayName(code),
						}))}
					/>
				</div>
			</div>
			<div>
				<div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
					{t("settings.aws_credentials_title")}
				</div>
				<div className="bg-white p-3 rounded shadow-sm border flex flex-col gap-2">
					<Text
						error={credentialsError}
						label={t("settings.access_key_label")}
						placeholder={t("settings.access_key_placeholder")}
						value={sync.accessKeyId}
						onChange={(accessKeyId) => setSync({ ...sync, accessKeyId, credentialsValid: false })}
						type="password"
					/>
					<Text
						label={t("settings.secret_key_label")}
						placeholder={t("settings.secret_key_placeholder")}
						value={sync.secretAccessKey}
						onChange={(secretAccessKey) => setSync({ ...sync, secretAccessKey, credentialsValid: false })}
						type="password"
					/>
					<Text
						label={t("settings.region_label")}
						placeholder={t("settings.region_placeholder")}
						value={sync.region}
						onChange={(region) => setSync({ ...sync, region, credentialsValid: false })}
					/>
					{!sync.credentialsValid && (
						<div className="w-fit ml-auto">
							<Button
								type="primary"
								Icon={Key}
								onClick={handleCredentialsValidation}
								submitting={credentialsValidating}
								ping={!sync.accessKeyId || !sync.secretAccessKey || !sync.region}
							>
								{t("settings.validate_credentials_button")}
							</Button>
						</div>
					)}
				</div>
			</div>
			<div className={!sync.credentialsValid ? "opacity-50 pointer-events-none" : ""}>
				<div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
					{t("settings.shortcuts_title")}
				</div>
				<div className="grid gap-4 grid-cols-2 bg-white p-3 rounded shadow-sm border">
					<Button
						type="primary"
						Icon={Command}
						onClick={() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}
					>
						{t("settings.edit_shortcuts_button")}
					</Button>
				</div>
			</div>
		</div>
	);
}
