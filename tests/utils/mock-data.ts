import type { SyncStorage, SessionStorage, VoiceOption, Voice } from "@/types";

/**
 * Mock SyncStorage data for testing
 */
export const mockSyncStorage: SyncStorage = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
	language: "en-US",
	voices: { "en-US": "Joanna" },
	engine: "neural",
	speed: 1.0,
	pitch: 0,
	volumeGainDb: 0,
	readAloudEncoding: "mp3",
	downloadEncoding: "mp3",
	audioProfile: "default",
	credentialsValid: true,
	apiKeyValid: true,
};

/**
 * Mock Voice objects for testing
 */
export const mockVoices: Voice[] = [
	{
		name: "Joanna",
		ssmlGender: "FEMALE",
		languageCodes: ["en-US"],
		naturalSampleRateHertz: 24000,
		supportedEngines: ["neural", "standard"],
	},
	{
		name: "Matthew",
		ssmlGender: "MALE",
		languageCodes: ["en-US"],
		naturalSampleRateHertz: 24000,
		supportedEngines: ["neural", "standard"],
	},
	{
		name: "Amy",
		ssmlGender: "FEMALE",
		languageCodes: ["en-GB"],
		naturalSampleRateHertz: 24000,
		supportedEngines: ["neural", "standard"],
	},
];

/**
 * Mock SessionStorage data for testing
 */
export const mockSessionStorage: SessionStorage = {
	voices: mockVoices,
	languages: ["en-US", "en-GB", "es-ES"],
};

/**
 * Mock voice options for dropdown testing
 */
export const mockVoiceOptions: VoiceOption[] = [
	{ value: "Joanna", title: "Joanna", description: "Female, US" },
	{ value: "Matthew", title: "Matthew", description: "Male, US" },
	{ value: "Amy", title: "Amy", description: "Female, UK" },
	{ value: "Brian", title: "Brian", description: "Male, UK" },
	{ value: "Emma", title: "Emma", description: "Female, UK" },
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
