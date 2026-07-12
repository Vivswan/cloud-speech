import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/cn";

export interface LabeledSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** Classic prosody slider with floating label + live value readout. */
export function LabeledSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange,
}: LabeledSliderProps) {
  // A stored value can briefly exceed the current provider's range (voice
  // switched, reconcile not persisted yet) — never SHOW an out-of-range
  // number; the stored settings stay untouched until reconcile clamps them.
  const clamped = Math.min(Math.max(value, min), max);
  return (
    <div className={cn("relative font-semibold text-xs text-stone-500", disabled && "opacity-50")}>
      <span className="absolute text-xxs -top-2 left-1.5 px-1">{label}</span>
      <div className="absolute text-xxs -top-2 right-1.5 px-1">
        {clamped}
        {unit ?? ""}
      </div>
      <div className="h-10 flex items-center px-1">
        <SliderPrimitive.Root
          className="relative flex w-full touch-none select-none items-center"
          value={[clamped]}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onValueChange={([v]) => v !== undefined && onChange(v)}
        >
          <SliderPrimitive.Track className="relative h-1 w-full grow rounded bg-stone-300">
            <SliderPrimitive.Range className="absolute h-full rounded bg-brand" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-label={label}
            className="block h-3.5 w-3.5 rounded-full bg-brand shadow cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
          />
        </SliderPrimitive.Root>
      </div>
    </div>
  );
}
