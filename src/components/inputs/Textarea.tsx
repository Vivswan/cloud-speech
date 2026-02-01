import React, { ChangeEvent, useState } from "react";
import { twMerge } from "tailwind-merge";

interface TextareaProps {
	value?: string;
	onChange?: (value: string) => void;
	label?: string;
	placeholder?: string;
	error?: string;
	disabled?: boolean;
	className?: string;
}

export function Textarea(props: TextareaProps) {
	const [_value, setValue] = useState(props.value);

	function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
		const value = e?.currentTarget?.value;
		setValue(value);
		if (props.onChange) props.onChange(value);
	}

	return (
		<div className={twMerge("relative font-semibold text-xs flex flex-col grow", props.className)}>
			<label
				className={twMerge(
					"bg-white absolute text-xxs -top-2 left-1.5 px-1 text-neutral-500",
					props.error && "text-red-500"
				)}
			>
				{props.label}
			</label>

			<textarea
				className={twMerge(
					"border border-neutral-200 h-9 px-3 py-1 outline-none rounded-md w-full text-neutral-900",
					props.error && "border-red-400",
					props.className?.includes("grow") && "h-full min-h-32"
				)}
				placeholder={props.placeholder}
				value={props.value}
				onChange={handleChange}
				disabled={props.disabled}
			/>

			<span className="text-red-500 text-xxs pl-2 pt-0.5">{props.error}</span>
		</div>
	);
}
