import { useState } from "react";
import { useMount } from "./useMount";
import { SessionStorage } from "../types";

export function useSession() {
	const [ready, setReady] = useState(false);
	const [value, setValue] = useState<Partial<SessionStorage>>({});

	useMount(() => {
		chrome.storage.session.get(null, handleLoad);
		chrome.storage.session.onChanged.addListener(handleOnChanged);
		return () => chrome.storage.session.onChanged.removeListener(handleOnChanged);
	});

	async function handleOnChanged() {
		const session = await chrome.storage.session.get();
		setValue(session);
	}

	async function handleLoad(session: Partial<SessionStorage>) {
		await setSession(session);
		setReady(true);
		setValue(session);
	}

	async function setSession(session: Partial<SessionStorage>) {
		await chrome.storage.session.set(session);
	}

	return { session: value as SessionStorage, setSession, ready };
}
