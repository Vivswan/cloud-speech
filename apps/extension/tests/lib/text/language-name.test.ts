import { describe, expect, it, vi } from "vitest";
import { languageBaseName, languageDisplayName } from "@/lib/text/language-name";

vi.mock("@/lib/text/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

describe("languageDisplayName", () => {
  // What would drift silently: the Preferences select and the picker rows read the same tag, so a
  // name that ignores the UI locale makes one of them disagree with the other in a zh_CN popup.
  it.each([
    ["en-US", "en", "American English"],
    ["en-US", "zh_CN", "美国英语"],
    ["en-US", "hi", "अमेरिकी अंग्रेज़ी"],
  ] as const)("%s under uiLanguage %s is %s", (code, locale, name) => {
    expect(languageDisplayName(code, locale)).toBe(name);
  });

  it("names a dialect-tailed tag by its first two subtags, since ICU prints the tail raw", () => {
    expect(languageDisplayName("zh-CN-shaanxi", "en")).toBe("Chinese (China)");
  });

  it("falls back to the tag itself when Intl rejects it, so a render never throws", () => {
    expect(languageDisplayName("not a tag", "en")).toBe("not a tag");
  });
});

describe("languageBaseName", () => {
  // ICU wraps the region in full-width parentheses under zh locales and ASCII ones under en, so the
  // language alone has to be asked of ICU, never cut out of the full name at " (".
  it.each([
    ["en-IN", "en", "English"],
    ["en-IN", "zh_CN", "英语"],
    ["en-IN", "zh_TW", "英文"],
    ["en-IN", "hi", "अंग्रेज़ी"],
  ] as const)("%s under uiLanguage %s is %s", (code, locale, name) => {
    expect(languageBaseName(code, locale)).toBe(name);
  });

  it("falls back to the tag itself when Intl rejects it, so a render never throws", () => {
    expect(languageBaseName("not a tag", "en")).toBe("not a tag");
  });
});
