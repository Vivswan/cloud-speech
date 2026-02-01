import { registerCommandsListener } from "./commands";
import { registerContextMenuListener } from "./context-menu";
import { registerMessagesListener } from "./messages";
import { registerRuntimeListener } from "./runtime";
import { registerStorageListener } from "./storage";

export function registerListeners(): void {
	registerCommandsListener();
	registerMessagesListener();
	registerStorageListener();
	registerContextMenuListener();
	registerRuntimeListener();
}
