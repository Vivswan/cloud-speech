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
        "border border-edge rounded-lg bg-card shadow-sm transition-colors duration-150 data-[state=open]:border-edge-strong",
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
          "group flex w-full items-center gap-2 rounded-lg p-2.5 text-left cursor-pointer transition-colors duration-150 hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          size={14}
          className="ml-auto shrink-0 text-faint transition-transform duration-200 ease-snap group-data-[state=open]:rotate-180"
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
      <div className="border-t border-edge-soft p-2.5 pt-3">{children}</div>
    </AccordionPrimitive.Content>
  );
}
