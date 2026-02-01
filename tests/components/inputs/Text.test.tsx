import { describe, it, expect, vi } from "vitest";
import { render, screen, userEvent } from "../../utils/test-utils";
import { Text } from "@/components/inputs/Text";

describe("Text", () => {
	it("should render with label", () => {
		render(<Text value="" onChange={vi.fn()} label="Username" />);
		expect(screen.getByText("Username")).toBeInTheDocument();
	});

	it("should render with value", () => {
		render(<Text value="test value" onChange={vi.fn()} label="Input" />);
		const input = screen.getByRole("textbox");
		expect(input).toHaveValue("test value");
	});

	it("should render with placeholder", () => {
		render(<Text value="" onChange={vi.fn()} placeholder="Enter text..." />);
		expect(screen.getByPlaceholderText("Enter text...")).toBeInTheDocument();
	});

	it("should call onChange when value changes", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();

		render(<Text value="" onChange={onChange} label="Input" />);
		const input = screen.getByRole("textbox");

		await user.type(input, "hello");

		expect(onChange).toHaveBeenCalled();
	});

	it("should be disabled when disabled prop is true", () => {
		render(<Text value="" onChange={vi.fn()} disabled label="Input" />);
		const input = screen.getByRole("textbox");
		expect(input).toBeDisabled();
	});

	it("should show error message", () => {
		render(<Text value="" onChange={vi.fn()} error="This field is required" />);
		expect(screen.getByText("This field is required")).toBeInTheDocument();
	});

	it("should apply error styling to label", () => {
		render(<Text value="" onChange={vi.fn()} label="Input" error="This field is required" />);
		const label = screen.getByText("Input");
		expect(label).toHaveClass("text-red-500");
	});

	it("should apply error styling to input", () => {
		render(<Text value="" onChange={vi.fn()} error="This field is required" />);
		const input = screen.getByRole("textbox");
		expect(input).toHaveClass("border-red-400");
	});

	it("should render as password field", () => {
		render(<Text value="secret" onChange={vi.fn()} type="password" />);
		const input = screen.getByDisplayValue("secret");
		expect(input).toHaveAttribute("type", "password");
	});

	it("should toggle password visibility", async () => {
		const user = userEvent.setup();
		render(<Text value="secret" onChange={vi.fn()} type="password" />);

		const input = screen.getByDisplayValue("secret");
		expect(input).toHaveAttribute("type", "password");

		// Find and click the eye button
		const toggleButton = screen.getByRole("button");
		await user.click(toggleButton);

		expect(input).toHaveAttribute("type", "text");

		await user.click(toggleButton);

		expect(input).toHaveAttribute("type", "password");
	});

	it("should render number input type", () => {
		render(<Text value="" onChange={vi.fn()} type="number" />);
		const input = screen.getByRole("spinbutton");
		expect(input).toHaveAttribute("type", "number");
	});

	it("should apply min and max attributes", () => {
		render(<Text value="" onChange={vi.fn()} type="number" min={0} max={100} />);
		const input = screen.getByRole("spinbutton");
		expect(input).toHaveAttribute("min", "0");
		expect(input).toHaveAttribute("max", "100");
	});

	it("should render email input type", () => {
		render(<Text value="" onChange={vi.fn()} type="email" />);
		const input = screen.getByRole("textbox");
		expect(input).toHaveAttribute("type", "email");
	});

	it("should not show toggle button for non-password fields", () => {
		render(<Text value="" onChange={vi.fn()} type="text" />);
		const toggleButton = screen.queryByRole("button");
		expect(toggleButton).not.toBeInTheDocument();
	});
});
