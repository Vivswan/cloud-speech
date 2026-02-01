import { download, downloadShortcut } from "./download";
import { readAloud, readAloud1_5x, readAloud1x, readAloud2x, readAloudShortcut } from "./read-aloud";
import { stopReading } from "./stop-reading";
import { getAudioUri, synthesize } from "./synthesis";
import { fetchVoices } from "./voices";

export const handlers: any = {
	readAloud1x,
	readAloud1_5x,
	readAloud2x,
	readAloud,
	readAloudShortcut,
	stopReading,
	download,
	downloadShortcut,
	synthesize,
	getAudioUri,
	fetchVoices,
};
