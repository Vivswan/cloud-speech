import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, userEvent, waitFor } from "../../utils/test-utils";
import { Dropdown } from "@/components/inputs/Dropdown";

const mockOptions = [
	{ value: "option1", title: "Option 1", description: "First option" },
	{ value: "option2", title: "Option 2", description: "Second option" },
	{ value: "option3", title: "Option 3", description: "Third option" },
];

describe("Dropdown", () => {
	beforeEach(() => {
		// Mock getBoundingClientRect for position calculations
		window.Element.prototype.getBoundingClientRect = vi.fn(() => ({
			top: 100,
			left: 100,
			height: 40,
			width: 200,
			bottom: 140,
			right: 300,
			x: 100,
			y: 100,
			toJSON: () => {},
		}));
	});

	it("should render with value", () => {
		render(<Dropdown value="option1" onChange={vi.fn()} options={mockOptions} />);
		expect(screen.getByDisplayValue("Option 1")).toBeInTheDocument();
	});

	it("should show placeholder when no value", () => {
		render(<Dropdown value="" onChange={vi.fn()} options={mockOptions} placeholder="Select an option" />);
		expect(screen.getByPlaceholderText("Select an option")).toBeInTheDocument();
	});

	it("should show label", () => {
		render(<Dropdown value="option1" onChange={vi.fn()} options={mockOptions} label="My Dropdown" />);
		expect(screen.getByText("My Dropdown")).toBeInTheDocument();
	});

	it("should open dropdown on click", async () => {
		const user = userEvent.setup();
		render(<Dropdown value="option1" onChange={vi.fn()} options={mockOptions} />);

		const input = screen.getByDisplayValue("Option 1");
		await user.click(input);

		// Options with descriptions should be visible in dropdown
		await waitFor(() => {
			expect(screen.getByText("First option")).toBeInTheDocument();
			expect(screen.getByText("Second option")).toBeInTheDocument();
			expect(screen.getByText("Third option")).toBeInTheDocument();
		});
	});

	it("should call onChange when option is selected", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();

		render(<Dropdown value="option1" onChange={onChange} options={mockOptions} />);

		const input = screen.getByDisplayValue("Option 1");
		await user.click(input);

		const option2 = screen.getByText("Second option");
		await user.click(option2);

		expect(onChange).toHaveBeenCalled();
	});

	it("should filter options when typing", async () => {
		const user = userEvent.setup();
		render(<Dropdown value="" onChange={vi.fn()} options={mockOptions} />);

		const input = screen.getByRole("textbox");
		await user.click(input);
		await user.clear(input);
		await user.type(input, "Option 2");

		// Should show filtered results
		await waitFor(() => {
			expect(screen.getByText("Second option")).toBeInTheDocument();
		});
	});

	it('should show "No results found" when no matches', async () => {
		const user = userEvent.setup();
		render(<Dropdown value="" onChange={vi.fn()} options={mockOptions} />);

		const input = screen.getByRole("textbox");
		await user.click(input);
		await user.clear(input);
		await user.type(input, "nonexistent");

		await waitFor(() => {
			expect(screen.getByText("No results found")).toBeInTheDocument();
		});
	});

	it("should be disabled when disabled prop is true", () => {
		render(<Dropdown value="option1" onChange={vi.fn()} options={mockOptions} disabled />);
		const input = screen.getByRole("textbox");
		expect(input).toBeDisabled();
	});

	it("should handle Escape key", async () => {
		const user = userEvent.setup();
		render(<Dropdown value="option1" onChange={vi.fn()} options={mockOptions} />);

		const input = screen.getByDisplayValue("Option 1");
		await user.click(input);

		// Dropdown descriptions should be visible when open
		await waitFor(() => {
			expect(screen.getByText("First option")).toBeInTheDocument();
		});

		// Press Escape
		await user.keyboard("{Escape}");

		// Input should still exist
		expect(screen.getByDisplayValue("Option 1")).toBeInTheDocument();
	});

	it("should select option with Enter key", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();

		render(<Dropdown value="option1" onChange={onChange} options={mockOptions} />);

		const input = screen.getByDisplayValue("Option 1");
		await user.click(input);
		await user.keyboard("{ArrowDown}");
		await user.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalled();
	});

	it("should navigate with arrow keys", async () => {
		const user = userEvent.setup();
		render(<Dropdown value="option1" onChange={vi.fn()} options={mockOptions} />);

		const input = screen.getByDisplayValue("Option 1");
		await user.click(input);

		// Navigate down
		await user.keyboard("{ArrowDown}");
		await user.keyboard("{ArrowDown}");

		// Navigate up
		await user.keyboard("{ArrowUp}");

		// Should still have options visible
		expect(screen.getByText("Second option")).toBeInTheDocument();
	});
});
