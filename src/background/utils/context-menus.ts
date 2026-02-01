import { fileExtMap } from "../../helpers/file-helpers";
import { bootstrapped, isPlaying } from "../state";

export async function updateContextMenus(): Promise<void> {
	console.log("Updating context menus...", { playing: isPlaying() });

	// Prevents context menus from being updated before they are created,
	// which causes an unnecessary error in the console.
	await bootstrapped;

	const commands = await chrome.commands.getAll();
	const encoding = (await chrome.storage.sync.get()).downloadEncoding as string;
	const fileExt = fileExtMap[encoding];
	const downloadShortcut = commands.find((c) => c.name === "downloadShortcut")?.shortcut;

	chrome.contextMenus.update("readAloud", {
		enabled: true,
	});

	chrome.contextMenus.update("readAloud1x", {
		enabled: true,
	});

	chrome.contextMenus.update("readAloud1_5x", {
		enabled: true,
	});

	chrome.contextMenus.update("readAloud2x", {
		enabled: true,
	});

	chrome.contextMenus.update("stopReading", {
		enabled: isPlaying(),
	});

	chrome.contextMenus.update("download", {
		title: `Download ${fileExt?.toUpperCase()}${downloadShortcut && ` (${downloadShortcut})`}`,
	});
}

export async function createContextMenus(): Promise<void> {
	console.log("Creating context menus...", ...arguments);
	chrome.contextMenus.removeAll();

	const commands = await chrome.commands.getAll();
	const readAloudShortcut = commands.find((c) => c.name === "readAloudShortcut")?.shortcut;
	const downloadShortcut = commands.find((c) => c.name === "downloadShortcut")?.shortcut;
	const downloadEncoding = (await chrome.storage.sync.get()).downloadEncoding as string;
	const fileExt = fileExtMap[downloadEncoding];

	chrome.contextMenus.create({
		id: "readAloud",
		title: `Read Aloud ${readAloudShortcut && ` (${readAloudShortcut})`}`,
		contexts: ["selection"],
		enabled: !isPlaying(),
	});

	chrome.contextMenus.create({
		id: "readAloud1x",
		title: `Read Aloud (1x)`,
		contexts: ["selection"],
		enabled: !isPlaying(),
	});

	chrome.contextMenus.create({
		id: "readAloud1_5x",
		title: `Read Aloud (1.5x)`,
		contexts: ["selection"],
		enabled: !isPlaying(),
	});

	chrome.contextMenus.create({
		id: "readAloud2x",
		title: `Read Aloud (2x)`,
		contexts: ["selection"],
		enabled: !isPlaying(),
	});

	chrome.contextMenus.create({
		id: "stopReading",
		title: `Stop reading${readAloudShortcut && ` (${readAloudShortcut})`}`,
		contexts: ["all"],
		enabled: isPlaying(),
	});

	chrome.contextMenus.create({
		id: "download",
		title: `Download ${fileExt?.toUpperCase()}${downloadShortcut && ` (${downloadShortcut})`}`,
		contexts: ["selection"],
	});
}
