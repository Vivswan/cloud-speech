import {
  type ExtensionLocaleId,
  LOCALE_TAG_RULES,
  matchSiteLocale,
  SITE_LOCALES,
} from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";

// The shared locale table feeds five production sites (storage's uiLanguage
// enum, guide URLs, the Settings language picker, the website's locale
// roster, astro.config's i18n list). These are the table's own tests: a
// literal golden pin so a wrong edit to the table itself fails here, and the
// browser-tag mapping shared with the website's first-visit detect script.

// Compile-time pin: the union must stay the four shipped ids, so dropping
// `as const` from SITE_LOCALES (widening extensionId to string) fails
// typecheck right here.
// @ts-expect-error not a shipped locale
const notShipped: ExtensionLocaleId = "fr";
void notShipped;

describe("SITE_LOCALES", () => {
  it("golden pin: the complete table as literals", () => {
    expect(SITE_LOCALES).toEqual([
      {
        extensionId: "en",
        code: "en",
        prefix: "",
        htmlLang: "en",
        hreflang: "en",
        label: "English",
      },
      {
        extensionId: "hi",
        code: "hi",
        prefix: "hi/",
        htmlLang: "hi",
        hreflang: "hi",
        label: "हिन्दी",
      },
      {
        extensionId: "zh_CN",
        code: "zh-cn",
        prefix: "zh-cn/",
        htmlLang: "zh-Hans-CN",
        hreflang: "zh-Hans",
        label: "简体中文",
      },
      {
        extensionId: "zh_TW",
        code: "zh-tw",
        prefix: "zh-tw/",
        htmlLang: "zh-Hant-TW",
        hreflang: "zh-Hant",
        label: "繁體中文",
      },
    ]);
  });

  it("English is the default: first entry, unprefixed", () => {
    expect(SITE_LOCALES[0].code).toBe("en");
    expect(SITE_LOCALES[0].prefix).toBe("");
    expect(SITE_LOCALES.filter((l) => l.prefix === "")).toHaveLength(1);
  });

  it("prefixes are the site code plus a slash", () => {
    for (const locale of SITE_LOCALES) {
      if (locale.prefix) expect(locale.prefix).toBe(`${locale.code}/`);
    }
  });
});

describe("matchSiteLocale", () => {
  it("maps browser tags onto site locale codes", () => {
    expect(matchSiteLocale("en")).toBe("en");
    expect(matchSiteLocale("en-GB")).toBe("en");
    expect(matchSiteLocale("hi")).toBe("hi");
    expect(matchSiteLocale("hi-IN")).toBe("hi");
    // Bare zh means Simplified by Chrome's locale convention.
    expect(matchSiteLocale("zh")).toBe("zh-cn");
    expect(matchSiteLocale("zh-CN")).toBe("zh-cn");
    expect(matchSiteLocale("zh-Hans-SG")).toBe("zh-cn");
    expect(matchSiteLocale("zh-TW")).toBe("zh-tw");
    expect(matchSiteLocale("zh-Hant-HK")).toBe("zh-tw");
    expect(matchSiteLocale("zh-MO")).toBe("zh-tw");
  });

  it("returns null for languages the site does not ship", () => {
    expect(matchSiteLocale("ja")).toBeNull();
    expect(matchSiteLocale("fr")).toBeNull();
    expect(matchSiteLocale("pa-IN")).toBeNull();
    expect(matchSiteLocale("")).toBeNull();
  });

  it("is case-insensitive, like BCP-47 tags", () => {
    expect(matchSiteLocale("ZH-HANT-TW")).toBe("zh-tw");
    expect(matchSiteLocale("EN-US")).toBe("en");
  });

  it("every rule targets a locale from SITE_LOCALES", () => {
    const codes = SITE_LOCALES.map((l) => l.code);
    for (const rule of LOCALE_TAG_RULES) {
      expect(codes).toContain(rule.locale);
    }
  });

  it("rules survive the define:vars hand-off (plain serializable data)", () => {
    // Base.astro's inline first-visit script receives LOCALE_TAG_RULES via
    // define:vars, which JSON-serializes: rules must be plain objects with
    // regex SOURCE strings (a RegExp object would serialize to {}).
    for (const rule of LOCALE_TAG_RULES) {
      expect(Object.keys(rule).sort()).toEqual(["locale", "pattern"]);
      expect(typeof rule.pattern).toBe("string");
      expect(typeof rule.locale).toBe("string");
      expect(() => new RegExp(rule.pattern)).not.toThrow();
    }
    expect(JSON.parse(JSON.stringify(LOCALE_TAG_RULES))).toEqual(LOCALE_TAG_RULES);
  });
});
