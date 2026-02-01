import { Engine, OutputFormat, PollyClient, SynthesizeSpeechCommand, TextType, VoiceId } from "@aws-sdk/client-polly";
import { fileExtMap } from "../../helpers/file-helpers";
import { SyncStorage, SynthesizeParams } from "../../types";
import { AUDIO_CHUNK_SIZE } from "../state";
import { sendMessageToCurrentTab } from "../utils/messaging";
import { stopReading } from "./stop-reading";

export async function synthesize(params: SynthesizeParams): Promise<string> {
	console.log("Synthesizing text...", ...arguments);

	const { text, encoding, voice, accessKeyId, secretAccessKey, region, speed, pitch, volumeGainDb, engine } = params;

	if (!accessKeyId || !secretAccessKey || !region) {
		sendMessageToCurrentTab({
			id: "setError",
			payload: {
				icon: "error",
				title: "AWS credentials are missing",
				message:
					"Please enter valid AWS Access Key ID, Secret Access Key, and Region in the extension popup. Instructions: https://docs.aws.amazon.com/polly/latest/dg/setting-up.html",
			},
		});

		throw new Error("AWS credentials are missing");
	}

	// Create Polly client
	const pollyClient = new PollyClient({
		region,
		credentials: {
			accessKeyId,
			secretAccessKey,
		},
	});

	let ssml;
	let textToSynthesize = text;
	if (text.isSSML()) {
		ssml = text;
		textToSynthesize = undefined;
	}

	// Apply prosody settings (pitch, speed, volume) to text/SSML
	const prosodyAttributes = [];
	if (speed !== 1) {
		prosodyAttributes.push(`rate="${Math.round(speed * 100)}%"`);
	}
	if (pitch !== 0) {
		const pitchSign = pitch >= 0 ? "+" : "";
		prosodyAttributes.push(`pitch="${pitchSign}${pitch}%"`);
	}
	if (volumeGainDb !== 0) {
		const volumeSign = volumeGainDb >= 0 ? "+" : "";
		prosodyAttributes.push(`volume="${volumeSign}${volumeGainDb}dB"`);
	}

	if (prosodyAttributes.length > 0) {
		const prosodyTag = `<prosody ${prosodyAttributes.join(" ")}>`;
		if (ssml) {
			// If already SSML, wrap the content inside speak tags
			ssml = ssml.replace(/<speak[^>]*>(.*)<\/speak>/s, `<speak>${prosodyTag}$1</prosody></speak>`);
		} else {
			// Convert text to SSML with prosody
			ssml = `<speak>${prosodyTag}${text}</prosody></speak>`;
			textToSynthesize = undefined;
		}
	}

	// Map audio formats to Polly supported formats
	const formatMap: { [key: string]: OutputFormat } = {
		MP3: OutputFormat.MP3,
		MP3_64_KBPS: OutputFormat.MP3,
		OGG_OPUS: OutputFormat.OGG_VORBIS,
	};

	// Map engine strings to AWS SDK Engine enum
	const engineMap: { [key: string]: Engine } = {
		standard: Engine.STANDARD,
		neural: Engine.NEURAL,
		generative: Engine.GENERATIVE,
		"long-form": Engine.LONG_FORM,
	};

	const pollyParams = {
		OutputFormat: formatMap[encoding] || OutputFormat.MP3,
		Text: ssml || textToSynthesize,
		TextType: (ssml ? TextType.SSML : TextType.TEXT) as TextType,
		VoiceId: voice as VoiceId,
		Engine: engineMap[engine.toLowerCase()] || Engine.STANDARD,
	};

	try {
		const command = new SynthesizeSpeechCommand(pollyParams);
		const response = await pollyClient.send(command);

		if (!response.AudioStream) {
			throw new Error("No audio stream received from Polly");
		}

		// Convert the audio stream to base64
		const audioBytes = await response.AudioStream.transformToByteArray();
		const binaryChunks: string[] = [];
		for (let i = 0; i < audioBytes.length; i += AUDIO_CHUNK_SIZE) {
			const chunk = audioBytes.slice(i, i + AUDIO_CHUNK_SIZE);
			binaryChunks.push(String.fromCharCode(...chunk));
		}
		return btoa(binaryChunks.join(""));
	} catch (error) {
		console.error("Polly API error:", error);

		sendMessageToCurrentTab({
			id: "setError",
			payload: { title: "Failed to synthesize text", message: String(error) },
		});

		await stopReading();
		throw error;
	}
}

export async function getAudioUri({
	text,
	encoding,
	speed,
}: {
	text: string;
	encoding: string;
	speed?: number;
}): Promise<string> {
	console.log("Getting audio URI...", ...arguments);

	const sync = (await chrome.storage.sync.get()) as SyncStorage;
	const voice = sync.voices[sync.language];

	const chunks = text.chunk();
	console.log("Chunked text into", chunks.length, "chunks", chunks);

	const promises = chunks.map((text) =>
		synthesize({
			text,
			encoding,
			voice,
			accessKeyId: sync.accessKeyId,
			secretAccessKey: sync.secretAccessKey,
			region: sync.region,
			speed: speed !== undefined ? speed : sync.speed,
			pitch: sync.pitch,
			volumeGainDb: sync.volumeGainDb,
			engine: sync.engine,
		})
	);
	const audioContents = await Promise.all(promises);

	return `data:audio/${fileExtMap[encoding]};base64,` + btoa(audioContents.map(atob).join(""));
}
