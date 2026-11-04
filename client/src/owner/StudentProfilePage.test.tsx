import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { StudentProfile } from "../api/students";
import { jsonResponse, mockFetch } from "../test/fetch";
import { StudentProfilePage } from "./StudentProfilePage";

const place = {
  buildingId: 1,
  buildingName: "Block A",
  floorNumber: 1,
  roomId: 20,
  roomNumber: "101",
  bedId: 30,
  bedNumber: "A",
};

const asha: StudentProfile = {
  id: 7,
  name: "Asha Rao",
  email: "asha@example.com",
  phone: "9876543210",
  parentPhone: "9876500000",
  category: "college",
  collegeName: "City College",
  branch: "CSE",
  academicYear: 2,
  company: null,
  designation: null,
  joiningDate: "2026-01-31",
  foodPreference: "veg",
  vegDays: [],
  monthlyFee: 6500,
  isActive: true,
  deactivatedAt: null,
  mustChangePassword: true,
  currentStay: { id: 2, ...place, startedOn: "2026-01-31", endedOn: null },
  stays: [
    { id: 2, ...place, startedOn: "2026-01-31", endedOn: null },
    {
      id: 1,
      ...place,
      buildingName: "Block B",
      floorNumber: null,
      roomId: null,
      roomNumber: null,
      bedId: null,
      bedNumber: null,
      startedOn: "2025-08-01",
      endedOn: "2026-01-30",
    },
  ],
  nextDueDate: "2026-11-30",
};

function renderProfile(answer: () => Response, id = "7") {
  const requested: string[] = [];
  mockFetch(async (url) => {
    requested.push(url);
    return answer();
  });
  render(
    <MemoryRouter initialEntries={[`/students/${id}`]}>
      <Routes>
        <Route path="/students/:id" element={<StudentProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return requested;
}

// The value next to a label in one of the profile's description lists.
const valueOf = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;

describe("StudentProfilePage", () => {
  it("shows contact, college, stay and fee details", async () => {
    const requested = renderProfile(() => jsonResponse(200, { student: asha }));

    expect(await screen.findByRole("heading", { name: "Asha Rao" })).toBeInTheDocument();
    expect(requested).toEqual(["/api/students/7"]);
    expect(screen.getByText("Has not logged in yet")).toBeInTheDocument();

    expect(valueOf("Email")).toHaveTextContent("asha@example.com");
    expect(valueOf("Mobile")).toHaveTextContent("98765 43210");
    expect(valueOf("Parent or guardian")).toHaveTextContent("98765 00000");
    expect(valueOf("College")).toHaveTextContent("City College");
    expect(valueOf("Branch")).toHaveTextContent("CSE");
    expect(valueOf("Year")).toHaveTextContent("2");
    expect(valueOf("Joined")).toHaveTextContent("31 Jan 2026");
    expect(valueOf("Food")).toHaveTextContent("Veg");
    expect(valueOf("Monthly fee")).toHaveTextContent("₹6,500");
    expect(valueOf("Next due date")).toHaveTextContent("30 Nov 2026");
    expect(valueOf("Lives in")).toHaveTextContent("Block A · Floor 1 · Room 101 · Bed A");

    const history = within(screen.getByRole("list", { name: "Stay history" })).getAllByRole("listitem");
    expect(history).toHaveLength(2);
    expect(history[0]).toHaveTextContent("Block A · Floor 1 · Room 101 · Bed A");
    expect(history[0]).toHaveTextContent("31 Jan 2026 – now");
    expect(history[1]).toHaveTextContent("Block B");
    expect(history[1]).toHaveTextContent("1 Aug 2025 – 30 Jan 2026");
  });

  it("shows a working professional's company, and an unset fee", async () => {
    renderProfile(() =>
      jsonResponse(200, {
        student: {
          ...asha,
          category: "working",
          collegeName: null,
          branch: null,
          academicYear: null,
          company: "Acme",
          designation: null,
          monthlyFee: null,
          mustChangePassword: false,
          foodPreference: "non_veg",
          vegDays: [2, 6],
        },
      }),
    );
    await screen.findByRole("heading", { name: "Asha Rao" });
    expect(valueOf("Company")).toHaveTextContent("Acme");
    expect(valueOf("Designation")).toHaveTextContent("—");
    expect(valueOf("Monthly fee")).toHaveTextContent("Not set");
    expect(valueOf("Food")).toHaveTextContent("Non-Veg (veg on Tue, Sat)");
    expect(screen.queryByText("College", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("Has not logged in yet")).not.toBeInTheDocument();
  });

  it("shows a former student without a place or a due date", async () => {
    renderProfile(() =>
      jsonResponse(200, {
        student: {
          ...asha,
          isActive: false,
          deactivatedAt: "2026-06-30",
          currentStay: null,
          nextDueDate: null,
          stays: [{ ...asha.stays[0], endedOn: "2026-06-30" }],
        },
      }),
    );
    await screen.findByRole("heading", { name: "Asha Rao" });
    expect(screen.getByText("Former student")).toBeInTheDocument();
    expect(valueOf("Lives in")).toHaveTextContent("Left on 30 Jun 2026");
    expect(screen.queryByText("Next due date", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("says so when there is no such student", async () => {
    renderProfile(() =>
      jsonResponse(404, { error: { code: "student_not_found", message: "That student does not exist." } }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("That student does not exist.");
    expect(screen.getByRole("link", { name: /All students/ })).toHaveAttribute("href", "/students");
  });
});
