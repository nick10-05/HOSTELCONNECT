import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import type { Building } from "../api/structure";
import type { StudentListItem } from "../api/students";
import { jsonResponse, mockFetch } from "../test/fetch";
import { StudentsPage } from "./StudentsPage";

const blockA: Building = {
  id: 1,
  name: "Block A",
  floors: [
    {
      id: 11,
      buildingId: 1,
      number: 1,
      rooms: [{ id: 20, buildingId: 1, floorId: 11, roomNumber: "101", beds: [] }],
    },
  ],
  rooms: [],
};

const asha: StudentListItem = {
  id: 7,
  name: "Asha Rao",
  email: "asha@example.com",
  category: "college",
  joiningDate: "2026-01-31",
  isActive: true,
  place: {
    buildingId: 1,
    buildingName: "Block A",
    floorNumber: 1,
    roomId: 20,
    roomNumber: "101",
    bedId: 30,
    bedNumber: "A",
  },
};
const ravi: StudentListItem = {
  id: 8,
  name: "Ravi Kumar",
  email: "ravi@example.com",
  category: "working",
  joiningDate: "2026-11-01",
  isActive: true,
  place: { ...asha.place!, floorNumber: null, roomId: null, roomNumber: null, bedId: null, bedNumber: null },
};
const esha: StudentListItem = { ...asha, id: 9, name: "Esha Former", isActive: false, place: null };

// A fake server: the structure for the filters, and a directory answered by `page`.
function fakeServer(page: (query: URLSearchParams) => { items: StudentListItem[]; total: number }) {
  const queries: URLSearchParams[] = [];
  mockFetch(async (url) => {
    if (url === "/api/structure") return jsonResponse(200, { buildings: [blockA] });
    if (url.startsWith("/api/students")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      queries.push(query);
      return jsonResponse(200, page(query));
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  // What the last directory request asked for, as a plain object.
  const last = () => Object.fromEntries(queries[queries.length - 1]);
  return { queries, last };
}

// Shows the page's address, so tests can check that filters live in the URL.
function Address() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="address">{location.pathname + location.search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Go back
      </button>
    </>
  );
}

function renderAt(path = "/students") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/students/:id" element={<p>Profile page</p>} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
  return user;
}

const address = () => screen.getByRole("status", { name: "address" }).textContent;
const rows = () => within(screen.getByRole("list", { name: "Students" })).getAllByRole("listitem");

describe("StudentsPage", () => {
  it("lists current students with where they live, and links to each profile", async () => {
    const server = fakeServer(() => ({ items: [asha, ravi], total: 2 }));
    const user = renderAt();

    expect(await screen.findByText("2 students")).toBeInTheDocument();
    expect(server.last()).toEqual({});
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("Asha Rao");
    expect(rows()[0]).toHaveTextContent("asha@example.com");
    expect(rows()[0]).toHaveTextContent("Block A · Room 101 · Bed A");
    expect(rows()[0]).toHaveTextContent("College student");
    expect(rows()[1]).toHaveTextContent("Block A · No room yet");

    await user.click(screen.getByRole("link", { name: "Asha Rao" }));
    expect(await screen.findByText("Profile page")).toBeInTheDocument();
    expect(address()).toBe("/students/7");
  });

  it("searches when the owner submits, and keeps the search in the address", async () => {
    const server = fakeServer(() => ({ items: [asha], total: 1 }));
    const user = renderAt();
    await screen.findByText("1 student");

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "asha");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(address()).toBe("/students?search=asha");
    expect(server.last()).toEqual({ search: "asha" });
  });

  it("filters by building, floor, room, category and status straight away", async () => {
    const server = fakeServer(() => ({ items: [esha], total: 1 }));
    const user = renderAt();
    await screen.findByText("1 student");

    // Floor and room filters appear only once a building with them is chosen.
    expect(screen.queryByRole("combobox", { name: "Floor" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Building" }), "Block A");
    await user.selectOptions(screen.getByRole("combobox", { name: "Floor" }), "Floor 1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Room" }), "101");
    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "College student");
    await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "Former students");

    expect(server.last()).toEqual({
      buildingId: "1",
      floorId: "11",
      roomId: "20",
      category: "college",
      status: "former",
    });
    expect(address()).toContain("status=former");
    expect(await screen.findByText("Left the hostel")).toBeInTheDocument();
  });

  it("forgets the floor and room when the building changes", async () => {
    const server = fakeServer(() => ({ items: [], total: 0 }));
    const user = renderAt("/students?buildingId=1&floorId=11&roomId=20");
    await screen.findByText("No students match these filters.");

    await user.selectOptions(screen.getByRole("combobox", { name: "Building" }), "All buildings");
    expect(server.last()).toEqual({});
  });

  it("shows the address's search again after going back", async () => {
    fakeServer(() => ({ items: [asha], total: 1 }));
    const user = renderAt("/students?search=asha");
    await screen.findByText("1 student");

    const box = screen.getByRole("searchbox", { name: "Search" });
    await user.clear(box);
    await user.type(box, "nobody");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(address()).toBe("/students?search=nobody");

    // The browser's Back button.
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(address()).toBe("/students?search=asha");
    expect(box).toHaveValue("asha");
  });

  it("starts from the filters in the address", async () => {
    const server = fakeServer(() => ({ items: [asha], total: 1 }));
    renderAt("/students?search=asha&category=college&page=1");
    await screen.findByText("1 student");
    expect(server.last()).toEqual({ search: "asha", category: "college", page: "1" });
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("asha");
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("college");
  });

  it("pages through 20 students at a time and goes back to page 1 when a filter changes", async () => {
    const server = fakeServer(() => ({ items: [asha], total: 45 }));
    const user = renderAt();
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    expect(server.last()).toEqual({ page: "2" });

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "Other");
    expect(server.last()).toEqual({ category: "other" });
  });

  it("says when there are no students yet, and when the filters match nobody", async () => {
    fakeServer(() => ({ items: [], total: 0 }));
    renderAt();
    expect(await screen.findByText(/No students yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Admit a student" })).toHaveAttribute("href", "/students/new");
  });
});
