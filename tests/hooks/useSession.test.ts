import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSession } from "@/hooks/useSession";

describe("useSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Setup default chrome.storage.session mock behavior
		vi.mocked(chrome.storage.session.get).mockImplementation((keys, callback) => {
			const data = {};
			if (callback) {
				callback(data);
			}
			return Promise.resolve(data);
		});
		vi.mocked(chrome.storage.session.set).mockResolvedValue(undefined);
	});

	it("should initialize with empty session", async () => {
		const { result } = renderHook(() => useSession());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		expect(result.current.session).toBeDefined();
	});

	it("should load session data on mount", async () => {
		const mockData = { voices: [{ value: "Joanna", label: "Joanna" }] };

		vi.mocked(chrome.storage.session.get).mockImplementation((keys, callback) => {
			if (callback) {
				callback(mockData);
			}
			return Promise.resolve(mockData);
		});

		const { result } = renderHook(() => useSession());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		expect(result.current.session).toEqual(mockData);
	});

	it("should set session data", async () => {
		const { result } = renderHook(() => useSession());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		const newData = { languages: [{ value: "en-US", label: "English" }] };
		await result.current.setSession(newData);

		expect(chrome.storage.session.set).toHaveBeenCalledWith(newData);
	});

	it("should call chrome.storage.session.get on mount", () => {
		renderHook(() => useSession());
		expect(chrome.storage.session.get).toHaveBeenCalled();
	});

	it("should add listener for session changes", () => {
		renderHook(() => useSession());
		expect(chrome.storage.session.onChanged.addListener).toHaveBeenCalled();
	});

	it("should remove listener on unmount", () => {
		const { unmount } = renderHook(() => useSession());
		unmount();
		expect(chrome.storage.session.onChanged.removeListener).toHaveBeenCalled();
	});

	it("should update session when storage changes", async () => {
		let changeListener: (() => void) | null = null;

		vi.mocked(chrome.storage.session.onChanged.addListener).mockImplementation(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(listener: any) => {
				changeListener = listener;
			}
		);

		const { result } = renderHook(() => useSession());

		await waitFor(() => {
			expect(result.current.ready).toBe(true);
		});

		// Simulate storage change
		const newData = { voices: [{ value: "Matthew", label: "Matthew" }] };
		vi.mocked(chrome.storage.session.get).mockResolvedValue(newData);

		if (changeListener) {
			changeListener();
		}

		await waitFor(() => {
			expect(result.current.session).toEqual(newData);
		});
	});
});
