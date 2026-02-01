import { handlers } from "../handlers";

export function registerCommandsListener(): void {
	chrome.commands.onCommand.addListener(function (command) {
		console.log("Handling command...", ...arguments);

		if (!handlers[command]) throw new Error(`No handler found for ${command}`);

		handlers[command]();
	});
}
