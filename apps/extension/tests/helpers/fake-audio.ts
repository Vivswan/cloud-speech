// A controllable stand-in for HTMLAudioElement: tests drive the media
// callbacks (onloadedmetadata/onended/onerror) by hand, exactly like the
// browser would after loading a source. Stub with vi.stubGlobal("Audio", …)
// BEFORE the code under test constructs its elements.
export class FakeAudio {
  static instances: FakeAudio[] = [];

  src = "";
  paused = true;
  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  error: { message: string } | null = null;

  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;

  private listeners: Record<string, (() => void)[]> = {};

  constructor() {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  play(): Promise<void> {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.onpause?.();
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  /** Simulate the media element reaching its natural end. */
  end(): void {
    this.paused = true;
    this.onended?.();
    for (const listener of this.listeners.ended ?? []) listener();
  }
}
