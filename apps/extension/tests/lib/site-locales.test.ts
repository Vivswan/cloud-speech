import { LOCALE_TAG_RULES, matchSiteLocale, SITE_LOCALES } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";

// The shared locale table feeds storage's uiLanguage enum, guide URLs, the Settings language picker, the website's
// locale roster and astro.config's i18n list. The table is its own source; what is pinned here are the relations
// between its columns and the browser tags that reach them.

describe("SITE_LOCALES", () => {
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

  it("store locales are the site codes in the Chrome Web Store's casing", () => {
    for (const locale of SITE_LOCALES) {
      const [language, region] = locale.code.split("-");
      expect(locale.storeLocale).toBe(region ? `${language}-${region.toUpperCase()}` : language);
    }
  });

  it("a browser whose UI language is a store locale resolves to that locale", () => {
    // The store screenshots renderer gives Chromium the store locale as its
    // UI language; the popup then follows the browser through these rules.
    for (const locale of SITE_LOCALES) {
      expect(matchSiteLocale(locale.storeLocale)).toBe(locale.code);
    }
  });
});

describe("matchSiteLocale", () => {
  // Browser tags onto site locale codes, null for a language the site does not ship. Bare zh means
  // Simplified by Chrome's locale convention; matching is case-insensitive, like BCP-47 tags.
  it.each([
    ["en", "en"],
    ["en-GB", "en"],
    ["EN-US", "en"],
    ["hi", "hi"],
    ["hi-IN", "hi"],
    ["zh", "zh-cn"],
    ["zh-CN", "zh-cn"],
    ["zh-Hans-SG", "zh-cn"],
    ["zh-TW", "zh-tw"],
    ["zh-Hant-HK", "zh-tw"],
    ["zh-MO", "zh-tw"],
    ["ZH-HANT-TW", "zh-tw"],
    ["ja", null],
    ["fr", null],
    ["pa-IN", null],
    ["", null],
  ])("maps browser tag %j to %j", (tag, locale) => {
    expect(matchSiteLocale(tag)).toBe(locale);
  });

  it("every rule targets a locale from SITE_LOCALES", () => {
    const codes = SITE_LOCALES.map((l) => l.code);
    for (const rule of LOCALE_TAG_RULES) {
      expect(codes).toContain(rule.locale);
    }
  });

  it("rules survive the inline-script hand-off (plain serializable data)", () => {
    // Base.astro's inline first-visit script receives LOCALE_TAG_RULES through apps/web/src/inline/locale.ts's
    // scriptLiteral, which JSON-serializes: rules must be plain objects with regex SOURCE strings (a RegExp
    // object would serialize to {}).
    for (const rule of LOCALE_TAG_RULES) {
      expect(Object.keys(rule).sort()).toEqual(["locale", "pattern"]);
      expect(() => new RegExp(rule.pattern)).not.toThrow();
    }
    expect(JSON.parse(JSON.stringify(LOCALE_TAG_RULES))).toEqual(LOCALE_TAG_RULES);
  });
});
