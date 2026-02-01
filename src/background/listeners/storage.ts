import { updateContextMenus } from "../utils/context-menus";

export function registerStorageListener(): void {
	chrome.storage.onChanged.addListener(function (changes) {
		console.log("Handling storage change...", ...arguments);

		if (!changes.downloadEncoding) return;

		updateContextMenus();
	});
}
