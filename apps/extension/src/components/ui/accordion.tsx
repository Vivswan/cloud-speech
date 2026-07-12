import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/cn";

export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      className={cn(
        "border border-stone-200 rounded-lg bg-white shadow-sm transition-colors duration-150 data-[state=open]:border-stone-300",
        className,
      )}
      {...props}
    />
  );
}

export function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header>
      <AccordionPrimitive.Trigger
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg p-2.5 text-left cursor-pointer transition-colors duration-150 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          size={14}
          className="ml-auto shrink-0 text-stone-400 transition-transform duration-200 ease-snap group-data-[state=open]:rotate-180"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className={cn(
        "overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up",
        className,
      )}
      {...props}
    >
      <div className="border-t border-stone-100 p-2.5 pt-3">{children}</div>
    </AccordionPrimitive.Content>
  );
}
