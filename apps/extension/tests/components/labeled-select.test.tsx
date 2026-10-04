import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LabeledSelect } from "@/components/ui/select";

// The floating label is a bare span, so nothing in the DOM ties it to the trigger; a screen
// reader would otherwise announce the combobox by its current value alone.
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
