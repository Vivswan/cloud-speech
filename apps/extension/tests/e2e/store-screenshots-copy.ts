import type { ExtensionLocaleId } from "@cloud-speech/constants";

// The content around the extension's own labels in the store screenshots (docs/store-listing.md, "Screenshots"),
// per shipped language, so a set reads as one language throughout.

export interface Article {
  kicker: string;
  title: string;
  lede: string;
  /** The highlighted paragraph: what the context menu and scene 06 read. */
  selected: string;
  after: string;
  /** Continues the article far enough to fill the Sandbox's text box at the
   *  popup's height. */
  more: readonly string[];
}

/** The items Chrome puts in a text-selection menu, in Chrome's own words for that language, since headless Chromium
 *  cannot show its native menu. The strings are Linux Chrome's (generated_resources_<locale>.xtb: COPY, SEARCHWEBFOR,
 *  PRINT, INSPECTELEMENT), the CI render being the shipped one.
 *    "(C)" suffixes on the Chinese items  -> the mnemonics Linux Chrome shows
 *    quotes around the selection          -> the language's own; the typography gate exempts this file for them
 *    `$1` in `search`                     -> where the selection goes
 */
export interface BrowserMenu {
  copy: string;
  search: string;
  print: string;
  inspect: string;
}

export interface SampleCopy {
  article: Article;
  menu: BrowserMenu;
}

const en: SampleCopy = {
  article: {
    kicker: "Accessibility",
    title: "Reading the web with your ears",
    lede:
      "Long articles are easier to follow when the browser reads them aloud. " +
      "A text-to-speech extension turns any paragraph into speech with a voice you choose.",
    selected:
      "Highlight the text you want to hear, right-click it, and pick a reading speed. " +
      "The audio plays while you keep scrolling, and the same menu can save it as an audio file.",
    after:
      "Cloud voices from Amazon Polly, Azure, Google Cloud, and OpenAI sound natural in dozens of " +
      "languages, and the extension uses your own account for each one.",
    more: [
      "Pick a voice once in Preferences and star the ones you like; the picker keeps them one " +
        "click away, and each row plays a short preview before you commit. " +
        "Speed and pitch are yours to set, and a slower pace makes dense technical writing easier to follow.",
      "The Sandbox is the place to try a passage before reading a whole page. " +
        "Paste anything here, press play, and skip back or forward fifteen seconds at a time. " +
        "The download button saves the same reading as an audio file for later.",
      "Your keys stay in your browser. " +
        "The text you read goes straight from the browser to the provider you picked, and to nobody else.",
    ],
  },
  menu: {
    copy: "Copy",
    search: "Search Google for “$1”",
    print: "Print...",
    inspect: "Inspect",
  },
};

const hi: SampleCopy = {
  article: {
    kicker: "सुलभता",
    title: "वेब को कानों से पढ़ना",
    lede:
      "जब ब्राउज़र लंबे लेख पढ़कर सुनाता है तो उन्हें समझना आसान हो जाता है। " +
      "टेक्स्ट-टू-स्पीच एक्सटेंशन किसी भी पैराग्राफ़ को आपकी चुनी आवाज़ में बोली में बदल देता है।",
    selected:
      "जो टेक्स्ट सुनना हो उसे हाइलाइट करें, उस पर राइट-क्लिक करें और पढ़ने की गति चुनें। " +
      "आप स्क्रॉल करते रहते हैं और ऑडियो चलता रहता है, और यही मेन्यू उसे ऑडियो फ़ाइल के रूप में सहेज सकता है।",
    after:
      "Amazon Polly, Azure, Google Cloud और OpenAI की क्लाउड आवाज़ें दर्जनों भाषाओं में स्वाभाविक लगती हैं, " +
      "और एक्सटेंशन हर एक के लिए आपका अपना खाता इस्तेमाल करता है।",
    more: [
      "प्राथमिकताओं में एक बार आवाज़ चुनें और पसंद की आवाज़ों पर स्टार लगाएँ; पिकर उन्हें एक क्लिक की दूरी पर " +
        "रखता है, और हर पंक्ति चुनने से पहले एक छोटा नमूना सुनाती है। " +
        "गति और पिच आपके हाथ में हैं, और धीमी रफ़्तार से घना तकनीकी लेखन समझना आसान हो जाता है।",
      "सैंडबॉक्स वह जगह है जहाँ पूरा पेज पढ़वाने से पहले कोई अंश आज़माया जा सकता है। " +
        "यहाँ कुछ भी पेस्ट करें, प्ले दबाएँ और एक बार में पंद्रह सेकंड पीछे या आगे जाएँ। " +
        "डाउनलोड बटन उसी पठन को बाद के लिए ऑडियो फ़ाइल के रूप में सहेजता है।",
      "आपकी कुंजियाँ आपके ब्राउज़र में ही रहती हैं। " +
        "आप जो टेक्स्ट पढ़वाते हैं वह ब्राउज़र से सीधे आपके चुने प्रदाता तक जाता है, और किसी और तक नहीं।",
    ],
  },
  menu: {
    copy: "प्रतिलिपि बनाएं",
    search: "“$1” को खोजने के लिए Google पर खोजें",
    print: "प्रिंट करें...",
    inspect: "निरीक्षण करें",
  },
};

const zhCN: SampleCopy = {
  article: {
    kicker: "无障碍",
    title: "用耳朵阅读网页",
    lede:
      "让浏览器朗读长文章, 读起来会轻松得多。" +
      "文字转语音扩展能用你选定的声音, 把任意一段文字变成语音。",
    selected:
      "选中想听的文字, 右键点击它, 再选一个朗读速度。" +
      "你继续滚动页面时音频照常播放, 同一个菜单还能把它保存为音频文件。",
    after:
      "来自 Amazon Polly、Azure、Google Cloud 和 OpenAI 的云端语音在数十种语言中都很自然, " +
      "扩展为每一家使用你自己的账户。",
    more: [
      "在偏好设置里选好一个声音, 给喜欢的声音加星; 选择器让它们始终一键可达, " +
        "每一行在你确定之前都能先播放一小段试听。" +
        "速度和音调由你决定, 放慢节奏能让密集的技术文字更容易跟上。",
      "沙盒是朗读整页之前试读一段的地方。" +
        "在这里粘贴任何内容, 按下播放, 可以一次前后跳十五秒。" +
        "下载按钮把同一段朗读保存为音频文件, 留待以后。",
      "你的密钥只留在浏览器里。你朗读的文字从浏览器直接发往你选定的服务商, 不经过任何其他人。",
      "长长的阅读清单、慢慢积累的文档, 或者一篇你想边做别的事边听完的评论: " +
        "把它们交给朗读, 眼睛就能休息一会儿。",
    ],
  },
  menu: {
    copy: "复制(C)",
    search: "使用Google搜索“$1”(S)",
    print: "打印(P)...",
    inspect: "检查(N)",
  },
};

const zhTW: SampleCopy = {
  article: {
    kicker: "無障礙",
    title: "用耳朵閱讀網頁",
    lede:
      "讓瀏覽器朗讀長文章, 讀起來會輕鬆得多。" +
      "文字轉語音擴充功能能用你選定的聲音, 把任意一段文字變成語音。",
    selected:
      "選取想聽的文字, 在上面按右鍵, 再選一個朗讀速度。" +
      "你繼續捲動頁面時音訊照常播放, 同一個選單還能把它儲存為音訊檔。",
    after:
      "來自 Amazon Polly、Azure、Google Cloud 和 OpenAI 的雲端語音在數十種語言中都很自然, " +
      "擴充功能為每一家使用你自己的帳戶。",
    more: [
      "在偏好設定裡選好一個聲音, 為喜歡的聲音加星; 選擇器讓它們始終一鍵可達, " +
        "每一列在你確定之前都能先播放一小段試聽。" +
        "速度和音調由你決定, 放慢節奏能讓密集的技術文字更容易跟上。",
      "沙盒是朗讀整頁之前試讀一段的地方。" +
        "在這裡貼上任何內容, 按下播放, 可以一次前後跳十五秒。" +
        "下載按鈕把同一段朗讀儲存為音訊檔, 留待以後。",
      "你的金鑰只留在瀏覽器裡。你朗讀的文字從瀏覽器直接送往你選定的服務商, 不經過任何其他人。",
      "長長的閱讀清單、慢慢累積的文件, 或者一篇你想邊做別的事邊聽完的評論: " +
        "把它們交給朗讀, 眼睛就能休息一會兒。",
    ],
  },
  menu: {
    copy: "複製(C)",
    search: "透過 Google 搜尋「$1」(S)",
    print: "列印(P)...",
    inspect: "檢查(N)",
  },
};

// A Map because the extension's locale ids (zh_CN) are not identifier-cased
// property names.
const SAMPLE_COPY = new Map<ExtensionLocaleId, SampleCopy>([
  ["en", en],
  ["hi", hi],
  ["zh_CN", zhCN],
  ["zh_TW", zhTW],
]);

/** The sample copy in the language of an extension locale; a locale without
 *  one is an error, so a set never renders another language's text. */
export function sampleCopy(locale: ExtensionLocaleId): SampleCopy {
  const found = SAMPLE_COPY.get(locale);
  if (!found) throw new Error(`no sample copy for the ${locale} locale`);
  return found;
}

/** The Sandbox scenes' text: the article, continued far enough to fill the
 *  text box at the popup's height. */
export function sandboxText({ article }: SampleCopy): string {
  return [article.title, article.lede, article.selected, article.after, ...article.more].join(
    "\n\n",
  );
}
