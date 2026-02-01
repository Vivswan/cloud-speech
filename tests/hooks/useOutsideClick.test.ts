import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOutsideClick } from "@/hooks/useOutsideClick";

describe("useOutsideClick", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("should return a ref", () => {
		const callback = vi.fn();
		const { result } = renderHook(() => useOutsideClick(callback));

		expect(result.current).toHaveProperty("current");
	});

	it("should call callback when clicking outside", () => {
		const callback = vi.fn();
		const { result } = renderHook(() => useOutsideClick(callback));

		// Create and attach an element to the ref
		const element = document.createElement("div");
		document.body.appendChild(element);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(result.current as any).current = element;

		// Click outside
		const outsideElement = document.createElement("div");
		document.body.appendChild(outsideElement);

		const event = new window.MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});

		Object.defineProperty(event, "composedPath", {
			value: () => [outsideElement, document.body, document],
		});

		outsideElement.dispatchEvent(event);

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("should not call callback when clicking inside", () => {
		const callback = vi.fn();
		const { result } = renderHook(() => useOutsideClick(callback));

		// Create and attach an element to the ref
		const element = document.createElement("div");
		document.body.appendChild(element);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(result.current as any).current = element;

		// Click inside
		const event = new window.MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});

		Object.defineProperty(event, "composedPath", {
			value: () => [element, document.body, document],
		});

		element.dispatchEvent(event);

		expect(callback).not.toHaveBeenCalled();
	});

	it("should remove event listener on unmount", () => {
		const callback = vi.fn();
		const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

		const { unmount } = renderHook(() => useOutsideClick(callback));

		unmount();

		expect(removeEventListenerSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));

		removeEventListenerSpy.mockRestore();
	});

	it("should not call callback if ref is not attached", () => {
		const callback = vi.fn();
		renderHook(() => useOutsideClick(callback));

		// Click anywhere without attaching the ref
		const event = new window.MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});

		document.body.dispatchEvent(event);

		expect(callback).not.toHaveBeenCalled();
	});
});
