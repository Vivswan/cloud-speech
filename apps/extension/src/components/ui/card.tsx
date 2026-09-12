import type * as React from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-card p-3 rounded-lg shadow-sm border border-edge", className)}
      {...props}
    />
  );
}

export function SectionTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("font-semibold text-body mb-1.5 ml-1 flex items-center gap-1", className)}
      {...props}
    />
  );
}
