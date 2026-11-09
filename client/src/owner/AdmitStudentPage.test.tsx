import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Building } from "../api/structure";
import { jsonResponse, mockFetch } from "../test/fetch";
import { AdmitStudentPage } from "./AdmitStudentPage";

// Block A: floor 1 with room 101 (bed A occupied, bed B retired, bed C free) and room G1
// without a floor or beds. Block B: nothing below the building yet.
const blockA: Building = {
  id: 1,
  name: "Block A",
  floors: [
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
const blockB: Building = { id: 2, name: "Block B", floors: [], rooms: [] };

const admission = {
  student: {
    id: 7,
    name: "Asha Rao",
    email: "asha@example.com",
    joiningDate: "2026-11-01",
    buildingId: 1,
    roomId: 20,
    bedId: 32,
  },
  temporaryPassword: "ABCD234567",
};

// A fake server: GET /api/structure returns `tree`; POST /api/students is recorded and
// answered by `onAdmit` (the admission above unless it says otherwise).
function fakeServer(tree: Building[], onAdmit: () => Response = () => jsonResponse(201, admission)) {
  const posts: unknown[] = [];
  mockFetch(async (url, init) => {
    if (url === "/api/structure") return jsonResponse(200, { buildings: tree });
    if (url === "/api/students" && init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return onAdmit();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  return { posts };
}

function renderPage() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <AdmitStudentPage />
    </MemoryRouter>,
  );
  return user;
}

const field = (label: RegExp | string) => screen.getByLabelText(label);

// Fills in a valid college student in Block A with no room.
async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(field("Full name"), "Asha Rao");
  await user.type(field("Email"), "asha@example.com");
  await user.type(field("Mobile number"), "98765 43210");
  await user.type(field("Parent or guardian mobile"), "9876500000");
  await user.selectOptions(field("Category"), "college");
  await user.type(field("College"), "City College");
  await user.type(field("Branch"), "CSE");
  await user.selectOptions(field("Year"), "2");
  await user.clear(field("Joining date"));
  await user.type(field("Joining date"), "2026-11-01");
  await user.click(screen.getByRole("radio", { name: "Veg" }));
  await user.type(field(/Monthly fee/), "6500");
  await user.selectOptions(field("Building"), "Block A");
}

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("AdmitStudentPage", () => {
  it("admits a student and shows the temporary password once, with a copy button", async () => {
    const { posts } = fakeServer([blockA, blockB]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Admit student" }));

    expect(await screen.findByRole("heading", { name: "Student admitted" })).toBeInTheDocument();
    expect(posts).toEqual([
      {
        name: "Asha Rao",
        email: "asha@example.com",
        phone: "9876543210",
        parentPhone: "9876500000",
        category: "college",
        collegeName: "City College",
        branch: "CSE",
        academicYear: 2,
        joiningDate: "2026-11-01",
        foodPreference: "veg",
        monthlyFee: 6500,
        buildingId: 1,
        roomId: null,
        bedId: null,
      },
    ]);
    expect(screen.getByText("ABCD234567")).toBeInTheDocument();
    expect(screen.getByText(/shown only now/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy password" }));
    expect(await navigator.clipboard.readText()).toBe("ABCD234567");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View profile" })).toHaveAttribute("href", "/students/7");

    // Starting the next admission forgets the password and shows an empty form.
    await user.click(screen.getByRole("button", { name: "Admit another student" }));
    expect(screen.queryByText("ABCD234567")).not.toBeInTheDocument();
    expect(field("Full name")).toHaveValue("");
  });

  it("asks a non-veg student's veg days and sends them", async () => {
    const { posts } = fakeServer([blockA]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    await fillValidForm(user);
    expect(screen.queryByRole("checkbox", { name: "Tue" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Non-Veg" }));
    await user.click(screen.getByRole("checkbox", { name: "Sat" }));
    await user.click(screen.getByRole("checkbox", { name: "Tue" }));
    await user.click(screen.getByRole("button", { name: "Admit student" }));

    await screen.findByRole("heading", { name: "Student admitted" });
    expect(posts[0]).toMatchObject({ foodPreference: "non_veg", vegDays: [2, 6] });
  });

  // Phase 5b: the owner confirms a guardian's consent before adding a student under 18.
  it("asks for the guardian's consent for a student under 18, and sends both", async () => {
    const { posts } = fakeServer([blockA]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });
    await fillValidForm(user);

    const consent = /parent's or guardian's consent/;
    expect(screen.queryByRole("checkbox", { name: consent })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Under 18" }));
    await user.click(screen.getByRole("button", { name: "Admit student" }));
    expect(screen.getByRole("checkbox", { name: consent })).toHaveAccessibleDescription(
      "Confirm you have a parent's or guardian's consent.",
    );
    expect(posts).toEqual([]);

    await user.click(screen.getByRole("checkbox", { name: consent }));
    expect(screen.getByRole("checkbox", { name: consent })).not.toHaveAccessibleDescription();
    await user.click(screen.getByRole("button", { name: "Admit student" }));
    await screen.findByRole("heading", { name: "Student admitted" });
    expect(posts[0]).toMatchObject({ under18: true, guardianConsent: true });
  });

  it("shows the college fields for a college student and the company fields for a working one", async () => {
    fakeServer([blockA]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    expect(screen.queryByLabelText("College")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();

    await user.selectOptions(field("Category"), "college");
    expect(field("College")).toBeInTheDocument();
    expect(field("Branch")).toBeInTheDocument();
    expect(field("Year")).toBeInTheDocument();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();

    await user.selectOptions(field("Category"), "working");
    expect(field("Company")).toBeInTheDocument();
    expect(field(/Designation/)).toBeInTheDocument();
    expect(screen.queryByLabelText("College")).not.toBeInTheDocument();

    await user.selectOptions(field("Category"), "other");
    expect(screen.queryByLabelText("College")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();
  });

  it("offers rooms and beds only where the owner has built them, and never a taken or retired bed", async () => {
    fakeServer([blockA, blockB]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    // No building chosen yet: no room picker.
    expect(screen.queryByLabelText(/Room/)).not.toBeInTheDocument();

    // Block B has no rooms: still no room picker.
    await user.selectOptions(field("Building"), "Block B");
    expect(screen.queryByLabelText(/Room/)).not.toBeInTheDocument();

    await user.selectOptions(field("Building"), "Block A");
    const room = field(/Room/);
    expect(optionLabels(room)).toEqual(["No room yet", "101 · Floor 1", "G1"]);

    // G1 has no beds: no bed picker.
    await user.selectOptions(room, "G1");
    expect(screen.queryByLabelText(/Bed/)).not.toBeInTheDocument();

    await user.selectOptions(room, "101 · Floor 1");
    const bed = field(/Bed/);
    expect(optionLabels(bed)).toEqual(["No bed yet", "A (occupied)", "B (retired)", "C"]);
    expect(screen.getByRole("option", { name: "A (occupied)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "B (retired)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "C" })).toBeEnabled();
  });

  it("sends the chosen room and bed, and forgets them when the building changes", async () => {
    const { posts } = fakeServer([blockA, blockB]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    await fillValidForm(user);
    await user.selectOptions(field(/Room/), "101 · Floor 1");
    await user.selectOptions(field(/Bed/), "C");

    // Switching building and back clears room and bed.
    await user.selectOptions(field("Building"), "Block B");
    await user.selectOptions(field("Building"), "Block A");
    expect(field(/Room/)).toHaveValue("");

    await user.selectOptions(field(/Room/), "101 · Floor 1");
    await user.selectOptions(field(/Bed/), "C");
    await user.click(screen.getByRole("button", { name: "Admit student" }));

    await screen.findByRole("heading", { name: "Student admitted" });
    expect(posts[0]).toMatchObject({ buildingId: 1, roomId: 20, bedId: 32 });
  });

  it("points out mistakes next to each field and sends nothing", async () => {
    const { posts } = fakeServer([blockA]);
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    await user.type(field("Mobile number"), "12345");
    await user.click(screen.getByRole("button", { name: "Admit student" }));

    expect(field("Full name")).toHaveAccessibleDescription("Required.");
    expect(field("Full name")).toHaveAttribute("aria-invalid", "true");
    expect(field("Mobile number")).toHaveAccessibleDescription("Enter a 10-digit mobile number.");
    expect(field("Building")).toHaveAccessibleDescription("Choose a building.");
    expect(posts).toHaveLength(0);
  });

  it("shows the server's refusal and keeps what the owner typed", async () => {
    fakeServer([blockA], () =>
      jsonResponse(409, { error: { code: "bed_occupied", message: "That bed already has a student." } }),
    );
    const user = renderPage();
    await screen.findByRole("option", { name: "Block A" });

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Admit student" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That bed already has a student.");
    expect(field("Full name")).toHaveValue("Asha Rao");
    expect(screen.queryByRole("heading", { name: "Student admitted" })).not.toBeInTheDocument();
  });

  it("asks for a building first when there is none", async () => {
    fakeServer([]);
    renderPage();
    expect(await screen.findByText(/add a building first/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buildings and rooms" })).toHaveAttribute("href", "/structure");
    expect(screen.queryByRole("button", { name: "Admit student" })).not.toBeInTheDocument();
  });
});
