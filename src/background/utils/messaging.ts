function retrieveSelection(): string {
	console.log("Retrieving selection...", ...arguments);

	const activeElement = document.activeElement as HTMLInputElement | HTMLTextAreaElement;
	if (activeElement?.tagName === "INPUT" || activeElement?.tagName === "TEXTAREA") {
		const start = activeElement.selectionStart || 0;
		const end = activeElement.selectionEnd || 0;

		return activeElement.value.slice(start, end);
	}

	return window.getSelection()?.toString() || "";
}

async function sendMessageToCurrentTab(event: any): Promise<void> {
	console.log("Sending message to current tab...", ...arguments);

	const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
	const currentTab = tabs[0];

	if (!currentTab) {
		console.warn("No current tab found. Aborting message send.");
		return;
	}

	chrome.tabs.sendMessage(currentTab.id!, event);
}

export { retrieveSelection, sendMessageToCurrentTab };
