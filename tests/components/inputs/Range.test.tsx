import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "../../utils/test-utils";
import { Range } from "@/components/inputs/Range";

describe("Range", () => {
	it("should render with label", () => {
		render(<Range value={50} onChange={vi.fn()} label="Volume" />);
		expect(screen.getByText("Volume")).toBeInTheDocument();
	});

	it("should display current value", () => {
		render(<Range value={75} onChange={vi.fn()} label="Speed" />);
		expect(screen.getByText("75")).toBeInTheDocument();
	});

	it("should display unit with value", () => {
		render(<Range value={50} onChange={vi.fn()} label="Speed" unit="%" />);
		expect(screen.getByText("50%")).toBeInTheDocument();
	});

	it("should use default min and max", () => {
		render(<Range value={50} onChange={vi.fn()} label="Test" />);
		const input = screen.getByRole("slider");
		expect(input).toHaveAttribute("min", "0");
		expect(input).toHaveAttribute("max", "100");
	});

	it("should use custom min and max", () => {
		render(<Range value={5} onChange={vi.fn()} label="Test" min={1} max={10} />);
		const input = screen.getByRole("slider");
		expect(input).toHaveAttribute("min", "1");
		expect(input).toHaveAttribute("max", "10");
	});

	it("should use custom step", () => {
		render(<Range value={50} onChange={vi.fn()} label="Test" step={5} />);
		const input = screen.getByRole("slider");
		expect(input).toHaveAttribute("step", "5");
	});

	it("should call onChange with debounced value", async () => {
		const onChange = vi.fn();

		render(<Range value={50} onChange={onChange} label="Test" />);

		// onChange should eventually be called with initial value after debounce (500ms)
		await waitFor(
			() => {
				expect(onChange).toHaveBeenCalled();
			},
			{ timeout: 600 }
		);
	});

	it("should render ticks when provided", () => {
		const ticks = [0, 25, 50, 75, 100];
		render(<Range value={50} onChange={vi.fn()} label="Test" ticks={ticks} />);
		const input = screen.getByRole("slider");
		const list = input.getAttribute("list");
		expect(list).toBeTruthy();

		const datalist = document.getElementById(list!);
		expect(datalist).toBeInTheDocument();
		expect(datalist?.querySelectorAll("option")).toHaveLength(5);
	});

	it("should display current value from props", () => {
		render(<Range value={75} onChange={vi.fn()} label="Test" />);

		// Should display the value passed via props
		expect(screen.getByText("75")).toBeInTheDocument();
	});

	it("should initialize with 0 when no value provided", () => {
		render(<Range onChange={vi.fn()} label="Test" />);
		expect(screen.getByText("0")).toBeInTheDocument();
	});
});
