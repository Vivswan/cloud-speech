import { describe, expect, it, vi } from "vitest";
import { languageDisplayName } from "@/lib/language-name";

vi.mock("@/lib/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

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
