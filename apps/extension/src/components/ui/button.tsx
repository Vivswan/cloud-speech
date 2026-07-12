import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md border py-1.5 px-2.5 text-xs font-medium shadow-sm transition-[transform,background-color,border-color] duration-150 ease-snap select-none cursor-pointer active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
  {
    variants: {
      variant: {
        default: "bg-white hover:bg-stone-100 text-stone-600 border-stone-200",
        primary: "bg-blue-600 text-white border-blue-900/25 hover:bg-blue-700",
        accent: "bg-brand text-ink border-amber-600/40 hover:bg-amber-500",
        secondary: "bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-200",
        danger: "bg-red-600 text-white border-red-900/25 hover:bg-red-700",
        ghost: "border-transparent shadow-none hover:bg-stone-100 text-stone-600",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  submitting?: boolean;
}

export function Button({
  className,
  variant,
  submitting,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant }), className)}
      disabled={disabled || submitting}
      {...props}
    >
      {submitting && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}
