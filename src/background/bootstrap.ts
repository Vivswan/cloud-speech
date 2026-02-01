import { handlers } from "./handlers";
import { resolveBootstrap } from "./state";
import { createContextMenus } from "./utils/context-menus";
import { migrateSyncStorage, setDefaultSettings } from "./utils/storage";

export async function bootstrap(): Promise<void> {
	await migrateSyncStorage();
	await handlers.fetchVoices();
	await setDefaultSettings();
	await createContextMenus();
	resolveBootstrap();
}
