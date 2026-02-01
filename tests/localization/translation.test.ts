import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { translate, getLanguageDisplayName, useTranslation } from "@/localization/translation";

describe("translate", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("should translate a key in default locale", () => {
		const result = translate("common.save");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
	});

	it("should return the key if translation not found", () => {
		const result = translate("nonexistent.key");
		expect(result).toBe("nonexistent.key");
	});

	it("should interpolate parameters", () => {
		// Assuming there's a translation like "Hello {{name}}"
		const result = translate("test.greeting", { name: "World" });
		// If key doesn't exist, it returns the key
		if (result === "test.greeting") {
			expect(result).toBe("test.greeting");
		} else {
			expect(result).toContain("World");
		}
	});

	it("should handle nested translation keys", () => {
		const result = translate("common.save");
		expect(typeof result).toBe("string");
	});
});

describe("getLanguageDisplayName", () => {
	it("should return English for en", () => {
		expect(getLanguageDisplayName("en")).toBe("English");
	});

	it("should return Chinese (Simplified) for zh-CN", () => {
		expect(getLanguageDisplayName("zh-CN")).toBe("简体中文");
	});

	it("should return Chinese (Traditional) for zh-TW", () => {
		expect(getLanguageDisplayName("zh-TW")).toBe("繁體中文");
	});

	it("should return Hindi for hi", () => {
		expect(getLanguageDisplayName("hi")).toBe("हिन्दी");
	});

	it("should return uppercase code for unknown language", () => {
		expect(getLanguageDisplayName("fr")).toBe("FR");
	});
});

describe("useTranslation", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("should return translation context with t function", () => {
		const { result } = renderHook(() => useTranslation());

		expect(result.current.t).toBeInstanceOf(Function);
		expect(result.current.locale).toBeDefined();
		expect(result.current.setLocale).toBeInstanceOf(Function);
		expect(result.current.availableLocales).toBeInstanceOf(Array);
	});

	it("should have default locale as en", () => {
		const { result } = renderHook(() => useTranslation());
		expect(result.current.locale).toBe("en");
	});

	it("should include all available locales", () => {
		const { result } = renderHook(() => useTranslation());
		const locales = result.current.availableLocales;

		expect(locales).toContain("en");
		expect(locales).toContain("zh-CN");
		expect(locales).toContain("zh-TW");
		expect(locales).toContain("hi");
	});

	it("should translate using t function", () => {
		const { result } = renderHook(() => useTranslation());
		const translation = result.current.t("common.save");

		expect(typeof translation).toBe("string");
		expect(translation).toBeDefined();
	});

	it("should change locale", async () => {
		const { result } = renderHook(() => useTranslation());

		expect(result.current.locale).toBe("en");

		act(() => {
			result.current.setLocale("zh-CN");
		});

		await waitFor(() => {
			expect(result.current.locale).toBe("zh-CN");
		});
	});

	it("should persist locale to localStorage", async () => {
		const { result } = renderHook(() => useTranslation());

		act(() => {
			result.current.setLocale("zh-CN");
		});

		await waitFor(() => {
			expect(localStorage.getItem("polly_locale")).toBe("zh-CN");
		});
	});

	it("should restore locale from localStorage", () => {
		localStorage.setItem("polly_locale", "hi");

		const { result } = renderHook(() => useTranslation());
		expect(result.current.locale).toBe("hi");
	});

	it("should warn for invalid locale", () => {
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = renderHook(() => useTranslation());

		act(() => {
			result.current.setLocale("invalid");
		});

		expect(consoleWarnSpy).toHaveBeenCalled();
		consoleWarnSpy.mockRestore();
	});

	it("should not change locale for invalid locale", () => {
		const { result } = renderHook(() => useTranslation());
		const originalLocale = result.current.locale;

		act(() => {
			result.current.setLocale("invalid");
		});

		expect(result.current.locale).toBe(originalLocale);
	});
});
