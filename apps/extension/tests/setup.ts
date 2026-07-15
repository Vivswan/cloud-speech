import "@testing-library/jest-dom/vitest";

// happy-dom ships no Web Locks implementation (navigator.locks is null), but
// the settings write lock in src/lib/storage.ts requires one. Minimal
// exclusive-only stub with FIFO ordering per lock name. defineProperty is
// required: plain assignment would hit happy-dom's getter-only property.
if (!navigator.locks) {
  const queues = new Map<string, Promise<unknown>>();
  const stub = {
    request(
      name: string,
      callback: (lock: { name: string; mode: "exclusive" }) => unknown,
    ): Promise<unknown> {
      const prev = queues.get(name) ?? Promise.resolve();
      const run = prev.then(() => callback({ name, mode: "exclusive" }));
      queues.set(
        name,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: stub as unknown as LockManager,
  });
}
