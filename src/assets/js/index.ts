// Multilingual homepage functionality with internationalization
console.log("Polly for Chrome multilingual homepage loaded");

// Translation data
interface Translations {
	[key: string]: {
		[key: string]: string | { [key: string]: string | { [key: string]: string } };
	};
}

const translations: Translations = {
	en: {
		title: "Polly for Chrome - Premium Text-to-Speech Extension",
		description:
			"Convert any text on the web into high-quality, natural-sounding audio with Amazon Polly's advanced AI voices. 40+ languages, hundreds of voices.",
		nav: {
			features: "Features",
			screenshots: "Screenshots",
			install: "Install",
		},
		hero: {
			title: "Transform Text into Natural Speech",
			description:
				"Convert any text on the web into high-quality, natural-sounding audio with Amazon Polly's advanced AI voices. Choose from 40+ languages and hundreds of professional voices.",
			cta: {
				primary: "Add to Chrome - Free",
				secondary: "Learn More",
			},
		},
		features: {
			title: "Powerful Features",
			subtitle: "Everything you need for professional text-to-speech",
			voices: {
				title: "40+ Languages & Hundreds of Voices",
				description:
					"Choose from Standard, Neural, Generative, and Long-form voice engines with natural-sounding AI voices",
			},
			speed: {
				title: "Multiple Speed Options",
				description: "Context menu with 1x, 1.5x, and 2x playback speeds for optimal listening experience",
			},
			processing: {
				title: "Smart Text Processing",
				description:
					"Automatically sanitizes HTML content and handles special characters safely using advanced algorithms",
			},
			shortcuts: {
				title: "Keyboard Shortcuts",
				description: "Quick access with Ctrl+Shift+S for read aloud and Ctrl+Shift+E for downloads",
			},
			download: {
				title: "Audio Downloads",
				description: "Save as high-quality MP3 files for offline use and sharing",
			},
			ssml: {
				title: "SSML Support",
				description:
					"Advanced markup language for precise speech control including pauses, emphasis, and pronunciation",
			},
		},
		howto: {
			title: "How It Works",
			subtitle: "Get started in just a few simple steps",
			step1: {
				title: "Install Extension",
				description: "Add Polly for Chrome to your browser from the Chrome Web Store",
			},
			step2: {
				title: "Set Up AWS",
				description: "Configure your AWS credentials for Amazon Polly access (free tier available)",
			},
			step3: {
				title: "Start Listening",
				description: "Highlight any text on any website and right-click to hear it spoken aloud",
			},
		},
		cta: {
			title: "Ready to Transform Your Reading Experience?",
			subtitle: "Join thousands of users who are already enjoying natural speech synthesis",
			install: "Install Chrome Extension",
			github: "View on GitHub",
		},
		footer: {
			description: "Transform any text into natural-sounding speech with Amazon Polly's advanced AI voices.",
			links: {
				title: "Links",
				webstore: "Chrome Web Store",
				github: "GitHub Repository",
				issues: "Report Issues",
			},
			support: {
				title: "Support",
				help: "Help Guide",
				changelog: "Changelog",
				privacy: "Privacy Policy",
				docs: "AWS Documentation",
			},
		},
	},
	"zh-CN": {
		title: "Polly for Chrome - 高级文字转语音扩展",
		description:
			"使用 Amazon Polly 的先进 AI 语音技术，将网页上的任何文字转换为高质量、自然的音频。支持 40 多种语言和数百种语音。",
		nav: {
			features: "功能特色",
			screenshots: "屏幕截图",
			install: "安装",
		},
		hero: {
			title: "将文字转换为自然语音",
			description:
				"使用 Amazon Polly 的先进 AI 语音技术，将网页上的任何文字转换为高质量、自然的音频。可从 40 多种语言和数百种专业语音中选择。",
			cta: {
				primary: "免费添加到 Chrome",
				secondary: "了解更多",
			},
		},
		features: {
			title: "强大功能",
			subtitle: "专业文字转语音所需的一切功能",
			voices: {
				title: "40 多种语言与数百种语音",
				description: "可选择标准、神经、生成式和长篇语音引擎，拥有自然的 AI 语音",
			},
			speed: {
				title: "多种播放速度选项",
				description: "右键菜单提供 1x、1.5x 和 2x 播放速度，提供最佳聆听体验",
			},
			processing: {
				title: "智能文字处理",
				description: "自动清理 HTML 内容并使用先进算法安全处理特殊字符",
			},
			shortcuts: {
				title: "键盘快捷键",
				description: "使用 Ctrl+Shift+S 朗读和 Ctrl+Shift+E 下载的快速访问",
			},
			download: {
				title: "音频下载",
				description: "保存为高质量 MP3 文件，供离线使用和分享",
			},
			ssml: {
				title: "SSML 支持",
				description: "高级标记语言可精确控制语音，包括暂停、重音和发音",
			},
		},
		howto: {
			title: "使用方法",
			subtitle: "只需几个简单步骤即可开始使用",
			step1: {
				title: "安装扩展",
				description: "从 Chrome 网上应用店将 Polly for Chrome 添加到您的浏览器",
			},
			step2: {
				title: "设置 AWS",
				description: "配置您的 AWS 凭证以访问 Amazon Polly（有免费套餐可用）",
			},
			step3: {
				title: "开始聆听",
				description: "在任何网站上选择任何文字，然后右键点击即可听到朗读",
			},
		},
		cta: {
			title: "准备好改变您的阅读体验了吗？",
			subtitle: "与数千名已经享受自然语音合成的用户一起",
			install: "安装 Chrome 扩展",
			github: "在 GitHub 上查看",
		},
		footer: {
			description: "使用 Amazon Polly 的先进 AI 语音技术，将任何文字转换为自然语音。",
			links: {
				title: "链接",
				webstore: "Chrome 网上应用店",
				github: "GitHub 仓库",
				issues: "报告问题",
			},
			support: {
				title: "支持",
				help: "帮助指南",
				changelog: "更新日志",
				privacy: "隐私政策",
				docs: "AWS 文档",
			},
		},
	},
	"zh-TW": {
		title: "Polly for Chrome - 高級文字轉語音擴充功能",
		description:
			"使用 Amazon Polly 的先進 AI 語音技術，將網頁上的任何文字轉換為高品質、自然的音訊。支援 40 多種語言和數百種語音。",
		nav: {
			features: "功能特色",
			screenshots: "螢幕截圖",
			install: "安裝",
		},
		hero: {
			title: "將文字轉換為自然語音",
			description:
				"使用 Amazon Polly 的先進 AI 語音技術，將網頁上的任何文字轉換為高品質、自然的音訊。可從 40 多種語言和數百種專業語音中選擇。",
			cta: {
				primary: "免費新增至 Chrome",
				secondary: "了解更多",
			},
		},
		features: {
			title: "強大功能",
			subtitle: "專業文字轉語音所需的一切功能",
			voices: {
				title: "40 多種語言與數百種語音",
				description: "可選擇標準、神經、生成式和長篇語音引擎，擁有自然的 AI 語音",
			},
			speed: {
				title: "多種播放速度選項",
				description: "右鍵選單提供 1x、1.5x 和 2x 播放速度，提供最佳聆聽體驗",
			},
			processing: {
				title: "智慧文字處理",
				description: "自動清理 HTML 內容並使用先進演算法安全處理特殊字元",
			},
			shortcuts: {
				title: "鍵盤快捷鍵",
				description: "使用 Ctrl+Shift+S 朗讀和 Ctrl+Shift+E 下載的快速存取",
			},
			download: {
				title: "音訊下載",
				description: "儲存為高品質 MP3 檔案，供離線使用和分享",
			},
			ssml: {
				title: "SSML 支援",
				description: "進階標記語言可精確控制語音，包括暫停、重音和發音",
			},
		},
		howto: {
			title: "使用方式",
			subtitle: "只需幾個簡單步驟即可開始使用",
			step1: {
				title: "安裝擴充功能",
				description: "從 Chrome 線上應用程式商店將 Polly for Chrome 新增至您的瀏覽器",
			},
			step2: {
				title: "設定 AWS",
				description: "設定您的 AWS 認證以訪問 Amazon Polly（有免費方案可用）",
			},
			step3: {
				title: "開始聆聽",
				description: "在任何網站上選取任何文字，然後右鍵點擊即可聽到朗讀",
			},
		},
		cta: {
			title: "準備好轉變您的閱讀體驗了嗎？",
			subtitle: "與數千名已經享受自然語音合成的使用者一起",
			install: "安裝 Chrome 擴充功能",
			github: "在 GitHub 上查看",
		},
		footer: {
			description: "使用 Amazon Polly 的先進 AI 語音技術，將任何文字轉換為自然語音。",
			links: {
				title: "連結",
				webstore: "Chrome 線上應用程式商店",
				github: "GitHub 存儲庫",
				issues: "回報問題",
			},
			support: {
				title: "支援",
				help: "說明指南",
				changelog: "更新記錄",
				privacy: "隱私政策",
				docs: "AWS 文件",
			},
		},
	},
	hi: {
		title: "Polly for Chrome - प्रीमियम टेक्स्ट-टू-स्पीच एक्सटेंशन",
		description:
			"Amazon Polly के उन्नत AI आवाज़ों के साथ वेब पर किसी भी टेक्स्ट को उच्च-गुणवत्ता, प्राकृतिक ऑडियो में बदलें। 40+ भाषाएं, सैकड़ों आवाज़ें।",
		nav: {
			features: "विशेषताएं",
			screenshots: "स्क्रीनशॉट",
			install: "इंस्टॉल करें",
		},
		hero: {
			title: "टेक्स्ट को प्राकृतिक आवाज़ में बदलें",
			description:
				"Amazon Polly के उन्नत AI आवाज़ों के साथ वेब पर किसी भी टेक्स्ट को उच्च-गुणवत्ता, प्राकृतिक ऑडियो में बदलें। 40+ भाषाओं और सैकड़ों पेशेवर आवाज़ों में से चुनें।",
			cta: {
				primary: "Chrome में जोड़ें - मुफ़्त",
				secondary: "और जानें",
			},
		},
		features: {
			title: "शक्तिशाली विशेषताएं",
			subtitle: "पेशेवर टेक्स्ट-टू-स्पीच के लिए आवश्यक सब कुछ",
			voices: {
				title: "40+ भाषाएं और सैकड़ों आवाज़ें",
				description: "प्राकृतिक AI आवाज़ों के साथ स्टैंडर्ड, न्यूरल, जेनेरेटिव और लॉन्ग-फॉर्म वॉयस इंजन में से चुनें",
			},
			speed: {
				title: "कई स्पीड विकल्प",
				description: "इष्टतम सुनने के अनुभव के लिए 1x, 1.5x, और 2x प्लेबैक स्पीड के साथ कॉन्टेक्स्ट मेनू",
			},
			processing: {
				title: "स्मार्ट टेक्स्ट प्रोसेसिंग",
				description:
					"HTML कंटेंट को अपने आप साफ करता है और उन्नत एल्गोरिदम का उपयोग करके विशेष वर्णों को सुरक्षित रूप से हैंडल करता है",
			},
			shortcuts: {
				title: "कीबोर्ड शॉर्टकट",
				description: "पढ़ने के लिए Ctrl+Shift+S और डाउनलोड के लिए Ctrl+Shift+E के साथ त्वरित पहुंच",
			},
			download: {
				title: "ऑडियो डाउनलोड",
				description: "ऑफलाइन उपयोग और साझाकरण के लिए उच्च-गुणवत्ता MP3 फाइलों के रूप में सेव करें",
			},
			ssml: {
				title: "SSML समर्थन",
				description: "विराम, जोर और उच्चारण सहित सटीक वाक् नियंत्रण के लिए उन्नत मार्कअप भाषा",
			},
		},
		howto: {
			title: "यह कैसे काम करता है",
			subtitle: "बस कुछ सरल चरणों में शुरू करें",
			step1: {
				title: "एक्सटेंशन इंस्टॉल करें",
				description: "Chrome वेब स्टोर से अपने ब्राउज़र में Polly for Chrome जोड़ें",
			},
			step2: {
				title: "AWS सेट करें",
				description: "Amazon Polly पहुंच के लिए अपने AWS क्रेडेंशियल कॉन्फ़िगर करें (मुफ़्त टियर उपलब्ध)",
			},
			step3: {
				title: "सुनना शुरू करें",
				description: "किसी भी वेबसाइट पर कोई भी टेक्स्ट हाइलाइट करें और इसे जोर से सुनने के लिए राइट-क्लिक करें",
			},
		},
		cta: {
			title: "अपने पढ़ने के अनुभव को बदलने के लिए तैयार हैं?",
			subtitle: "हजारों उपयोगकर्ताओं के साथ जुड़ें जो पहले से ही प्राकृतिक वाक् संश्लेषण का आनंद ले रहे हैं",
			install: "Chrome एक्सटेंशन इंस्टॉल करें",
			github: "GitHub पर देखें",
		},
		footer: {
			description: "Amazon Polly के उन्नत AI आवाज़ों के साथ किसी भी टेक्स्ट को प्राकृतिक वाक् में बदलें।",
			links: {
				title: "लिंक",
				webstore: "Chrome वेब स्टोर",
				github: "GitHub रिपॉजिटरी",
				issues: "समस्या रिपोर्ट करें",
			},
			support: {
				title: "सहायता",
				help: "सहायता गाइड",
				changelog: "चेंजलॉग",
				privacy: "गोपनीयता नीति",
				docs: "AWS दस्तावेज़",
			},
		},
	},
};

// Language mapping for display
const languageLabels: { [key: string]: string } = {
	en: "EN",
	"zh-CN": "中",
	"zh-TW": "繁",
	hi: "हिन्दी",
};

// Current language state
let currentLanguage = "en";

// Get nested translation value
function getTranslation(key: string, lang: string = currentLanguage): string {
	const keys = key.split(".");
	let value: any = translations[lang];

	for (const k of keys) {
		if (value && typeof value === "object" && k in value) {
			value = value[k];
		} else {
			// Fallback to English if translation not found
			value = translations["en"];
			for (const fallbackKey of keys) {
				if (value && typeof value === "object" && fallbackKey in value) {
					value = value[fallbackKey];
				} else {
					return key; // Return key if no translation found
				}
			}
			break;
		}
	}

	return typeof value === "string" ? value : key;
}

// Update page content with translations
function updateContent(lang: string): void {
	currentLanguage = lang;

	// Update page metadata
	const titleElement = document.getElementById("page-title") as HTMLTitleElement;
	const descElement = document.getElementById("page-description") as HTMLMetaElement;
	const htmlElement = document.getElementById("html-root") as HTMLHtmlElement;

	if (titleElement) titleElement.textContent = getTranslation("title", lang);
	if (descElement) descElement.content = getTranslation("description", lang);
	if (htmlElement)
		htmlElement.lang = lang === "zh-CN" ? "zh-CN" : lang === "zh-TW" ? "zh-TW" : lang === "hi" ? "hi" : "en";

	// Update current language button
	const currentLangElement = document.getElementById("current-lang");
	if (currentLangElement) {
		currentLangElement.textContent = languageLabels[lang] || lang.toUpperCase();
	}

	// Update all elements with data-i18n attributes
	const elements = document.querySelectorAll("[data-i18n]");
	elements.forEach((element) => {
		const key = element.getAttribute("data-i18n");
		if (key) {
			element.textContent = getTranslation(key, lang);
		}
	});

	// Update dropdown active state
	const dropdownButtons = document.querySelectorAll("#language-dropdown button");
	dropdownButtons.forEach((button) => {
		const buttonLang = button.getAttribute("data-lang");
		if (buttonLang === lang) {
			button.classList.add("bg-gray-50");
		} else {
			button.classList.remove("bg-gray-50");
		}
	});

	// Store language preference
	try {
		localStorage.setItem("polly-preferred-language", lang);
	} catch (e) {
		console.warn("Could not save language preference:", e);
	}
}

// Initialize page functionality
document.addEventListener("DOMContentLoaded", () => {
	console.log("Initializing multilingual homepage...");

	// Load saved language preference or detect from browser
	let savedLang = "en";
	try {
		savedLang = localStorage.getItem("polly-preferred-language") || "en";
	} catch (e) {
		console.warn("Could not load language preference:", e);
	}

	// Fallback to browser language detection
	if (savedLang === "en") {
		const browserLang = navigator.language || "en";
		if (browserLang.startsWith("zh-CN") || browserLang.startsWith("zh-Hans")) {
			savedLang = "zh-CN";
		} else if (browserLang.startsWith("zh-TW") || browserLang.startsWith("zh-Hant")) {
			savedLang = "zh-TW";
		} else if (browserLang.startsWith("hi")) {
			savedLang = "hi";
		}
	}

	// Set up language switching
	const languageButtons = document.querySelectorAll("#language-dropdown button[data-lang]");
	languageButtons.forEach((button) => {
		button.addEventListener("click", (e) => {
			e.preventDefault();
			const lang = button.getAttribute("data-lang");
			if (lang && lang !== currentLanguage) {
				updateContent(lang);
			}
		});
	});

	// Initialize with saved/detected language
	updateContent(savedLang);

	// Smooth scrolling for navigation links
	const navLinks = document.querySelectorAll('a[href^="#"]');
	navLinks.forEach((link) => {
		link.addEventListener("click", (e) => {
			e.preventDefault();
			const targetId = link.getAttribute("href")?.substring(1);
			if (targetId) {
				const targetElement = document.getElementById(targetId);
				if (targetElement) {
					targetElement.scrollIntoView({
						behavior: "smooth",
						block: "start",
					});
				}
			}
		});
	});

	// Add animation on scroll
	const observerOptions = {
		threshold: 0.1,
		rootMargin: "0px 0px -50px 0px",
	};

	const observer = new IntersectionObserver((entries) => {
		entries.forEach((entry) => {
			if (entry.isIntersecting) {
				entry.target.classList.add("animate-fadeIn");
			}
		});
	}, observerOptions);

	// Observe feature cards and sections
	const animateElements = document.querySelectorAll("section, .bg-gray-50");
	animateElements.forEach((el) => observer.observe(el));

	console.log(`Homepage initialized with language: ${currentLanguage}`);
});
