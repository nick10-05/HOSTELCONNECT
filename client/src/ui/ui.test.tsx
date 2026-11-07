import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, Button, Card, EmptyState, IconTile, Pill, Skeleton } from ".";
import { BellIcon } from "./icons";

describe("Button", () => {
  it("is a plain button by default, so it never submits a form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("can be a submit button and passes other props through", () => {
    render(
      <Button type="submit" variant="strong" disabled>
        Sign in
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Sign in" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toBeDisabled();
  });
});

describe("Alert", () => {
  it("announces errors straight away", () => {
    render(<Alert tone="error">Could not load fees.</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load fees.");
  });

  it("announces other messages politely", () => {
    render(<Alert tone="success">Fee marked as paid.</Alert>);
    expect(screen.getByRole("status")).toHaveTextContent("Fee marked as paid.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Card", () => {
  it("is a named region when it has a title", () => {
    render(<Card title="Fees">₹63,000 collected</Card>);
    const region = screen.getByRole("region", { name: "Fees" });
    expect(region).toHaveTextContent("₹63,000 collected");
    expect(screen.getByRole("heading", { name: "Fees" })).toBeInTheDocument();
  });

  it("is a plain box without a title", () => {
    render(<Card>Just content</Card>);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByText("Just content")).toBeInTheDocument();
  });
});

describe("Pill", () => {
  it("shows its text", () => {
    render(<Pill tone="red">Overdue</Pill>);
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  it("tells screen readers that something is loading", () => {
    render(<Skeleton />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });

  it("can name what is loading", () => {
    render(<Skeleton label="Loading fees…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading fees…");
  });
});

describe("EmptyState", () => {
  it("shows the title, the description and an action", () => {
    render(
      <EmptyState title="No complaints open" description="New ones show up here." action={<a href="/x">Refresh</a>} />,
    );
    expect(screen.getByText("No complaints open")).toBeInTheDocument();
    expect(screen.getByText("New ones show up here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Refresh" })).toBeInTheDocument();
  });
});

describe("IconTile and icons", () => {
  it("are decoration only, hidden from screen readers", () => {
    const { container } = render(
      <IconTile tone="violet">
        <BellIcon />
      </IconTile>,
    );
    const tile = container.firstElementChild!;
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
