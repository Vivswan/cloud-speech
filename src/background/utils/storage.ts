import { SessionStorage, Voice } from "../../types";

export async function setDefaultSettings(): Promise<void> {
	console.log("Setting default settings...", ...arguments);

	await chrome.storage.session.setAccessLevel({
		accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
	});

	const sync = await chrome.storage.sync.get();
	await chrome.storage.sync.set({
		language: sync.language || "en-US",
		speed: sync.speed || 1,
		pitch: sync.pitch || 0,
		voices: sync.voices || { "en-US": "Joanna" },
		readAloudEncoding: sync.readAloudEncoding || "OGG_OPUS",
		downloadEncoding: sync.downloadEncoding || "MP3_64_KBPS",
		accessKeyId: sync.accessKeyId || "",
		secretAccessKey: sync.secretAccessKey || "",
		region: sync.region || "us-east-1",
		audioProfile: sync.audioProfile || "default",
		volumeGainDb: sync.volumeGainDb || 0,
		engine: sync.engine || "standard",
	});
}

export async function migrateSyncStorage(): Promise<void> {
	console.log("Migrating sync storage...", ...arguments);

	const sync = await chrome.storage.sync.get();

	// Extension with version 8 had OGG_OPUS as a download option, but
	// it was rolled back in version 9. Due to audio stiching issues.
	if (Number(chrome.runtime.getManifest().version) <= 9 && sync.downloadEncoding == "OGG_OPUS") {
		await chrome.storage.sync.set({ downloadEncoding: "MP3_64_KBPS" });
	}

	// Extensions with version < 8 had a different storage structure.
	// We need to migrate them to the new structure before we can use them.
	if (sync.voices || Number(chrome.runtime.getManifest().version) < 8) return;

	await chrome.storage.sync.clear();

	const newSync: any = {};
	if (sync.locale) {
		const oldVoiceParts = sync.locale.split("-");
		newSync.language = [oldVoiceParts[0], oldVoiceParts[1]].join("-");
		newSync.voices = { [newSync.language]: sync.locale };
	}

	if (sync.speed) {
		newSync.speed = Number(sync.speed);
	}

	if (sync.pitch) {
		newSync.pitch = 0;
	}

	// Migrate from Google Cloud API key to AWS credentials
	if (sync.apiKey) {
		// Clear old API key since we're now using AWS
		newSync.accessKeyId = "";
		newSync.secretAccessKey = "";
		newSync.region = "us-east-1";
		newSync.credentialsValid = false;
	}

	await chrome.storage.sync.set(newSync);
}

export async function setLanguages(): Promise<Set<string>> {
	console.log("Setting languages...", ...arguments);

	const session = (await chrome.storage.session.get()) as SessionStorage;

	if (!session.voices) {
		throw new Error("No voices found. Cannot set languages.");
	}

	const languages = new Set(session.voices?.map((voice: Voice) => voice.languageCodes).flat() || []);

	await chrome.storage.session.set({ languages: Array.from(languages) });

	return languages;
}
