import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/cn";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors duration-150 data-[state=checked]:bg-green-600 data-[state=unchecked]:bg-fill disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-200 ease-snap data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}
