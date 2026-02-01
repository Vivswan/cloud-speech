import "@testing-library/jest-dom";
import { cleanup } from "@testing-library/react";
import { afterEach, vi, beforeEach } from "vitest";

// Auto cleanup after each test
afterEach(() => {
	cleanup();
});

// Mock Chrome extension APIs
const mockChromeStorage = {
	sync: {
		get: vi.fn(),
		set: vi.fn(),
		remove: vi.fn(),
		clear: vi.fn(),
		getBytesInUse: vi.fn(),
		onChanged: {
			addListener: vi.fn(),
			removeListener: vi.fn(),
			hasListener: vi.fn(),
		},
	},
	local: {
		get: vi.fn(),
		set: vi.fn(),
		remove: vi.fn(),
		clear: vi.fn(),
		getBytesInUse: vi.fn(),
		onChanged: {
			addListener: vi.fn(),
			removeListener: vi.fn(),
			hasListener: vi.fn(),
		},
	},
	session: {
		get: vi.fn(),
		set: vi.fn(),
		remove: vi.fn(),
		clear: vi.fn(),
		getBytesInUse: vi.fn(),
		onChanged: {
			addListener: vi.fn(),
			removeListener: vi.fn(),
			hasListener: vi.fn(),
		},
	},
};

const mockChromeRuntime = {
	lastError: undefined,
	id: "test-extension-id",
	sendMessage: vi.fn(),
	onMessage: {
		addListener: vi.fn(),
		removeListener: vi.fn(),
		hasListener: vi.fn(),
	},
	connect: vi.fn(),
	getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
	getManifest: vi.fn(() => ({
		manifest_version: 3,
		name: "Test Extension",
		version: "1.0.0",
	})),
};

const mockChromeTabs = {
	query: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	sendMessage: vi.fn(),
	onUpdated: {
		addListener: vi.fn(),
		removeListener: vi.fn(),
		hasListener: vi.fn(),
	},
	onActivated: {
		addListener: vi.fn(),
		removeListener: vi.fn(),
		hasListener: vi.fn(),
	},
};

const mockChromeCommands = {
	onCommand: {
		addListener: vi.fn(),
		removeListener: vi.fn(),
		hasListener: vi.fn(),
	},
};

const mockChromeContextMenus = {
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	removeAll: vi.fn(),
	onClicked: {
		addListener: vi.fn(),
		removeListener: vi.fn(),
		hasListener: vi.fn(),
	},
};

const mockChromeOffscreen = {
	createDocument: vi.fn(),
	closeDocument: vi.fn(),
	hasDocument: vi.fn(),
};

/* eslint-disable no-undef, @typescript-eslint/no-explicit-any */
global.chrome = {
	storage: mockChromeStorage,
	runtime: mockChromeRuntime,
	tabs: mockChromeTabs,
	commands: mockChromeCommands,
	contextMenus: mockChromeContextMenus,
	offscreen: mockChromeOffscreen,
} as any;
/* eslint-enable no-undef, @typescript-eslint/no-explicit-any */

// Mock AWS Polly SDK
vi.mock("@aws-sdk/client-polly", () => ({
	PollyClient: vi.fn(() => ({
		send: vi.fn(),
	})),
	SynthesizeSpeechCommand: vi.fn(),
	DescribeVoicesCommand: vi.fn(),
}));

// Mock wink-nlp for text processing
vi.mock("wink-nlp", () => ({
	default: vi.fn(() => ({
		readDoc: vi.fn((text: string) => ({
			sentences: vi.fn(() => ({
				out: vi.fn(() => [text]),
			})),
		})),
	})),
}));

vi.mock("wink-eng-lite-web-model", () => ({
	default: {},
}));

// Mock localStorage and sessionStorage
const localStorageMock = (() => {
	let store: Record<string, string> = {};

	return {
		getItem: (key: string) => store[key] || null,
		setItem: (key: string, value: string) => {
			store[key] = value.toString();
		},
		removeItem: (key: string) => {
			delete store[key];
		},
		clear: () => {
			store = {};
		},
		get length() {
			return Object.keys(store).length;
		},
		key: (index: number) => {
			const keys = Object.keys(store);
			return keys[index] || null;
		},
	};
})();

const sessionStorageMock = (() => {
	let store: Record<string, string> = {};

	return {
		getItem: (key: string) => store[key] || null,
		setItem: (key: string, value: string) => {
			store[key] = value.toString();
		},
		removeItem: (key: string) => {
			delete store[key];
		},
		clear: () => {
			store = {};
		},
		get length() {
			return Object.keys(store).length;
		},
		key: (index: number) => {
			const keys = Object.keys(store);
			return keys[index] || null;
		},
	};
})();

/* eslint-disable no-undef, @typescript-eslint/no-explicit-any */
global.localStorage = localStorageMock as any;
global.sessionStorage = sessionStorageMock as any;
/* eslint-enable no-undef, @typescript-eslint/no-explicit-any */

// Clear storage before each test
beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

// Mock Service Worker clients API
/* eslint-disable no-undef, @typescript-eslint/no-explicit-any */
(global as any).clients = {
	get: vi.fn(),
	matchAll: vi.fn(() => Promise.resolve([])),
	openWindow: vi.fn(),
	claim: vi.fn(),
};
/* eslint-enable no-undef, @typescript-eslint/no-explicit-any */

// Mock browser APIs
Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

/* eslint-disable no-undef, @typescript-eslint/no-explicit-any */
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
	takeRecords: vi.fn(() => []),
	root: null,
	rootMargin: "",
	thresholds: [],
})) as any;

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
})) as any;
/* eslint-enable no-undef, @typescript-eslint/no-explicit-any */

// Mock Audio for text-to-speech
/* eslint-disable no-undef, @typescript-eslint/no-explicit-any */
global.Audio = vi.fn().mockImplementation(() => ({
	play: vi.fn(() => Promise.resolve()),
	pause: vi.fn(),
	load: vi.fn(),
	addEventListener: vi.fn(),
	removeEventListener: vi.fn(),
	src: "",
	volume: 1,
	playbackRate: 1,
	currentTime: 0,
	duration: 0,
	paused: true,
	ended: false,
})) as any;
/* eslint-enable no-undef, @typescript-eslint/no-explicit-any */
