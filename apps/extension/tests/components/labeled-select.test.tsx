import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LabeledSelect } from "@/components/ui/select";

// The floating label is a span tied to the trigger only by aria-labelledby, which the DOM does not
// enforce; without it a screen reader announces the combobox by its current value alone.
describe("LabeledSelect", () => {
  it("the combobox is named by its label", () => {
    render(
      <LabeledSelect
        label="Voice language"
        value="en"
        options={[
          { value: "en", title: "English" },
          { value: "fr", title: "French" },
        ]}
        onChange={() => {}}
      />,
    );
    const combobox = screen.getByRole("combobox", { name: "Voice language" });
    expect(combobox).toHaveTextContent("English");
  });
});
