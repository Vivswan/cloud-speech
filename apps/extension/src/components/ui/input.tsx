import { Eye, EyeOff } from "lucide-react";
import * as React from "react";
import { i18n } from "#i18n";
import { cn } from "@/lib/cn";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label?: string;
  error?: string;
  onChange?: (value: string) => void;
}

/** Classic floating-label input (password variant gets a show/hide toggle). */
export function Input({ label, error, type, className, onChange, id, ...props }: InputProps) {
  const [showPassword, setShowPassword] = React.useState(false);
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const isPassword = type === "password";
  const inputType = isPassword && showPassword ? "text" : (type ?? "text");

  return (
    <div className="relative font-semibold text-xs">
      {label && (
        <label
          htmlFor={inputId}
          className={cn(
            "bg-card absolute text-xxs -top-2 left-1.5 px-1 text-muted z-10",
            error && "text-danger",
          )}
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        type={inputType}
        className={cn(
          "border border-edge h-9 px-3 py-1 rounded-md w-full text-strong bg-inset transition-[background-color,border-color] duration-150 focus:bg-card focus:border-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong disabled:cursor-default disabled:opacity-50",
          error && "border-danger",
          isPassword && "pr-9",
          className,
        )}
        onChange={(e) => onChange?.(e.currentTarget.value)}
        {...props}
      />
      {isPassword && (
        <button
          type="button"
          aria-label={
            showPassword ? i18n.t("common.hide_password") : i18n.t("common.show_password")
          }
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-body"
          onClick={() => setShowPassword((v) => !v)}
        >
          {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      )}
      {error && <span className="text-danger text-xxs pl-2 pt-0.5 block">{error}</span>}
    </div>
  );
}
