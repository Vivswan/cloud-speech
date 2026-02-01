import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorage } from "@/hooks/useLocalStorage";

describe("useLocalStorage", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("should return default value when localStorage is empty", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", "default"));
		expect(result.current[0]).toBe("default");
	});

	it("should return stored value from localStorage", () => {
		localStorage.setItem("test-key", JSON.stringify("stored"));
		const { result } = renderHook(() => useLocalStorage("test-key", "default"));
		expect(result.current[0]).toBe("stored");
	});

	it("should update localStorage when value changes", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", "initial"));

		act(() => {
			result.current[1]("updated");
		});

		expect(result.current[0]).toBe("updated");
		expect(localStorage.getItem("test-key")).toBe(JSON.stringify("updated"));
	});

	it("should work with objects", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", { foo: "bar" }));

		expect(result.current[0]).toEqual({ foo: "bar" });

		act(() => {
			result.current[1]({ foo: "baz" });
		});

		expect(result.current[0]).toEqual({ foo: "baz" });
		expect(JSON.parse(localStorage.getItem("test-key")!)).toEqual({
			foo: "baz",
		});
	});

	it("should work with arrays", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", [1, 2, 3]));

		expect(result.current[0]).toEqual([1, 2, 3]);

		act(() => {
			result.current[1]([4, 5, 6]);
		});

		expect(result.current[0]).toEqual([4, 5, 6]);
		expect(JSON.parse(localStorage.getItem("test-key")!)).toEqual([4, 5, 6]);
	});

	it("should work with numbers", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", 42));

		expect(result.current[0]).toBe(42);

		act(() => {
			result.current[1](100);
		});

		expect(result.current[0]).toBe(100);
		expect(JSON.parse(localStorage.getItem("test-key")!)).toBe(100);
	});

	it("should work with booleans", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", true));

		expect(result.current[0]).toBe(true);

		act(() => {
			result.current[1](false);
		});

		expect(result.current[0]).toBe(false);
		expect(JSON.parse(localStorage.getItem("test-key")!)).toBe(false);
	});

	it("should use functional updates", () => {
		const { result } = renderHook(() => useLocalStorage("test-key", 0));

		act(() => {
			result.current[1]((prev) => prev + 1);
		});

		expect(result.current[0]).toBe(1);

		act(() => {
			result.current[1]((prev) => prev + 1);
		});

		expect(result.current[0]).toBe(2);
	});
});
