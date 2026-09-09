import { expect } from "vitest";

/** The notice's Details, which must be there, collapsed, and hold `detail`:
 *  every notice carries its technical part behind the disclosure. */
export function expectCollapsedDetails(notice: HTMLElement, detail: string): void {
  const details = notice.querySelector("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(details).toHaveTextContent(detail);
}
