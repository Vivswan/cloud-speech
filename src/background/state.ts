// Local state management
let queue: string[] = [];
let playing = false;
let cancellationToken = false;
let bootstrappedResolver: (() => void) | null = null;

// Chunk size for processing audio bytes to avoid call stack overflow
// 8192 bytes is a good balance between memory usage and performance
export const AUDIO_CHUNK_SIZE = 8192;

export const bootstrapped = new Promise<void>((resolve) => (bootstrappedResolver = resolve));

// Queue management
export function getQueue(): string[] {
	return queue;
}

export function setQueue(newQueue: string[]): void {
	queue = newQueue;
}

export function addToQueue(...items: string[]): void {
	queue.push(...items);
}

export function shiftQueue(): string | undefined {
	return queue.shift();
}

export function clearQueue(): void {
	queue = [];
}

export function getQueueLength(): number {
	return queue.length;
}

// Playing state management
export function isPlaying(): boolean {
	return playing;
}

export function setPlaying(value: boolean): void {
	playing = value;
}

// Cancellation token management
export function getCancellationToken(): boolean {
	return cancellationToken;
}

export function setCancellationToken(value: boolean): void {
	cancellationToken = value;
}

// Bootstrap resolver
export function resolveBootstrap(): void {
	if (bootstrappedResolver) {
		bootstrappedResolver();
	}
}
