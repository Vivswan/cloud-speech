import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDebounce } from "@/hooks/useDebounce";

describe("useDebounce", () => {
	it("should return initial value immediately", () => {
		const { result } = renderHook(() => useDebounce("initial", 500));
		expect(result.current).toBe("initial");
	});

	it("should debounce value changes", async () => {
		const { result, rerender } = renderHook(({ value, delay }) => useDebounce(value, delay), {
			initialProps: { value: "initial", delay: 100 },
		});

		expect(result.current).toBe("initial");

		// Update value
		rerender({ value: "updated", delay: 100 });

		// Should still show old value immediately
		expect(result.current).toBe("initial");

		// Wait for debounce
		await waitFor(
			() => {
				expect(result.current).toBe("updated");
			},
			{ timeout: 200 }
		);
	});

	it("should use default delay of 500ms when delay is 0", async () => {
		const { result, rerender } = renderHook(({ value, delay }) => useDebounce(value, delay), {
			initialProps: { value: "initial", delay: 0 },
		});

		rerender({ value: "updated", delay: 0 });

		// Should eventually update
		await waitFor(
			() => {
				expect(result.current).toBe("updated");
			},
			{ timeout: 600 }
		);
	});

	it("should cancel previous timeout on rapid changes", async () => {
		const { result, rerender } = renderHook(({ value, delay }) => useDebounce(value, delay), {
			initialProps: { value: "first", delay: 100 },
		});

		// Change value multiple times rapidly
		rerender({ value: "second", delay: 100 });
		rerender({ value: "third", delay: 100 });
		rerender({ value: "fourth", delay: 100 });

		// Should still show initial value
		expect(result.current).toBe("first");

		// Wait for final value
		await waitFor(
			() => {
				expect(result.current).toBe("fourth");
			},
			{ timeout: 200 }
		);
	});

	it("should work with different types", async () => {
		const { result, rerender } = renderHook(({ value }) => useDebounce(value, 100), {
			initialProps: { value: 123 },
		});

		expect(result.current).toBe(123);

		rerender({ value: 456 });

		await waitFor(
			() => {
				expect(result.current).toBe(456);
			},
			{ timeout: 200 }
		);
	});

	it("should handle objects", async () => {
		const { result, rerender } = renderHook(({ value }) => useDebounce(value, 100), {
			initialProps: { value: { foo: "bar" } },
		});

		expect(result.current).toEqual({ foo: "bar" });

		rerender({ value: { foo: "baz" } });

		await waitFor(
			() => {
				expect(result.current).toEqual({ foo: "baz" });
			},
			{ timeout: 200 }
		);
	});
});
