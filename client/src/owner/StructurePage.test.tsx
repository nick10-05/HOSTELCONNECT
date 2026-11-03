import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Building } from "../api/structure";
import { jsonResponse, mockFetch } from "../test/fetch";
import { StructurePage } from "./StructurePage";

// Block A: ground floor (empty), floor 1 with room 101 (bed A occupied, bed B retired),
// and room G1 without a floor.
const blockA: Building = {
  id: 1,
  name: "Block A",
  floors: [
    { id: 10, buildingId: 1, number: 0, rooms: [] },
    {
      id: 11,
      buildingId: 1,
      number: 1,
      rooms: [
        {
          id: 20,
          buildingId: 1,
          floorId: 11,
          roomNumber: "101",
          beds: [
            { id: 30, roomId: 20, bedNumber: "A", isActive: true, occupied: true },
            { id: 31, roomId: 20, bedNumber: "B", isActive: false, occupied: false },
            { id: 32, roomId: 20, bedNumber: "C", isActive: true, occupied: false },
          ],
        },
      ],
    },
  ],
  rooms: [{ id: 21, buildingId: 1, floorId: null, roomNumber: "G1", beds: [] }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

type Call = { method: string; url: string; body: unknown };

// A fake server: GET /api/structure returns `tree`; every change is recorded and
// answered by `onChange` (204 unless it says otherwise).
function fakeServer(tree: Building[], onChange: (call: Call) => Response | undefined = () => undefined) {
  const changes: Call[] = [];
  const fetch = mockFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/structure") return jsonResponse(200, { buildings: tree });
    const call = { method, url, body: init?.body ? JSON.parse(init.body as string) : undefined };
    changes.push(call);
    return onChange(call) ?? new Response(null, { status: 204 });
  });
  const loads = () =>
    fetch.mock.calls.filter(([url, init]) => url === "/api/structure" && (init?.method ?? "GET") === "GET")
      .length;
  return { changes, loads };
}

const building = async (name: string) =>
  within(await screen.findByRole("region", { name }));

describe("StructurePage", () => {
  it("shows buildings, floors, rooms and what each bed is doing", async () => {
    fakeServer([blockA]);
    render(<StructurePage />);
    const a = await building("Block A");

    expect(a.getByRole("heading", { name: "Ground floor" })).toBeInTheDocument();
    expect(a.getByRole("heading", { name: "Floor 1" })).toBeInTheDocument();
    expect(a.getByRole("heading", { name: "No floor" })).toBeInTheDocument();
    expect(a.getByText("Room 101")).toBeInTheDocument();
    expect(a.getByText("Room G1")).toBeInTheDocument();

    const room = within(a.getByRole("list", { name: "Beds in room 101" }));
    expect(room.getByText("Bed A").closest("li")).toHaveTextContent("Occupied");
    expect(room.getByText("Bed B").closest("li")).toHaveTextContent("Retired");
    expect(room.getByText("Bed C").closest("li")).toHaveTextContent("Free");
    // An occupied bed cannot be retired, so the button is not offered.
    expect(room.queryByRole("button", { name: "Retire bed A" })).not.toBeInTheDocument();
  });

  it("says what to do when there are no buildings yet", async () => {
    fakeServer([]);
    render(<StructurePage />);
    expect(await screen.findByText(/no buildings yet/i)).toBeInTheDocument();
  });

  it("adds a building and reloads the tree", async () => {
    const server = fakeServer([]);
    const user = userEvent.setup();
    render(<StructurePage />);

    await user.type(await screen.findByLabelText("New building name"), "  Block B ");
    await user.click(screen.getByRole("button", { name: "Add building" }));

    expect(server.changes).toEqual([{ method: "POST", url: "/api/buildings", body: { name: "Block B" } }]);
    await vi.waitFor(() => expect(server.loads()).toBe(2));
    expect(screen.getByLabelText("New building name")).toHaveValue("");
  });

  it("shows the server's reason when a change is refused", async () => {
    fakeServer([blockA], () =>
      jsonResponse(409, { error: { code: "room_in_use", message: "Students have lived in this room." } }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<StructurePage />);

    await user.click((await building("Block A")).getByRole("button", { name: "Delete room 101" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Students have lived in this room.");
  });

  it("adds a room on a chosen floor or without one", async () => {
    const server = fakeServer([blockA]);
    const user = userEvent.setup();
    render(<StructurePage />);
    const a = await building("Block A");

    await user.type(a.getByLabelText("Room number"), "102");
    await user.selectOptions(a.getByLabelText("On floor"), "Floor 1");
    await user.click(a.getByRole("button", { name: "Add room" }));
    await vi.waitFor(() => expect(server.loads()).toBe(2));

    await user.type(a.getByLabelText("Room number"), "G2");
    await user.selectOptions(a.getByLabelText("On floor"), "No floor");
    await user.click(a.getByRole("button", { name: "Add room" }));
    await vi.waitFor(() => expect(server.loads()).toBe(3));

    expect(server.changes.map((c) => c.body)).toEqual([
      { roomNumber: "102", floorId: 11 },
      { roomNumber: "G2", floorId: null },
    ]);
  });

  it("adds a floor and a bed", async () => {
    const server = fakeServer([blockA]);
    const user = userEvent.setup();
    render(<StructurePage />);
    const a = await building("Block A");

    await user.type(a.getByLabelText("Floor number"), "2");
    await user.click(a.getByRole("button", { name: "Add floor" }));
    await vi.waitFor(() => expect(server.loads()).toBe(2));

    await user.type(a.getByLabelText("New bed in room 101"), "D");
    await user.click(a.getByRole("button", { name: "Add bed to room 101" }));
    await vi.waitFor(() => expect(server.loads()).toBe(3));

    expect(server.changes).toEqual([
      { method: "POST", url: "/api/buildings/1/floors", body: { number: 2 } },
      { method: "POST", url: "/api/rooms/20/beds", body: { bedNumber: "D" } },
    ]);
  });

  it("retires a free bed and brings back a retired one", async () => {
    const server = fakeServer([blockA]);
    const user = userEvent.setup();
    render(<StructurePage />);
    const a = await building("Block A");

    await user.click(a.getByRole("button", { name: "Retire bed C" }));
    await vi.waitFor(() => expect(server.loads()).toBe(2));
    await user.click(a.getByRole("button", { name: "Bring back bed B" }));

    await vi.waitFor(() =>
      expect(server.changes.map((c) => `${c.method} ${c.url}`)).toEqual([
        "POST /api/beds/32/retire",
        "POST /api/beds/31/reactivate",
      ]),
    );
  });

  it("asks before deleting, and does nothing if the owner says no", async () => {
    const server = fakeServer([blockA]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<StructurePage />);

    await user.click((await building("Block A")).getByRole("button", { name: "Delete building Block A" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Block A"));
    expect(server.changes).toEqual([]);

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Delete building Block A" }));
    await vi.waitFor(() => expect(server.changes).toEqual([{ method: "DELETE", url: "/api/buildings/1", body: undefined }]));
  });
});
