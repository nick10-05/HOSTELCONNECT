import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { Building } from "../api/structure";
import type { StudentProfile } from "../api/students";
import { jsonResponse, mockFetch } from "../test/fetch";
import { addDays, hostelToday } from "./admissionForm";
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
  under18: false,
  guardianConsent: null,
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
    expect(screen.getByText("Must change password")).toBeInTheDocument();

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
    expect(screen.queryByText("Must change password")).not.toBeInTheDocument();
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

// ---- Transfer ----

// Block A: floor 1 with room 101 (bed A is Asha's, bed B retired, bed C free) and room G1
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

// A fake server: GET /api/students/7 answers each profile in turn (the last one again
// after that; a null fails with 500), GET /api/structure answers each tree in turn the
// same way (the two blocks by default), and POST .../transfer is recorded and answered
// by `onTransfer`.
function transferServer(
  profiles: (StudentProfile | null)[],
  onTransfer: () => Response,
  trees: (Building[] | null)[] = [[blockA, blockB]],
) {
  const posts: unknown[] = [];
  let profileCalls = 0;
  let structureCalls = 0;
  const failure = () => jsonResponse(500, { error: { code: "internal", message: "The server had a problem." } });
  mockFetch(async (url, init) => {
    if (url === "/api/students/7" && init?.method !== "POST") {
      const student = profiles[Math.min(profileCalls, profiles.length - 1)];
      profileCalls += 1;
      return student ? jsonResponse(200, { student }) : failure();
    }
    if (url === "/api/structure") {
      const buildings = trees[Math.min(structureCalls, trees.length - 1)];
      structureCalls += 1;
      return buildings ? jsonResponse(200, { buildings }) : failure();
    }
    if (url === "/api/students/7/transfer" && init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return onTransfer();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/students/7"]}>
      <Routes>
        <Route path="/students/:id" element={<StudentProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user, posts, profileCalls: () => profileCalls, structureCalls: () => structureCalls };
}

const field = (label: RegExp | string) => screen.getByLabelText(label);
const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);

// Asha after moving to bed C today.
const inBedC: StudentProfile = {
  ...asha,
  currentStay: { ...asha.currentStay!, id: 3, bedId: 32, bedNumber: "C", startedOn: "2026-11-04" },
  stays: [
    { ...asha.currentStay!, id: 3, bedId: 32, bedNumber: "C", startedOn: "2026-11-04" },
    { ...asha.stays[0], endedOn: "2026-11-04" },
    asha.stays[1],
  ],
};

// A student who joins on 1 Dec 2099: the stay has not started.
const notYetJoined: StudentProfile = {
  ...asha,
  joiningDate: "2099-12-01",
  currentStay: { ...asha.currentStay!, startedOn: "2099-12-01" },
  stays: [{ ...asha.currentStay!, startedOn: "2099-12-01" }],
};

describe("transfer on the profile", () => {
  it("offers a transfer to a current student", async () => {
    transferServer([asha], () => jsonResponse(500, {}));
    expect(await screen.findByRole("button", { name: "Transfer" })).toBeInTheDocument();
  });

  it("offers nothing to a former student", async () => {
    transferServer(
      [{ ...asha, isActive: false, deactivatedAt: "2026-06-30", currentStay: null, nextDueDate: null }],
      () => jsonResponse(500, {}),
    );
    await screen.findByRole("heading", { name: "Asha Rao" });
    expect(screen.queryByRole("button", { name: "Transfer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change room or bed" })).not.toBeInTheDocument();
  });

  it("starts at the current place, marks the current bed, and waits for a different choice", async () => {
    const { user } = transferServer([asha], () => jsonResponse(500, {}));
    await user.click(await screen.findByRole("button", { name: "Transfer" }));

    expect(await screen.findByLabelText("Building")).toHaveValue("1");
    expect(field(/Room/)).toHaveValue("20");
    expect(field(/Bed/)).toHaveValue("30");
    expect(optionLabels(field(/Bed/))).toEqual(["No bed yet", "A (current)", "B (retired)", "C"]);
    expect(screen.getByRole("option", { name: "A (current)" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "B (retired)" })).toBeDisabled();
    expect(screen.getByText("The current stay ends today and the new one starts today.")).toBeInTheDocument();

    // Nothing to send while the choice is where the student already lives.
    const submit = screen.getByRole("button", { name: "Transfer student" });
    expect(submit).toBeDisabled();
    await user.selectOptions(field(/Bed/), "C");
    expect(submit).toBeEnabled();
  });

  it("transfers, reloads the profile and says what happened", async () => {
    const { user, posts, profileCalls } = transferServer([asha, inBedC], () =>
      jsonResponse(200, {
        transfer: { kind: "transferred", id: 3, buildingId: 1, roomId: 20, bedId: 32, startedOn: "2026-11-04" },
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    await user.selectOptions(await screen.findByLabelText(/Bed/), "C");
    await user.click(screen.getByRole("button", { name: "Transfer student" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Transferred. The new stay starts today.");
    expect(posts).toEqual([{ buildingId: 1, roomId: 20, bedId: 32 }]);
    expect(profileCalls()).toBe(2);
    expect(valueOf("Lives in")).toHaveTextContent("Block A · Floor 1 · Room 101 · Bed C");
    expect(within(screen.getByRole("list", { name: "Stay history" })).getAllByRole("listitem")).toHaveLength(3);
    // The form has closed.
    expect(screen.queryByRole("button", { name: "Transfer student" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the form open", async () => {
    const { user } = transferServer([asha], () =>
      jsonResponse(409, { error: { code: "bed_occupied", message: "The selected bed is already occupied." } }),
    );
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    await user.selectOptions(await screen.findByLabelText(/Bed/), "C");
    await user.click(screen.getByRole("button", { name: "Transfer student" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The selected bed is already occupied.");
    expect(screen.getByRole("button", { name: "Transfer student" })).toBeEnabled();
  });

  it("after a refusal, reloads the beds and lets go of one that has just been taken", async () => {
    // Between opening the form and sending it, someone else took bed C.
    const cTaken: Building = structuredClone(blockA);
    cTaken.floors[0].rooms[0].beds[2].occupied = true;
    const { user, structureCalls } = transferServer(
      [asha],
      () => jsonResponse(409, { error: { code: "bed_occupied", message: "The selected bed is already occupied." } }),
      [[blockA, blockB], [cTaken, blockB]],
    );
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    await user.selectOptions(await screen.findByLabelText(/Bed/), "C");
    await user.click(screen.getByRole("button", { name: "Transfer student" }));

    expect(await screen.findByRole("option", { name: "C (occupied)" })).toBeDisabled();
    expect(structureCalls()).toBe(2);
    expect(field(/Bed/)).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("The selected bed is already occupied.");
  });

  it("can still be cancelled when the buildings cannot be loaded", async () => {
    const { user } = transferServer([asha], () => jsonResponse(500, {}), [null]);
    await user.click(await screen.findByRole("button", { name: "Transfer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The server had a problem.");
    expect(screen.queryByLabelText("Building")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Transfer" })).toBeInTheDocument();
  });

  it("keeps the profile and says the transfer was saved when the reload fails", async () => {
    const { user } = transferServer([asha, null], () =>
      jsonResponse(200, {
        transfer: { kind: "transferred", id: 3, buildingId: 1, roomId: 20, bedId: 32, startedOn: "2026-11-04" },
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    await user.selectOptions(await screen.findByLabelText(/Bed/), "C");
    await user.click(screen.getByRole("button", { name: "Transfer student" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Transferred. The new stay starts today.");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page could not be refreshed: The server had a problem. Reload the page to see the new stay.",
    );
    expect(screen.getByRole("heading", { name: "Asha Rao" })).toBeInTheDocument();
  });

  it("closes the form on Cancel without sending anything", async () => {
    const { user, posts } = transferServer([asha], () => jsonResponse(500, {}));
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Building")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transfer" })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("is offered next to Move out, and both hide while the form is open", async () => {
    const { user } = transferServer([asha], () => jsonResponse(500, {}));
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    expect(screen.queryByRole("button", { name: "Move out" })).not.toBeInTheDocument();
  });

  it("changes the room or bed of a student who has not joined yet, without history", async () => {
    const { user, posts } = transferServer([notYetJoined], () =>
      jsonResponse(200, {
        transfer: { kind: "reassigned", id: 2, buildingId: 2, roomId: null, bedId: null, startedOn: "2099-12-01" },
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Change room or bed" }));
    expect(
      await screen.findByText("Joins on 1 Dec 2099: this only changes the assignment, no history is kept."),
    ).toBeInTheDocument();

    // A new building forgets the room and bed.
    await user.selectOptions(field("Building"), "Block B");
    expect(screen.queryByLabelText(/Room/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save new room or bed" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Room and bed changed. The stay still starts on 1 Dec 2099.",
    );
    expect(posts).toEqual([{ buildingId: 2, roomId: null, bedId: null }]);
  });
});

// ---- Moving out and coming back ----

// Asha after moving out on 30 Jun 2026.
const formerAsha: StudentProfile = {
  ...asha,
  isActive: false,
  deactivatedAt: "2026-06-30",
  mustChangePassword: false,
  currentStay: null,
  nextDueDate: null,
  stays: [{ ...asha.stays[0], endedOn: "2026-06-30" }, asha.stays[1]],
};

// A fake server for the profile's actions: GET /api/students/7 answers each profile in
// turn (the last one again after that), GET /api/structure the two blocks, and each POST
// to /api/students/7/<action> is recorded and answered by answers[action].
function actionServer(profiles: StudentProfile[], answers: Record<string, () => Response>) {
  const posts: { action: string; body: unknown }[] = [];
  let profileCalls = 0;
  let requests = 0;
  mockFetch(async (url, init) => {
    requests += 1;
    // Editing is a PATCH to the profile's own address, recorded as the action "edit".
    if (url === "/api/students/7" && init?.method === "PATCH" && answers.edit) {
      posts.push({ action: "edit", body: JSON.parse(init.body as string) });
      return answers.edit();
    }
    if (url === "/api/students/7" && init?.method !== "POST") {
      const student = profiles[Math.min(profileCalls, profiles.length - 1)];
      profileCalls += 1;
      return jsonResponse(200, { student });
    }
    if (url === "/api/structure") return jsonResponse(200, { buildings: [blockA, blockB] });
    const action = url.match(/^\/api\/students\/7\/([\w-]+)$/)?.[1];
    if (action && init?.method === "POST" && answers[action]) {
      posts.push({ action, body: init.body ? JSON.parse(init.body as string) : undefined });
      return answers[action]();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/students/7"]}>
      <Routes>
        <Route path="/students/:id" element={<StudentProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user, posts, profileCalls: () => profileCalls, requestCount: () => requests };
}

const noContent = () => new Response(null, { status: 204 });

describe("moving out", () => {
  it("asks first, and Cancel sends nothing", async () => {
    const { user, posts } = actionServer([asha], { deactivate: noContent });
    await user.click(await screen.findByRole("button", { name: "Move out" }));

    expect(
      screen.getByText("Move out Asha Rao? They will no longer be able to log in, and their stay ends today."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Move out" })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("says the booking is cancelled for a student who has not joined yet", async () => {
    const { user } = actionServer([notYetJoined], { deactivate: noContent });
    await user.click(await screen.findByRole("button", { name: "Move out" }));

    expect(
      screen.getByText(
        "Move out Asha Rao? They will no longer be able to log in, and their booking for 1 Dec 2099 is cancelled.",
      ),
    ).toBeInTheDocument();
  });

  it("moves the student out and shows them as a former student", async () => {
    const { user, posts, profileCalls } = actionServer([asha, formerAsha], { deactivate: noContent });
    await user.click(await screen.findByRole("button", { name: "Move out" }));
    await user.click(screen.getByRole("button", { name: "Yes, move out" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Moved out. Asha Rao can no longer log in.");
    expect(posts).toEqual([{ action: "deactivate", body: undefined }]);
    expect(profileCalls()).toBe(2);
    expect(screen.getByText("Former student")).toBeInTheDocument();
    expect(valueOf("Lives in")).toHaveTextContent("Left on 30 Jun 2026");
    expect(screen.queryByRole("button", { name: "Transfer" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    const { user } = actionServer([asha], {
      deactivate: () =>
        jsonResponse(409, { error: { code: "student_inactive", message: "This student has already moved out." } }),
    });
    await user.click(await screen.findByRole("button", { name: "Move out" }));
    await user.click(screen.getByRole("button", { name: "Yes, move out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This student has already moved out.");
    expect(screen.getByRole("button", { name: "Yes, move out" })).toBeEnabled();
  });
});

describe("reactivating", () => {
  const admitted = {
    student: { id: 7, name: "Asha Rao", email: "asha@example.com", joiningDate: hostelToday(), buildingId: 1, roomId: 20, bedId: 32 },
    temporaryPassword: "ABCD234567",
  };
  const backInBedC: StudentProfile = { ...inBedC, joiningDate: hostelToday() };

  it("is offered to a former student only, starting today with no building chosen", async () => {
    const { user } = actionServer([formerAsha], {});
    await user.click(await screen.findByRole("button", { name: "Reactivate" }));

    expect(screen.queryByRole("button", { name: "Move out" })).not.toBeInTheDocument();
    expect(field("Joining date")).toHaveValue(hostelToday());
    expect(await screen.findByLabelText("Building")).toHaveValue("");
    expect(
      screen.getByText("Left on 30 Jun 2026. The new joining date can be that day or later, up to 30 days from today."),
    ).toBeInTheDocument();
  });

  it("checks the date and the building before sending anything", async () => {
    const { user, posts } = actionServer([formerAsha], {});
    await user.click(await screen.findByRole("button", { name: "Reactivate" }));
    await screen.findByLabelText("Building");
    const submit = screen.getByRole("button", { name: "Reactivate student" });

    await user.click(submit);
    expect(field("Building")).toHaveAccessibleDescription("Choose a building.");

    await user.selectOptions(field("Building"), "Block B");
    await user.clear(field("Joining date"));
    await user.type(field("Joining date"), "2026-06-29");
    await user.click(submit);
    expect(field("Joining date")).toHaveAccessibleDescription("Choose 30 Jun 2026 or later, the day they left.");

    await user.clear(field("Joining date"));
    await user.type(field("Joining date"), addDays(hostelToday(), 31));
    await user.click(submit);
    expect(field("Joining date")).toHaveAccessibleDescription("Choose a date at most 30 days from today.");

    expect(posts).toEqual([]);
  });

  it("reactivates, shows the temporary password once, and forgets it on Done", async () => {
    const { user, posts, profileCalls } = actionServer([formerAsha, backInBedC], {
      reactivate: () => jsonResponse(200, admitted),
    });
    await user.click(await screen.findByRole("button", { name: "Reactivate" }));
    await user.selectOptions(await screen.findByLabelText("Building"), "Block A");
    await user.selectOptions(field(/Room/), "101 · Floor 1");
    await user.selectOptions(field(/Bed/), "C");
    await user.click(screen.getByRole("button", { name: "Reactivate student" }));

    expect(await screen.findByText("ABCD234567")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Student reactivated" })).toBeInTheDocument();
    expect(posts).toEqual([
      { action: "reactivate", body: { joiningDate: hostelToday(), buildingId: 1, roomId: 20, bedId: 32 } },
    ]);
    // The profile behind the password is already the current one.
    expect(profileCalls()).toBe(2);
    expect(screen.queryByText("Former student")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("ABCD234567")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move out" })).toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the form", async () => {
    const { user } = actionServer([formerAsha], {
      reactivate: () =>
        jsonResponse(409, { error: { code: "bed_occupied", message: "The selected bed is already occupied." } }),
    });
    await user.click(await screen.findByRole("button", { name: "Reactivate" }));
    await user.selectOptions(await screen.findByLabelText("Building"), "Block B");
    await user.click(screen.getByRole("button", { name: "Reactivate student" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The selected bed is already occupied.");
    expect(screen.getByRole("button", { name: "Reactivate student" })).toBeEnabled();
  });

  it("closes the form on Cancel without sending anything", async () => {
    const { user, posts } = actionServer([formerAsha], {});
    await user.click(await screen.findByRole("button", { name: "Reactivate" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Joining date")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});

describe("resetting a password", () => {
  const ashaOwnPassword: StudentProfile = { ...asha, mustChangePassword: false };
  const reset = () => jsonResponse(200, { temporaryPassword: "WXYZ234567" });

  it("is offered to a current student only", async () => {
    actionServer([asha], { "reset-password": reset });
    expect(await screen.findByRole("button", { name: "Reset password" })).toBeInTheDocument();
  });

  it("is not offered to a former student", async () => {
    actionServer([formerAsha], { "reset-password": reset });
    await screen.findByRole("button", { name: "Reactivate" });
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
  });

  it("asks first, and Cancel sends nothing", async () => {
    const { user, posts } = actionServer([ashaOwnPassword], { "reset-password": reset });
    await user.click(await screen.findByRole("button", { name: "Reset password" }));

    expect(
      screen.getByText(
        "Reset Asha Rao's password? Their current password stops working at once, and they must choose a new one when they next log in.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Reset password" })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("resets, shows the temporary password once, and forgets it on Done", async () => {
    const { user, posts, profileCalls } = actionServer([ashaOwnPassword, asha], { "reset-password": reset });
    await user.click(await screen.findByRole("button", { name: "Reset password" }));
    await user.click(screen.getByRole("button", { name: "Yes, reset password" }));

    expect(await screen.findByText("WXYZ234567")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Password reset" })).toBeInTheDocument();
    expect(posts).toEqual([{ action: "reset-password", body: undefined }]);
    // The profile behind the password is already the current one.
    expect(profileCalls()).toBe(2);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("WXYZ234567")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset password" })).toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the question open", async () => {
    const { user } = actionServer([asha], {
      "reset-password": () =>
        jsonResponse(409, { error: { code: "student_inactive", message: "This student is inactive." } }),
    });
    await user.click(await screen.findByRole("button", { name: "Reset password" }));
    await user.click(screen.getByRole("button", { name: "Yes, reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This student is inactive.");
    expect(screen.getByRole("button", { name: "Yes, reset password" })).toBeEnabled();
  });
});

describe("editing details", () => {
  const saved = (student: StudentProfile) => () => jsonResponse(200, { student });
  const ashaAtWork: StudentProfile = {
    ...asha,
    name: "Asha R. Rao",
    category: "working",
    collegeName: null,
    branch: null,
    academicYear: null,
    company: "Acme Ltd",
  };

  it("is offered to current and former students", async () => {
    actionServer([asha], {});
    expect(await screen.findByRole("button", { name: "Edit details" })).toBeInTheDocument();
    cleanup();
    actionServer([formerAsha], {});
    expect(await screen.findByRole("button", { name: "Edit details" })).toBeInTheDocument();
  });

  it("opens with the current details, the joining date read-only, and Cancel sends nothing", async () => {
    const { user, posts } = actionServer([asha], { edit: saved(asha) });
    await user.click(await screen.findByRole("button", { name: "Edit details" }));

    expect(field("Full name")).toHaveValue("Asha Rao");
    expect(field("Email")).toHaveValue("asha@example.com");
    expect(field("Mobile number")).toHaveValue("9876543210");
    expect(field("Category")).toHaveValue("college");
    expect(field("College")).toHaveValue("City College");
    expect(field("Year")).toHaveValue("2");
    expect(screen.getByRole("radio", { name: "Veg" })).toBeChecked();
    expect(field(/Monthly fee/)).toHaveValue("6500");
    expect(screen.getByText("Joining date: 31 Jan 2026 (cannot be changed)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Joining date")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit details" })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("saves the changes, shows the profile the server sends back, and closes the form", async () => {
    const { user, posts, profileCalls } = actionServer([asha], { edit: saved(ashaAtWork) });
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    await user.clear(field("Full name"));
    await user.type(field("Full name"), "Asha R. Rao");
    await user.selectOptions(field("Category"), "working");
    await user.type(field("Company"), "Acme Ltd");
    await user.click(screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Details saved.");
    expect(posts).toEqual([
      {
        action: "edit",
        body: {
          name: "Asha R. Rao",
          email: "asha@example.com",
          phone: "9876543210",
          parentPhone: "9876500000",
          category: "working",
          company: "Acme Ltd",
          foodPreference: "veg",
          monthlyFee: 6500,
        },
      },
    ]);
    expect(screen.getByRole("heading", { name: "Asha R. Rao" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save details" })).not.toBeInTheDocument();
    // The answer already holds the profile as it is now: no second load.
    expect(profileCalls()).toBe(1);
  });

  it("checks the fields before sending anything", async () => {
    const { user, posts, requestCount } = actionServer([asha], { edit: saved(asha) });
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    await user.clear(field("Full name"));
    await user.clear(field("Mobile number"));
    await user.type(field("Mobile number"), "12345");
    await user.click(screen.getByRole("button", { name: "Save details" }));

    expect(field("Full name")).toHaveAccessibleDescription("Required.");
    expect(field("Mobile number")).toHaveAccessibleDescription("Enter a 10-digit mobile number.");
    // Nothing was sent: no request, so no saving state and no error from the server.
    expect(posts).toEqual([]);
    expect(requestCount()).toBe(1); // only the profile itself
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();
  });

  it("shows the server's refusal and keeps the form", async () => {
    const { user } = actionServer([asha], {
      edit: () =>
        jsonResponse(409, { error: { code: "email_taken", message: "This email address already belongs to an account." } }),
    });
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    await user.click(screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This email address already belongs to an account.");
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();
  });

  // Phase 5b: students under 18.
  const minorAsha: StudentProfile = {
    ...asha,
    under18: true,
    guardianConsent: { on: "2026-11-02", by: "Ravi Owner" },
  };

  it("shows who confirmed a guardian's consent, and does not ask for it again", async () => {
    const { user, posts } = actionServer([minorAsha], { edit: saved({ ...minorAsha, under18: false }) });
    expect(await screen.findByText("Under 18", { selector: "dt" })).toBeInTheDocument();
    expect(valueOf("Under 18")).toHaveTextContent("Guardian's consent confirmed by Ravi Owner on 2 Nov 2026");

    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(screen.getByRole("checkbox", { name: "Under 18" })).toBeChecked();
    expect(screen.getByText("Guardian's consent confirmed on 2 Nov 2026.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /guardian's consent/ })).not.toBeInTheDocument();

    // They turned 18: unmarked, the edit says nothing about being under 18.
    await user.click(screen.getByRole("checkbox", { name: "Under 18" }));
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByRole("status");
    expect(posts[0].body).not.toHaveProperty("under18");
    expect(screen.queryByText("Under 18", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("saves a student still under 18 with the consent already recorded", async () => {
    const { user, posts } = actionServer([minorAsha], { edit: saved(minorAsha) });
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByRole("status");
    expect(posts[0].body).toMatchObject({ under18: true, guardianConsent: true });
  });

  it("asks for the consent when a student is first marked under 18 while editing", async () => {
    const { user, posts } = actionServer([asha], { edit: saved(minorAsha) });
    expect(screen.queryByText("Under 18", { selector: "dt" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    await user.click(screen.getByRole("checkbox", { name: "Under 18" }));
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(posts).toEqual([]);

    await user.click(screen.getByRole("checkbox", { name: /guardian's consent/ }));
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByRole("status");
    expect(posts[0].body).toMatchObject({ under18: true, guardianConsent: true });
  });

  it("shows a former student's fee without letting it change, and sends it back as it is", async () => {
    const { user, posts } = actionServer([formerAsha], { edit: saved(formerAsha) });
    await user.click(await screen.findByRole("button", { name: "Edit details" }));

    expect(screen.queryByLabelText(/Monthly fee/)).not.toBeInTheDocument();
    expect(screen.getByText("Monthly fee: ₹6,500 (cannot be changed after moving out)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save details" }));

    await screen.findByRole("status");
    expect(posts[0].body).toMatchObject({ monthlyFee: 6500 });
  });
});
