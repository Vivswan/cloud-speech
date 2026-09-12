import { expect } from "vitest";

/** Every notice keeps its technical part behind a collapsed Details disclosure. */
export function expectCollapsedDetails(notice: HTMLElement, detail: string): void {
  const details = notice.querySelector("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(details).toHaveTextContent(detail);
}
