import type * as React from "react";
import { cn } from "@/lib/cn";

/** Classic white card. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-white p-3 rounded-lg shadow-sm border border-stone-200", className)}
      {...props}
    />
  );
}

/** Section heading above a card. */
export function SectionTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("font-semibold text-stone-700 mb-1.5 ml-1 flex items-center gap-1", className)}
      {...props}
    />
  );
}
