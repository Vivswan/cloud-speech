import { useState } from "react";
import { useMount } from "./useMount";
import { SyncStorage } from "../types";

// TODO(mike): Chrome has a maximum of syncs per minute. We should
// probably throttle the setter to avoid hitting that limit.
export function useSync() {
	const [ready, setReady] = useState(false);
	const [value, setValue] = useState<Partial<SyncStorage>>({});

	useMount(() => {
		chrome.storage.sync.get(null, handleLoad);
		chrome.storage.sync.onChanged.addListener(handleOnChanged);
		return () => chrome.storage.sync.onChanged.removeListener(handleOnChanged);
	});

	async function handleOnChanged() {
		const session = await chrome.storage.sync.get();
		setValue(session);
	}

	async function handleLoad(sync: Partial<SyncStorage>) {
		await setSync(sync);
		setReady(true);
		setValue(sync);
	}

	async function setSync(sync: Partial<SyncStorage>) {
		await chrome.storage.sync.set(sync);
	}

	return { sync: value as SyncStorage, setSync, ready };
}
