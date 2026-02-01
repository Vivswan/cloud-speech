import React, { useState } from "react";
import { twMerge } from "tailwind-merge";
import { Eye, EyeOff } from "react-feather";

interface TextProps {
	value?: string;
	onChange?: (value: string) => void;
	label?: string;
	placeholder?: string;
	error?: string;
	disabled?: boolean;
	type?: string;
	min?: number;
	max?: number;
}

export function Text(props: TextProps) {
	const [_value, setValue] = useState(props.value);
	const [showPassword, setShowPassword] = useState(false);

	function handleChange(e) {
		const value = e?.currentTarget?.value;
		setValue(value);
		if (props.onChange) props.onChange(value);
	}

	const isPassword = props.type === "password";
	const inputType = isPassword && showPassword ? "text" : props.type || "text";

	return (
		<div className="relative font-semibold text-xs">
			<label
				className={twMerge(
					"bg-white absolute text-xxs -top-2 left-1.5 px-1 text-neutral-500",
					props.error && "text-red-500"
				)}
			>
				{props.label}
			</label>

			<input
				type={inputType}
				className={twMerge(
					"border border-neutral-200 h-9 px-3 py-1 outline-none rounded-md w-full text-neutral-900",
					props.error && "border-red-400",
					isPassword && "pr-10"
				)}
				placeholder={props.placeholder}
				value={props.value}
				onChange={handleChange}
				disabled={props.disabled}
				min={props.min}
				max={props.max}
			/>

			{isPassword && (
				<button
					type="button"
					className="absolute right-3 top-1/2 transform -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
					onClick={() => setShowPassword(!showPassword)}
				>
					{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
				</button>
			)}

			<span className="text-red-500 text-xxs pl-2 pt-0.5">{props.error}</span>
		</div>
	);
}
