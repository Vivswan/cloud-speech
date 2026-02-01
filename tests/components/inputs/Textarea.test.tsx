import { describe, it, expect, vi } from "vitest";
import { render, screen, userEvent } from "../../utils/test-utils";
import { Textarea } from "@/components/inputs/Textarea";

describe("Textarea", () => {
	it("should render with label", () => {
		render(<Textarea value="" onChange={vi.fn()} label="Description" />);
		expect(screen.getByText("Description")).toBeInTheDocument();
	});

	it("should render with value", () => {
		render(<Textarea value="test content" onChange={vi.fn()} label="Input" />);
		const textarea = screen.getByRole("textbox");
		expect(textarea).toHaveValue("test content");
	});

	it("should render with placeholder", () => {
		render(<Textarea value="" onChange={vi.fn()} placeholder="Enter text..." />);
		expect(screen.getByPlaceholderText("Enter text...")).toBeInTheDocument();
	});

	it("should call onChange when value changes", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();

		render(<Textarea value="" onChange={onChange} label="Input" />);
		const textarea = screen.getByRole("textbox");

		await user.type(textarea, "hello");

		expect(onChange).toHaveBeenCalled();
	});

	it("should be disabled when disabled prop is true", () => {
		render(<Textarea value="" onChange={vi.fn()} disabled label="Input" />);
		const textarea = screen.getByRole("textbox");
		expect(textarea).toBeDisabled();
	});

	it("should show error message", () => {
		render(<Textarea value="" onChange={vi.fn()} error="This field is required" />);
		expect(screen.getByText("This field is required")).toBeInTheDocument();
	});

	it("should apply error styling to label", () => {
		render(<Textarea value="" onChange={vi.fn()} label="Input" error="This field is required" />);
		const label = screen.getByText("Input");
		expect(label).toHaveClass("text-red-500");
	});

	it("should apply error styling to textarea", () => {
		render(<Textarea value="" onChange={vi.fn()} error="This field is required" />);
		const textarea = screen.getByRole("textbox");
		expect(textarea).toHaveClass("border-red-400");
	});

	it("should apply custom className", () => {
		render(<Textarea value="" onChange={vi.fn()} className="custom-class" />);
		const container = screen.getByRole("textbox").parentElement;
		expect(container).toHaveClass("custom-class");
	});

	it("should apply grow class for expandable textarea", () => {
		render(<Textarea value="" onChange={vi.fn()} className="grow" />);
		const textarea = screen.getByRole("textbox");
		expect(textarea).toHaveClass("h-full");
		expect(textarea).toHaveClass("min-h-32");
	});

	it("should handle multiline text", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();

		render(<Textarea value="" onChange={onChange} />);
		const textarea = screen.getByRole("textbox");

		await user.type(textarea, "Line 1{Enter}Line 2{Enter}Line 3");

		expect(onChange).toHaveBeenCalled();
	});

	it("should update internal state when typing", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(<Textarea value="" onChange={onChange} />);

		const textarea = screen.getByRole("textbox");
		await user.type(textarea, "New");

		// onChange should have been called for each character
		expect(onChange).toHaveBeenCalled();
	});
});
