import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMount } from "@/hooks/useMount";

describe("useMount", () => {
	it("should call effect on mount", () => {
		const effect = vi.fn();
		renderHook(() => useMount(effect));

		expect(effect).toHaveBeenCalledTimes(1);
	});

	it("should call cleanup on unmount", () => {
		const cleanup = vi.fn();
		const effect = vi.fn(() => cleanup);

		const { unmount } = renderHook(() => useMount(effect));

		expect(effect).toHaveBeenCalledTimes(1);
		expect(cleanup).not.toHaveBeenCalled();

		unmount();

		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("should not call effect on re-render", () => {
		const effect = vi.fn();
		const { rerender } = renderHook(() => useMount(effect));

		expect(effect).toHaveBeenCalledTimes(1);

		rerender();
		expect(effect).toHaveBeenCalledTimes(1);

		rerender();
		expect(effect).toHaveBeenCalledTimes(1);
	});

	it("should work without cleanup function", () => {
		const effect = vi.fn();
		const { unmount } = renderHook(() => useMount(effect));

		expect(effect).toHaveBeenCalledTimes(1);
		expect(() => unmount()).not.toThrow();
	});
});
