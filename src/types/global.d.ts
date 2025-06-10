declare global {
  interface String {
    chunk(): string[];

    chunkSSML(): string[];

    isSSML(): boolean;
  }

  interface Window {
    clients: any;
  }

  declare const clients: any
}

export {}