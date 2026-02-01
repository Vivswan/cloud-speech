export interface SyncStorage {
	language: string;
	speed: number;
	pitch: number;
	voices: Record<string, string>;
	readAloudEncoding: string;
	downloadEncoding: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	audioProfile: string;
	volumeGainDb: number;
	credentialsValid: boolean;
	apiKeyValid?: boolean;
	engine: string;
}

export interface SessionStorage {
	voices?: Voice[];
	languages?: string[];
}

export interface Voice {
	name: string;
	ssmlGender: string;
	languageCodes: string[];
	naturalSampleRateHertz: number;
	supportedEngines: string[];
}

export interface LanguageOption {
	value: string;
	title: string;
	description?: string;
}

export interface VoiceOption {
	value: string;
	title: string;
	description: string;
}

export interface EngineOption {
	value: string;
	title: string;
	description: string;
}

export interface SynthesizeParams {
	text: string;
	encoding: string;
	voice: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	speed: number;
	pitch: number;
	volumeGainDb: number;
	engine: string;
}
