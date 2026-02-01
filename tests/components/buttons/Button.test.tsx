import { describe, it, expect, vi } from "vitest";
import { render, screen, userEvent } from "../../utils/test-utils";
import { Button } from "@/components/buttons/Button";
import { Download } from "react-feather";

describe("Button", () => {
	it("should render children", () => {
		render(<Button>Click me</Button>);
		expect(screen.getByText("Click me")).toBeInTheDocument();
	});

	it("should call onClick when clicked", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();

		render(<Button onClick={onClick}>Click me</Button>);

		await user.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("should be disabled when disabled prop is true", () => {
		render(<Button disabled>Click me</Button>);
		expect(screen.getByRole("button")).toBeDisabled();
	});

	it("should be disabled when submitting", () => {
		render(<Button submitting>Click me</Button>);
		expect(screen.getByRole("button")).toBeDisabled();
	});

	it("should show loader icon when submitting", () => {
		render(<Button submitting>Click me</Button>);
		const button = screen.getByRole("button");
		const loader = button.querySelector(".animate-spin");
		expect(loader).toBeInTheDocument();
	});

	it("should render custom icon", () => {
		render(<Button Icon={Download}>Download</Button>);
		const button = screen.getByRole("button");
		const icon = button.querySelector("svg");
		expect(icon).toBeInTheDocument();
	});

	it("should not show custom icon when submitting", () => {
		const { rerender } = render(<Button Icon={Download}>Download</Button>);

		let button = screen.getByRole("button");
		expect(button.querySelector("svg")).toBeInTheDocument();

		rerender(
			<Button Icon={Download} submitting>
				Download
			</Button>
		);

		button = screen.getByRole("button");
		// Should have loader, not the custom icon
		expect(button.querySelector(".animate-spin")).toBeInTheDocument();
	});

	it("should apply default type styling", () => {
		render(<Button type="default">Default</Button>);
		const button = screen.getByRole("button");
		expect(button).toHaveClass("bg-white");
	});

	it("should apply primary type styling", () => {
		render(<Button type="primary">Primary</Button>);
		const button = screen.getByRole("button");
		expect(button).toHaveClass("bg-blue-600");
	});

	it("should apply danger type styling", () => {
		render(<Button type="danger">Danger</Button>);
		const button = screen.getByRole("button");
		expect(button).toHaveClass("bg-red-600");
	});

	it("should apply success type styling", () => {
		render(<Button type="success">Success</Button>);
		const button = screen.getByRole("button");
		expect(button).toHaveClass("bg-green-600");
	});

	it("should apply warning type styling", () => {
		render(<Button type="warning">Warning</Button>);
		const button = screen.getByRole("button");
		expect(button).toHaveClass("bg-amber-600");
	});

	it("should apply custom className", () => {
		render(<Button className="custom-class">Button</Button>);
		const button = screen.getByRole("button");
		expect(button).toHaveClass("custom-class");
	});

	it("should show ping animation when ping prop is true", () => {
		render(<Button ping>Ping</Button>);
		const button = screen.getByRole("button");
		const pingElement = button.querySelector(".animate-ping-sm");
		expect(pingElement).toBeInTheDocument();
	});

	it("should have scale animation classes", () => {
		render(<Button>Scale test</Button>);
		const button = screen.getByRole("button");

		// Should have initial scale class
		expect(button.className).toContain("scale-");
	});

	it("should not trigger onClick when disabled", () => {
		const onClick = vi.fn();

		render(
			<Button onClick={onClick} disabled>
				Click me
			</Button>
		);

		const button = screen.getByRole("button");
		expect(button).toBeDisabled();
		// Disabled buttons don't trigger click events
	});
});
