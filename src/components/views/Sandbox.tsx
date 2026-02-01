import React, { useState } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../buttons/Button";
import { Textarea } from "../inputs/Textarea";
import { useSync } from "../../hooks/useSync";
import { Download, Play } from "react-feather";
import { useTranslation } from "../../localization/translation";

export function Sandbox() {
	const { ready, sync } = useSync();
	const { t } = useTranslation();
	const [text, setText] = useLocalStorage("sandboxInput", "Hello Polly!");
	const [valueError, setValueError] = useState("");
	const [downloading, setDownloading] = useState(false);
	const [playing, setPlaying] = useState(false);
	if (!ready) return null;

	function handleValidation() {
		if (!sync.credentialsValid) {
			setValueError(t("sandbox.errors.credentials_invalid"));
			return false;
		}

		if (!text) {
			setValueError(t("sandbox.errors.text_empty"));
			return false;
		}

		return true;
	}

	async function handleDownload() {
		if (!handleValidation()) return;

		setDownloading(true);
		await chrome.runtime.sendMessage({ id: "download", payload: { text } });
		handleReset();
	}

	async function handleReadAloud() {
		if (!handleValidation()) return;

		setPlaying(true);
		await chrome.runtime.sendMessage({ id: "readAloud", payload: { text } });
		handleReset();
	}

	async function handleStop() {
		chrome.runtime.sendMessage({ id: "stopReading" });
		handleReset();
	}

	function handleReset() {
		setValueError("");
		setDownloading(false);
		setPlaying(false);
	}

	return (
		<div className="h-full flex flex-col">
			<div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">{t("sandbox.title")}</div>
			<div className="bg-white p-3 rounded shadow-sm border flex flex-col gap-2 grow">
				<Textarea
					label={t("sandbox.textarea_label")}
					value={text}
					onChange={setText}
					error={valueError}
					className="grow"
				/>
				<div className="flex gap-2 w-fit ml-auto">
					<Button Icon={Download} onClick={handleDownload} submitting={downloading}>
						{t("sandbox.download_button")}
					</Button>
					<Button type="primary" Icon={Play} onClick={playing ? handleStop : handleReadAloud}>
						{playing ? t("sandbox.stop_playback_button") : t("sandbox.read_aloud_button")}
					</Button>
				</div>
			</div>
		</div>
	);
}
