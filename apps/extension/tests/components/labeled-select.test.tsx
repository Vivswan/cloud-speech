import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LabeledSelect } from "@/components/ui/select";

// The floating label is a span tied to the trigger only by aria-labelledby, which the DOM does not
// enforce. A combobox takes no name from its content, so without it the name is empty.
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
