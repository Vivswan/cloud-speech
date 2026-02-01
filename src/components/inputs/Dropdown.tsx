import Fuse from "fuse.js";
import React, { KeyboardEvent, MouseEvent, useRef, useState } from "react";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import { useMount } from "../../hooks/useMount";
import { twMerge } from "tailwind-merge";

interface DropdownOption {
	value: string;
	title: string;
	description?: string;
	disabled?: boolean;
}

interface DropdownProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	options: DropdownOption[];
	label?: string;
	disabled?: boolean;
}

export function Dropdown(props: DropdownProps) {
	const inputRef = useRef(null);
	const [open, setOpen] = useState(false);
	const [input, setInput] = useState(props.value);
	const [dirty, setDirty] = useState(false);
	const [index, setIndex] = useState(props.options.findIndex((o) => o.value === props.value));
	const option = props.options.find((o) => o.value === input || (o.value === props.value && !dirty));

	const fuse = new Fuse(props.options, {
		keys: ["value", "title", "description"],
		threshold: 0.4,
	});

	const options = dirty && input ? fuse.search(input).map((result) => result.item) : props.options;

	if (!options.length) {
		options.push({
			title: "No results found",
			value: "",
			disabled: true,
			description: "Try a different search",
		});
	}

	function handleChange(e) {
		const value = e?.currentTarget?.value;
		setDirty(true);
		setInput(value);
		setIndex(value ? 0 : props.options.findIndex((o) => o.value === props.value));
		props.onChange(value);
	}

	function handleClick(option) {
		handleChange({ currentTarget: { value: option.value } });
		setDirty(false);
		handleClose();
	}

	function handleClose() {
		setOpen(false);
		setDirty(false);
		setIndex(props.options.findIndex((o) => o.value === props.value));
	}

	function handleOpen() {
		setOpen(true);
		setDirty(false);
		if (inputRef.current) inputRef.current.select();
	}

	function scrollIntoView({ nextIndex, previousIndex }: { nextIndex?: number; previousIndex?: number }) {
		const index = nextIndex ?? previousIndex;
		const ref = document.querySelector(`[data-value="${options[index].value}"]`) as HTMLElement;
		const containerRef = ref.parentNode as HTMLElement;
		const isOutOfView =
			ref.offsetTop < containerRef.scrollTop ||
			ref.offsetTop + ref.offsetHeight > containerRef.scrollTop + containerRef.offsetHeight;

		// Pointer events are disabled during the scroll in order to prevent
		// mouseover events from firing while scrolling which would cause
		// the index to change and the scroll to jump around
		containerRef.style.pointerEvents = "none";
		ref?.scrollIntoView({ block: "nearest" });

		if (nextIndex !== undefined && isOutOfView) containerRef.scrollTop += 4;
		if (previousIndex !== undefined && isOutOfView) containerRef.scrollTop -= 4;
		setTimeout(() => (containerRef.style.pointerEvents = "auto"), 0);
	}

	function handleKeydown(e: KeyboardEvent<HTMLInputElement>) {
		switch (e.key) {
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				handleClose();
				e.currentTarget?.blur();
				break;
			case "Enter":
				e.preventDefault();
				e.stopPropagation();
				handleClick(options[index]);
				break;
			case "ArrowDown":
				e.preventDefault();
				e.stopPropagation();
				const nextIndex = (index + 1) % options.length;
				setIndex(nextIndex);
				scrollIntoView({ nextIndex, previousIndex: undefined });
				break;
			case "ArrowUp":
				e.preventDefault();
				e.stopPropagation();
				const previousIndex = (index - 1 + options.length) % options.length;
				setIndex(previousIndex);
				scrollIntoView({ nextIndex: undefined, previousIndex });
				break;
			case "Tab":
				handleClose();
				break;
		}
	}

	function handleMouseOver(e: MouseEvent<HTMLDivElement>) {
		const value = e.currentTarget.dataset.value || "";
		const index = options.findIndex((o) => o.value === value);
		setIndex(index);
	}

	// TODO(mike): Should not open below if there is more space but input fits anyways
	const rect = inputRef.current?.getBoundingClientRect();
	const position = {
		top: rect?.top + window.scrollY,
		left: rect?.left + window.scrollX,
	};

	const viewportHeight = window.innerHeight;
	const spaceAbove = position.top;
	const spaceBelow = viewportHeight - (position.top + rect?.height);
	const popupPosition = spaceBelow > spaceAbove ? "below" : "above";

	return (
		<div
			className="relative font-semibold text-xs select-none cursor-pointer"
			ref={useOutsideClick(handleClose)}
			onClick={handleOpen}
		>
			<label className=" bg-white absolute text-xxs -top-2 left-1.5 px-1 text-neutral-500">{props.label}</label>

			<Options open={open} position={popupPosition}>
				{options.map((option, i) => (
					<Option
						selected={option.value === props.value}
						focused={option.value === options[index]?.value}
						option={option}
						key={`option-${option.value}:${i}`}
						onClick={handleClick}
						onMouseOver={handleMouseOver}
					/>
				))}
			</Options>

			<input
				ref={inputRef}
				type="text"
				className="border border-neutral-200 h-9 px-3 py-1 outline-none rounded-md w-full text-neutral-900 cursor-pointer"
				placeholder={props.placeholder}
				value={option?.title || input}
				onChange={handleChange}
				disabled={props.disabled}
				onKeyDown={handleKeydown}
				onFocus={handleOpen}
				onClick={handleOpen}
			/>
		</div>
	);
}

interface OptionsProps {
	open: boolean;
	position?: "below" | "above";
	children: React.ReactNode;
	onMouseEnter?: () => void;
}

function Options(props: OptionsProps) {
	const position = props.position || "below";

	if (!props.open) return null;

	function handleRef(ref) {
		if (!ref) return;

		const boundings = ref.getBoundingClientRect();
		const maxHeight = position === "below" ? window.innerHeight - boundings?.top - 10 : boundings?.top - 10;
		ref.style.maxHeight = `${maxHeight}px`;
	}

	const positionStyle = position === "below" ? "top-10" : "bottom-11";

	return (
		<div
			ref={handleRef}
			className={`absolute ${positionStyle} left-0 w-full z-30 rounded border bg-white shadow-sm overflow-scroll`}
			onMouseEnter={props.onMouseEnter}
			style={{ overscrollBehavior: "none" }}
		>
			{props.children}
		</div>
	);
}

interface OptionProps {
	selected: boolean;
	focused: boolean;
	option: DropdownOption;
	onClick: (option: DropdownOption) => void;
	onMouseOver: (e: MouseEvent<HTMLDivElement>) => void;
}

function Option(props: OptionProps) {
	const ref = useRef(null);

	useMount(function () {
		if (props.selected) ref.current.scrollIntoView({ block: "nearest", inline: "nearest" });
	});

	function handleClick(e: MouseEvent<HTMLDivElement>) {
		e.preventDefault();
		e.stopPropagation();
		if (!props.option.disabled) props.onClick(props.option);
	}

	return (
		<div
			ref={ref}
			className={twMerge(
				"flex flex-col px-2 py-1 m-1 rounded select-none cursor-pointer",
				"hover:bg-neutral-100",
				props.selected && "text-blue-900",
				props.focused && !props.selected && "bg-neutral-200 bg-opacity-80",
				props.focused && props.selected && "bg-blue-400 bg-opacity-30"
			)}
			onClick={handleClick}
			data-value={props.option.value}
			onMouseOver={props.onMouseOver}
		>
			{props.option.title}
			<span className="text-xxs opacity-60">{props.option.description}</span>
		</div>
	);
}
