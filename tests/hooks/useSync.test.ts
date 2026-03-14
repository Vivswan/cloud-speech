import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSync } from "@/hooks/useSync";
import type { SyncStorage } from "@/types";

describe("useSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Setup default chrome.storage.sync mock behavior
		vi.mocked(chrome.storage.sync.get).mockImplementation(
			(keys?: unknown, callback?: (data: Partial<SyncStorage>) => void) => {
				const data = {};
				if (callback) {
					callback(data);
				}
				return Promise.resolve(data);
			}
		);
		vi.mocked(chrome.storage.sync.set).mockResolvedValue(undefined);
	});

	it("should initialize with empty sync", async () => {
		const { result } = renderHook(() => useSync());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		expect(result.current.sync).toBeDefined();
	});

	it("should load sync data on mount", async () => {
		const mockData: Partial<SyncStorage> = {
			language: "en-US",
			voices: { "en-US": "Joanna" },
			speed: 1.0,
		};

		vi.mocked(chrome.storage.sync.get).mockImplementation(
			(keys?: unknown, callback?: (data: Partial<SyncStorage>) => void) => {
				if (callback) {
					callback(mockData);
				}
				return Promise.resolve(mockData);
			}
		);

		const { result } = renderHook(() => useSync());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		expect(result.current.sync).toEqual(mockData);
	});

	it("should set sync data", async () => {
		const { result } = renderHook(() => useSync());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		const newData: Partial<SyncStorage> = { language: "zh-CN", voices: { "zh-CN": "Zhiyu" } };
		await result.current.setSync(newData);

		expect(chrome.storage.sync.set).toHaveBeenCalledWith(newData);
	});

	it("should call chrome.storage.sync.get on mount", async () => {
		const { result } = renderHook(() => useSync());
		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});
		expect(chrome.storage.sync.get).toHaveBeenCalled();
	});

	it("should add listener for sync changes", async () => {
		const { result } = renderHook(() => useSync());
		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});
		expect(chrome.storage.sync.onChanged.addListener).toHaveBeenCalled();
	});

	it("should remove listener on unmount", () => {
		const { unmount } = renderHook(() => useSync());
		unmount();
		expect(chrome.storage.sync.onChanged.removeListener).toHaveBeenCalled();
	});

	it("should update sync when storage changes", async () => {
		let changeListener: (() => void) | null = null;

		vi.mocked(chrome.storage.sync.onChanged.addListener).mockImplementation((listener: () => void) => {
			changeListener = listener;
		});

		const { result } = renderHook(() => useSync());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		// Simulate storage change
		const newData: Partial<SyncStorage> = { language: "es-ES", voices: { "es-ES": "Lucia" } };
		vi.mocked(chrome.storage.sync.get).mockImplementation(
			(keys?: unknown, callback?: (data: Partial<SyncStorage>) => void) => {
				if (callback) {
					callback(newData);
				}
				return Promise.resolve(newData);
			}
		);

		if (changeListener) {
			await act(async () => {
				changeListener?.();
			});
		}

		await waitFor(() => {
			expect(result.current.sync).toEqual(newData);
		});
	});
});
