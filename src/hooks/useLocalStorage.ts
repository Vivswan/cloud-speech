import React, { useEffect, useState } from "react";

export function useLocalStorage<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
	const [value, setValue] = useState(() => getLocalStorageValue(key, defaultValue));

	useEffect(() => localStorage.setItem(key, JSON.stringify(value)), [key, value]);

	return [value, setValue];
}

function getLocalStorageValue<T>(key: string, defaultValue: T): T {
	const saved = localStorage.getItem(key);
	const initial = JSON.parse(saved);

	return initial || defaultValue;
}
