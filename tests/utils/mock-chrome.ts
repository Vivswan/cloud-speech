import { vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Creates a mock Chrome storage object with in-memory storage
 */
export function createMockChromeStorage() {
	const syncStore: Record<string, any> = {};
	const localStore: Record<string, any> = {};
	const sessionStore: Record<string, any> = {};

	return {
		sync: {
			get: vi.fn((keys: string | string[] | null) => {
				if (keys === null || keys === undefined) {
					return Promise.resolve(syncStore);
				}
				if (typeof keys === "string") {
					return Promise.resolve({ [keys]: syncStore[keys] });
				}
				const result: Record<string, any> = {};
				keys.forEach((key) => {
					if (key in syncStore) {
						result[key] = syncStore[key];
					}
				});
				return Promise.resolve(result);
			}),
			set: vi.fn((items: Record<string, any>) => {
				Object.assign(syncStore, items);
				return Promise.resolve();
			}),
			remove: vi.fn((keys: string | string[]) => {
				const keysArray = typeof keys === "string" ? [keys] : keys;
				keysArray.forEach((key) => delete syncStore[key]);
				return Promise.resolve();
			}),
			clear: vi.fn(() => {
				Object.keys(syncStore).forEach((key) => delete syncStore[key]);
				return Promise.resolve();
			}),
			_store: syncStore,
		},
		local: {
			get: vi.fn((keys: string | string[] | null) => {
				if (keys === null || keys === undefined) {
					return Promise.resolve(localStore);
				}
				if (typeof keys === "string") {
					return Promise.resolve({ [keys]: localStore[keys] });
				}
				const result: Record<string, any> = {};
				keys.forEach((key) => {
					if (key in localStore) {
						result[key] = localStore[key];
					}
				});
				return Promise.resolve(result);
			}),
			set: vi.fn((items: Record<string, any>) => {
				Object.assign(localStore, items);
				return Promise.resolve();
			}),
			remove: vi.fn((keys: string | string[]) => {
				const keysArray = typeof keys === "string" ? [keys] : keys;
				keysArray.forEach((key) => delete localStore[key]);
				return Promise.resolve();
			}),
			clear: vi.fn(() => {
				Object.keys(localStore).forEach((key) => delete localStore[key]);
				return Promise.resolve();
			}),
			_store: localStore,
		},
		session: {
			get: vi.fn((keys: string | string[] | null) => {
				if (keys === null || keys === undefined) {
					return Promise.resolve(sessionStore);
				}
				if (typeof keys === "string") {
					return Promise.resolve({ [keys]: sessionStore[keys] });
				}
				const result: Record<string, any> = {};
				keys.forEach((key) => {
					if (key in sessionStore) {
						result[key] = sessionStore[key];
					}
				});
				return Promise.resolve(result);
			}),
			set: vi.fn((items: Record<string, any>) => {
				Object.assign(sessionStore, items);
				return Promise.resolve();
			}),
			remove: vi.fn((keys: string | string[]) => {
				const keysArray = typeof keys === "string" ? [keys] : keys;
				keysArray.forEach((key) => delete sessionStore[key]);
				return Promise.resolve();
			}),
			clear: vi.fn(() => {
				Object.keys(sessionStore).forEach((key) => delete sessionStore[key]);
				return Promise.resolve();
			}),
			_store: sessionStore,
		},
	};
}

/**
 * Resets all Chrome API mocks
 */
export function resetChromeMocks() {
	vi.clearAllMocks();

	// Reset Chrome storage
	if (chrome?.storage?.sync) {
		(chrome.storage.sync as any)._store = {};
	}
	if (chrome?.storage?.local) {
		(chrome.storage.local as any)._store = {};
	}
	if (chrome?.storage?.session) {
		(chrome.storage.session as any)._store = {};
	}
}

/**
 * Gets the internal storage for test assertions
 */
export function getChromeStorage(type: "sync" | "local" | "session") {
	return (chrome.storage[type] as any)._store || {};
}

/* eslint-enable @typescript-eslint/no-explicit-any */
