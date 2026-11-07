import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Avatar, FilterPanel, initials, ListSkeleton, PageHeader, Pager, Segmented, SelectField } from "./ListParts";

describe("PageHeader", () => {
  it("is the page's main heading, with its line and button", () => {
    render(<PageHeader title="Fees" subtitle="November 2026" action={<button type="button">Add</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Fees" })).toBeInTheDocument();
    expect(screen.getByText("November 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("Pager", () => {
  it("is not shown for a single page", () => {
    render(<Pager page={1} pages={1} onPage={() => {}} />);
    expect(screen.queryByRole("navigation", { name: "Pages" })).not.toBeInTheDocument();
  });

  it("moves a page at a time and stops at both ends", async () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pager page={1} pages={3} onPage={onPage} />);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenLastCalledWith(2);

    rerender(<Pager page={3} pages={3} onPage={onPage} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPage).toHaveBeenLastCalledWith(2);
  });
});

describe("FilterPanel", () => {
  it("opens and closes on a phone, and says how many filters are on", async () => {
    render(
      <FilterPanel active={2}>
        <SelectField label="Building" onChange={() => {}}>
          <option value="">All buildings</option>
        </SelectField>
      </FilterPanel>,
    );
    const toggle = screen.getByRole("button", { name: /^Filters\W+2 on$/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument();
  });
});

describe("SelectField", () => {
  it("reports an empty choice as no filter", async () => {
    const onChange = vi.fn();
    render(
      <SelectField label="Show" value="paid" onChange={onChange}>
        <option value="">All</option>
        <option value="paid">Paid</option>
      </SelectField>,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Show" }), "All");
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

describe("Segmented", () => {
  function Harness() {
    const [value, setValue] = useState<"" | "paid" | "overdue">("");
    return (
      <Segmented
        label="Show"
        value={value}
        onChange={setValue}
        options={[
          ["", "All"],
          ["paid", "Paid"],
          ["overdue", "Overdue"],
        ]}
      />
    );
  }

  it("is a named group of radio buttons with one picked", async () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Overdue" }));
    expect(screen.getByRole("radio", { name: "Overdue" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "All" })).not.toBeChecked();
  });
});

describe("Avatar", () => {
  it("takes the first and last initials", () => {
    expect(initials("Asha Rao")).toBe("AR");
    expect(initials("  divya  m k ")).toBe("DK");
    expect(initials("Chitra")).toBe("C");
    expect(initials("")).toBe("?");
  });

  it("is hidden from screen readers, since the name is written beside it", () => {
    const { container } = render(<Avatar name="Asha Rao" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
    expect(container).toHaveTextContent("AR");
  });
});

describe("ListSkeleton", () => {
  it("says it is loading", () => {
    render(<ListSkeleton label="Loading students…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading students…");
  });
});
