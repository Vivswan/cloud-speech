import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  title: string;
  description?: string;
}

export interface LabeledSelectProps {
  label: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

/** Classic floating-label select on Radix (keyboard + a11y for free). */
export function LabeledSelect({ label, value, options, disabled, onChange }: LabeledSelectProps) {
  const selected = options.find((o) => o.value === value);

  return (
    <div className={cn("relative font-semibold text-xs", disabled && "opacity-50")}>
      <span className="bg-card absolute text-xxs -top-2 left-1.5 px-1 text-muted z-10">
        {label}
      </span>
      <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
        <SelectPrimitive.Trigger
          className={cn(
            "border border-edge h-9 px-3 py-1 rounded-md w-full text-left text-strong bg-inset cursor-pointer flex items-center justify-between gap-2 transition-[background-color,border-color] duration-150 data-[state=open]:bg-card data-[state=open]:border-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
          )}
        >
          <span className="truncate">{selected?.title ?? value}</span>
          <ChevronDown size={14} className="text-faint shrink-0" />
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            className="z-50 max-h-64 w-[var(--radix-select-trigger-width)] overflow-auto rounded-md border border-edge bg-card shadow-lg origin-(--radix-select-content-transform-origin) data-[state=open]:animate-pop-in"
          >
            <SelectPrimitive.Viewport className="p-1">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className="flex cursor-pointer flex-col rounded px-2 py-1 text-xs outline-none data-[highlighted]:bg-inset data-[state=checked]:font-semibold data-[state=checked]:text-strong"
                >
                  <div className="flex items-center justify-between gap-2">
                    <SelectPrimitive.ItemText>{option.title}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator>
                      <Check size={12} />
                    </SelectPrimitive.ItemIndicator>
                  </div>
                  {option.description && (
                    <span className="text-xxs text-faint">{option.description}</span>
                  )}
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}
