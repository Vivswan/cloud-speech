import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSync } from "@/hooks/useSync";

describe("useSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Setup default chrome.storage.sync mock behavior
		vi.mocked(chrome.storage.sync.get).mockImplementation((keys, callback) => {
			const data = {};
			if (callback) {
				callback(data);
			}
			return Promise.resolve(data);
		});
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
		const mockData = {
			language: "en-US",
			voice: "Joanna",
			speed: 1.0,
		};

		vi.mocked(chrome.storage.sync.get).mockImplementation((keys, callback) => {
			if (callback) {
				callback(mockData);
			}
			return Promise.resolve(mockData);
		});

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

		const newData = { language: "zh-CN", voice: "Zhiyu" };
		await result.current.setSync(newData);

		expect(chrome.storage.sync.set).toHaveBeenCalledWith(newData);
	});

	it("should call chrome.storage.sync.get on mount", () => {
		renderHook(() => useSync());
		expect(chrome.storage.sync.get).toHaveBeenCalled();
	});

	it("should add listener for sync changes", () => {
		renderHook(() => useSync());
		expect(chrome.storage.sync.onChanged.addListener).toHaveBeenCalled();
	});

	it("should remove listener on unmount", () => {
		const { unmount } = renderHook(() => useSync());
		unmount();
		expect(chrome.storage.sync.onChanged.removeListener).toHaveBeenCalled();
	});

	it("should update sync when storage changes", async () => {
		let changeListener: (() => void) | null = null;

		vi.mocked(chrome.storage.sync.onChanged.addListener).mockImplementation(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(listener: any) => {
				changeListener = listener;
			}
		);

		const { result } = renderHook(() => useSync());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		// Simulate storage change
		const newData = { language: "es-ES", voice: "Lucia" };
		vi.mocked(chrome.storage.sync.get).mockResolvedValue(newData);

		if (changeListener) {
			changeListener();
		}

		await waitFor(() => {
			expect(result.current.sync).toEqual(newData);
		});
	});
});
