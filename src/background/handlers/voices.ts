import { DescribeVoicesCommand, PollyClient } from "@aws-sdk/client-polly";
import { SyncStorage, Voice } from "../../types";
import { setLanguages } from "../utils/storage";

export async function fetchVoices(): Promise<Voice[] | false> {
	console.log("Fetching voices...", ...arguments);

	try {
		const sync = (await chrome.storage.sync.get()) as SyncStorage;

		if (!sync.accessKeyId || !sync.secretAccessKey || !sync.region) {
			console.warn("AWS credentials not configured");
			return false;
		}

		// Create Polly client
		const pollyClient = new PollyClient({
			region: sync.region,
			credentials: {
				accessKeyId: sync.accessKeyId,
				secretAccessKey: sync.secretAccessKey,
			},
		});

		const command = new DescribeVoicesCommand({});
		const response = await pollyClient.send(command);

		const voices = response.Voices || [];
		if (!voices.length) throw new Error("No voices found");

		// Transform Polly voice format to match the expected structure
		const transformedVoices: Voice[] = voices.map((voice) => ({
			name: voice.Id || "",
			ssmlGender: voice.Gender || "NEUTRAL",
			languageCodes: [voice.LanguageCode || ""],
			naturalSampleRateHertz: 22050, // Default sample rate as SampleRate is not available in voice object
			supportedEngines: voice.SupportedEngines || ["standard"], // Default to standard if not provided
		}));

		await chrome.storage.session.set({ voices: transformedVoices });
		await setLanguages();

		return transformedVoices;
	} catch (e) {
		console.warn("Failed to fetch voices", e);
		return false;
	}
}
