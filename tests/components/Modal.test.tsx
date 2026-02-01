import { describe, it, expect } from "vitest";
import { render, screen } from "../utils/test-utils";
import { Modal } from "@/components/Modal";
import { AlertTriangle } from "react-feather";

describe("Modal", () => {
	it("should render with title", () => {
		render(<Modal title="Test Modal" Icon={AlertTriangle} />);
		expect(screen.getByText("Test Modal")).toBeInTheDocument();
	});

	it("should render with content", () => {
		render(<Modal title="Test Modal" Icon={AlertTriangle} content="This is the modal content" />);
		expect(screen.getByText("This is the modal content")).toBeInTheDocument();
	});

	it("should render icon", () => {
		const { container } = render(<Modal title="Test Modal" Icon={AlertTriangle} />);
		const icon = container.querySelector(".text-red-800");
		expect(icon).toBeInTheDocument();
	});

	it("should render buttons when provided", () => {
		const buttons = (
			<>
				<button>Cancel</button>
				<button>Confirm</button>
			</>
		);
		render(<Modal title="Test Modal" Icon={AlertTriangle} buttons={buttons} />);
		expect(screen.getByText("Cancel")).toBeInTheDocument();
		expect(screen.getByText("Confirm")).toBeInTheDocument();
	});

	it("should not render buttons section when buttons not provided", () => {
		const { container } = render(<Modal title="Test Modal" Icon={AlertTriangle} />);
		const buttonsContainer = container.querySelector(".bg-neutral-100");
		expect(buttonsContainer).not.toBeInTheDocument();
	});

	it("should render with custom content as ReactNode", () => {
		const customContent = (
			<div>
				<p>Line 1</p>
				<p>Line 2</p>
			</div>
		);
		render(<Modal title="Test Modal" Icon={AlertTriangle} content={customContent} />);
		expect(screen.getByText("Line 1")).toBeInTheDocument();
		expect(screen.getByText("Line 2")).toBeInTheDocument();
	});

	it("should have correct z-index for overlay", () => {
		const { container } = render(<Modal title="Test Modal" Icon={AlertTriangle} />);
		const overlay = container.querySelector(".fixed");
		expect(overlay).toHaveStyle({ zIndex: String(Number.MAX_SAFE_INTEGER) });
	});

	it("should apply animation class", () => {
		const { container } = render(<Modal title="Test Modal" Icon={AlertTriangle} />);
		const modalContent = container.querySelector(".animate-popup");
		expect(modalContent).toBeInTheDocument();
	});

	it("should render audio element", () => {
		const { container } = render(<Modal title="Test Modal" Icon={AlertTriangle} />);
		const audio = container.querySelector("audio");
		expect(audio).toBeInTheDocument();
	});
});
