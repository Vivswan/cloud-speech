import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          // Above the voice-picker popover (z-50); wraps long provider errors.
          "z-[60] max-w-72 rounded-md bg-inverse px-2.5 py-1.5 text-xxs text-on-inverse shadow-lg",
          "whitespace-normal break-words",
          "origin-(--radix-tooltip-content-transform-origin) data-[state=delayed-open]:animate-pop-in",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
