import { render, RenderOptions } from "@testing-library/react";
import { ReactElement } from "react";
import { BrowserRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";

/**
 * Custom render function that wraps components with Router context
 */
export function renderWithRouter(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
	return render(ui, {
		wrapper: ({ children }) => <BrowserRouter>{children}</BrowserRouter>,
		...options,
	});
}

// Re-export everything from @testing-library/react
export * from "@testing-library/react";

// Export userEvent for interaction testing
export { userEvent };
