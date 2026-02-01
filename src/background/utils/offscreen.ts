let creating: Promise<void> | null = null;

export async function createOffscreenDocument(): Promise<void> {
	const path = "offscreen.html";

	if (await hasOffscreenDocument(path)) return;

	if (creating) {
		await creating;
	} else {
		creating = chrome.offscreen
			.createDocument({
				url: path,
				reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
				justification: "Plays synthesized audio in the background",
			})
			.then(() => {
				console.log("Offscreen document created successfully");
				creating = null;
			})
			.catch((error) => {
				console.error("Failed to create offscreen document", error);
				creating = null;
			});

		await creating;
		creating = null;
	}
}

async function hasOffscreenDocument(path: string): Promise<boolean> {
	console.log("Checking if offscreen document exists...", ...arguments);

	const offscreenUrl = chrome.runtime.getURL(path);
	const matchedClients = await clients.matchAll();

	for (const client of matchedClients) {
		if (client.url === offscreenUrl) return true;
	}

	return false;
}
