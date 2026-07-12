import type { ReactNode } from "react";

export function View({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-stone-100/60">
      <div className="flex min-h-full flex-col p-4">{children}</div>
    </div>
  );
}
