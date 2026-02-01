import { sanitizeTextForSSML } from "../../helpers/text-helpers";
import { SyncStorage } from "../../types";
import {
	addToQueue,
	getCancellationToken,
	getQueue,
	isPlaying,
	setCancellationToken,
	setPlaying,
	shiftQueue,
} from "../state";
import { updateContextMenus } from "../utils/context-menus";
import { retrieveSelection } from "../utils/messaging";
import { createOffscreenDocument } from "../utils/offscreen";
import { getAudioUri } from "./synthesis";
import { stopReading } from "./stop-reading";

export async function readAloud1x({ text }: { text: string }): Promise<boolean> {
	return readAloud({ text, speed: 1 });
}

export async function readAloud1_5x({ text }: { text: string }): Promise<boolean> {
	return readAloud({ text, speed: 1.5 });
}

export async function readAloud2x({ text }: { text: string }): Promise<boolean> {
	return readAloud({ text, speed: 2 });
}

export async function readAloud({ text, speed }: { text: string; speed?: number }): Promise<boolean> {
	console.log("Reading aloud...", ...arguments);

	if (isPlaying()) await stopReading();

	const sync = (await chrome.storage.sync.get()) as SyncStorage;
	const chunks = text.chunk();
	console.log("Chunked text into", chunks.length, "chunks", chunks);

	addToQueue(...chunks);
	setPlaying(true);
	updateContextMenus();

	let count = 0;
	const encoding = sync.readAloudEncoding;
	const prefetchQueue = [];
	setCancellationToken(false);
	const queue = getQueue();
	while (queue.length) {
		if (getCancellationToken()) {
			setCancellationToken(false);
			setPlaying(false);
			updateContextMenus();
			return;
		}

		const text = shiftQueue();
		const nextText = queue[0];

		if (nextText) {
			prefetchQueue.push(getAudioUri({ text: nextText, encoding, speed }));
		}

		const audioUri = count === 0 ? await getAudioUri({ text, encoding, speed }) : await prefetchQueue.shift();

		try {
			await createOffscreenDocument();
			await chrome.runtime.sendMessage({
				id: "play",
				payload: { audioUri },
				offscreen: true,
			});
		} catch (e) {
			console.warn("Failed to play audio", e);

			// Audio playback may have failed because the user stopped playback, or
			// called the readAloud function again. We need to return early to avoid
			// playing the next chunk.
			return;
		}

		console.log("Play through of audio complete. Enqueuing next chunk.");
		count++;
	}

	setPlaying(false);
	updateContextMenus();
	return Promise.resolve(true);
}

export async function readAloudShortcut(): Promise<void> {
	console.log("Handling read aloud shortcut...", ...arguments);

	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const result = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: retrieveSelection,
	});
	const rawText = result[0].result;
	const text = sanitizeTextForSSML(rawText || "");

	if (isPlaying()) {
		await stopReading();

		if (!text) return;
	}

	readAloud({ text });
}
