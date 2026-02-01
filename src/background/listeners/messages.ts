import { handlers } from "../handlers";

export function registerMessagesListener(): void {
	chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
		console.log("Handling message...", ...arguments);

		const { id, payload } = request;

		if (!handlers[id]) throw new Error(`No handler found for ${id}`);
		handlers[id](payload).then(sendResponse);

		return true;
	});
}
