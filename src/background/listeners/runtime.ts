export function registerRuntimeListener(): void {
	chrome.runtime.onInstalled.addListener(async function (details) {
		console.log("Handling runtime install...", ...arguments);

		const self = await chrome.management.getSelf();
		if (details.reason === "install" && self.installType !== "development") {
			const helpUrl = chrome.runtime.getURL("/help.html");

			chrome.tabs.create({ url: helpUrl });
		}
	});
}
