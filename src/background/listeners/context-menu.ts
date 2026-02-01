import { sanitizeTextForSSML } from "../../helpers/text-helpers";
import { handlers } from "../handlers";

export function registerContextMenuListener(): void {
	chrome.contextMenus.onClicked.addListener(function (info, _tab) {
		console.log("Handling context menu click...", ...arguments);

		const id = info.menuItemId;
		const sanitizedText = sanitizeTextForSSML(info.selectionText || "");
		const payload = { text: sanitizedText };

		if (!handlers[id]) throw new Error(`No handler found for ${id}`);

		handlers[id](payload);
	});
}
