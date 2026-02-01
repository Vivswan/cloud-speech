import { clearQueue, setCancellationToken, setPlaying } from "../state";
import { updateContextMenus } from "../utils/context-menus";
import { createOffscreenDocument } from "../utils/offscreen";

export async function stopReading(): Promise<boolean> {
	console.log("Stopping reading...", ...arguments);

	setCancellationToken(true);
	clearQueue();
	setPlaying(false);
	updateContextMenus();

	try {
		await createOffscreenDocument();
		await chrome.runtime.sendMessage({
			id: "stop",
			offscreen: true,
		});
	} catch (e) {
		console.warn("Failed to stop audio", e);
	}

	return Promise.resolve(true);
}
