import type { SyncStorage, SessionStorage, VoiceOption } from "@/types";

/**
 * Mock SyncStorage data for testing
 */
export const mockSyncStorage: SyncStorage = {
	awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
	awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	awsRegion: "us-east-1",
	language: "en-US",
	voice: "Joanna",
	engine: "neural",
	speed: 1.0,
	pitch: "+0%",
	volume: "+0dB",
	maxChars: 3000,
	autoplay: true,
	showCaptions: true,
	captionSize: "medium",
};

/**
 * Mock SessionStorage data for testing
 */
export const mockSessionStorage: SessionStorage = {
	voices: [
		{ value: "Joanna", label: "Joanna (Female, US)" },
		{ value: "Matthew", label: "Matthew (Male, US)" },
		{ value: "Amy", label: "Amy (Female, UK)" },
	],
	languages: [
		{ value: "en-US", label: "English (US)" },
		{ value: "en-GB", label: "English (UK)" },
		{ value: "es-ES", label: "Spanish (Spain)" },
	],
};

/**
 * Mock voice options for dropdown testing
 */
export const mockVoiceOptions: VoiceOption[] = [
	{ value: "Joanna", label: "Joanna (Female, US)" },
	{ value: "Matthew", label: "Matthew (Male, US)" },
	{ value: "Amy", label: "Amy (Female, UK)" },
	{ value: "Brian", label: "Brian (Male, UK)" },
	{ value: "Emma", label: "Emma (Female, UK)" },
];

/**
 * Mock language options for dropdown testing
 */
export const mockLanguageOptions = [
	{ value: "en-US", label: "English (US)" },
	{ value: "en-GB", label: "English (UK)" },
	{ value: "es-ES", label: "Spanish (Spain)" },
	{ value: "fr-FR", label: "French (France)" },
	{ value: "de-DE", label: "German (Germany)" },
];

/**
 * Mock translation data
 */
export const mockTranslations = {
	en: {
		common: {
			save: "Save",
			cancel: "Cancel",
			delete: "Delete",
			edit: "Edit",
			close: "Close",
		},
		settings: {
			title: "Settings",
			language: "Language",
			voice: "Voice",
			speed: "Speed",
			pitch: "Pitch",
			volume: "Volume",
		},
	},
	es: {
		common: {
			save: "Guardar",
			cancel: "Cancelar",
			delete: "Eliminar",
			edit: "Editar",
			close: "Cerrar",
		},
		settings: {
			title: "Configuración",
			language: "Idioma",
			voice: "Voz",
			speed: "Velocidad",
			pitch: "Tono",
			volume: "Volumen",
		},
	},
};

/**
 * Mock SSML text samples
 */
export const mockSSMLText = `
<speak>
  <prosody rate="medium" pitch="+0%" volume="+0dB">
    Hello, this is a test.
  </prosody>
</speak>
`.trim();

/**
 * Mock plain text samples
 */
export const mockPlainText = "Hello, this is a test.";

/**
 * Mock long text for chunking tests
 */
export const mockLongText = Array(100).fill("This is a sentence. ").join("");
