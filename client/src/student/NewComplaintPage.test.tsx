import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComplaintDetail, RaiseStatus } from "../api/complaints";
import { jsonResponse, mockFetch } from "../test/fetch";
import { PhotoError } from "./compressPhoto";
import { NewComplaintPage } from "./NewComplaintPage";

// The real compressor needs a canvas, which jsdom lacks (compressPhoto.test.ts tests it
// with a fake one). Here it is replaced, keeping the real PhotoError.
const compress = vi.hoisted(() => ({ fn: vi.fn<(file: File) => Promise<Blob>>() }));
vi.mock("./compressPhoto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./compressPhoto")>()),
  compressPhoto: (file: File) => compress.fn(file),
}));
const COMPRESSED = new Blob([new Uint8Array(480 * 1024)], { type: "image/jpeg" });
beforeEach(() => {
  compress.fn.mockReset();
  compress.fn.mockResolvedValue(COMPRESSED);
});
const cameraPhoto = () => new File([new Uint8Array(3000)], "IMG_1234.jpg", { type: "image/jpeg" });

const created: ComplaintDetail = {
  id: 43,
  category: "electrical",
  description: "The fan in room 204 does not turn on.",
  status: "open",
  createdAt: "2026-11-05T04:30:00.000Z",
  updatedAt: "2026-11-05T04:30:00.000Z",
  resolvedAt: null,
  events: [{ kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: "2026-11-05T04:30:00.000Z" }],
};

const ALLOWED: RaiseStatus = { allowed: true, reason: null, activeCategories: ["plumbing", "food"] };

// Shows where the form sent the student, and with what state.
function Landed() {
  const location = useLocation();
  return <p>Landed on {location.pathname} {JSON.stringify(location.state)}</p>;
}

// A fake server: GET /api/complaints?page=1 answers canRaise and photoUploadsAllowed;
// POST /api/complaints is recorded (JSON parsed; form data as its fields) and answered
// by `answer`.
function fakeServer(
  canRaise: RaiseStatus,
  answer: () => Response = () => jsonResponse(201, created),
  photoUploadsAllowed = true,
) {
  const posts: unknown[] = [];
  mockFetch(async (url, init) => {
    if (url === "/api/complaints?page=1") {
      return jsonResponse(200, { items: [], total: 0, canRaise, photoUploadsAllowed });
    }
    if (url === "/api/complaints" && init?.method === "POST") {
      posts.push(init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body as string));
      return answer();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/complaints/new"]}>
      <Routes>
        <Route path="/complaints/new" element={<NewComplaintPage />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user, posts };
}

const category = () => screen.getByLabelText("Category");
const description = () => screen.getByLabelText("What is wrong?");
const send = () => screen.getByRole("button", { name: "Send complaint" });

describe("NewComplaintPage", () => {
  it("offers the eight categories, with those already active shown as unavailable", async () => {
    fakeServer(ALLOWED);
    await screen.findByRole("heading", { name: "New complaint" });
    await screen.findByLabelText("Category");

    const options = within(category()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a category",
      "Plumbing (already active)",
      "Electrical",
      "Cleanliness",
      "Internet",
      "Food (already active)",
      "Furniture",
      "Security",
      "Other",
    ]);
    expect(screen.getByRole("option", { name: "Plumbing (already active)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Food (already active)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Electrical" })).toBeEnabled();
    expect(category()).toHaveAccessibleDescription(
      "You already have an active complaint in Plumbing, Food. You can raise another one there when it is resolved or rejected.",
    );
  });

  it("enables Send only with a category and 10 to 500 characters after trimming", async () => {
    const { user } = fakeServer({ allowed: true, reason: null, activeCategories: [] });
    await screen.findByLabelText("Category");
    expect(send()).toBeDisabled();

    await user.selectOptions(category(), "electrical");
    await user.type(description(), "   Fan off   ");
    // Spaces at the ends do not count.
    expect(screen.getByText("7 / 500")).toBeInTheDocument();
    expect(screen.getByText("At least 10 characters")).toBeInTheDocument();
    expect(send()).toBeDisabled();

    await user.type(description(), "{Backspace}{Backspace}{Backspace} again");
    expect(screen.getByText("13 / 500")).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("counts an emoji as one character, as the server does", async () => {
    const { user } = fakeServer({ allowed: true, reason: null, activeCategories: [] });
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "other");
    await user.click(description());
    await user.paste("😀".repeat(5));
    expect(screen.getByText("5 / 500")).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it("marks a description over 500 characters and keeps Send disabled", async () => {
    const { user } = fakeServer({ allowed: true, reason: null, activeCategories: [] });
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "other");
    await user.click(description());
    await user.paste("x".repeat(501));

    expect(screen.getByText("501 / 500")).toBeInTheDocument();
    expect(screen.getByText("Too long")).toBeInTheDocument();
    expect(description()).toHaveAttribute("aria-invalid", "true");
    expect(send()).toBeDisabled();
  });

  it("sends the trimmed complaint and opens it", async () => {
    const { user, posts } = fakeServer(ALLOWED);
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "electrical");
    await user.type(description(), "  The fan in room 204 does not turn on.  ");
    await user.click(send());

    expect(await screen.findByText('Landed on /complaints/43 {"created":true}')).toBeInTheDocument();
    expect(posts).toEqual([{ category: "electrical", description: "The fan in room 204 does not turn on." }]);
  });

  it("shows the server's refusal word for word and lets the student try again", async () => {
    const message = "You can raise at most 2 complaints in 24 hours. Please try again later.";
    const { user, posts } = fakeServer(ALLOWED, () =>
      jsonResponse(429, { error: { code: "too_many_recent", message } }),
    );
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "security");
    await user.type(description(), "The main gate lock is broken.");
    await user.click(send());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(posts).toHaveLength(1);
    expect(send()).toBeEnabled();
    expect(description()).toHaveValue("The main gate lock is broken.");
  });

  it("shows the reason instead of the form when a limit is already reached", async () => {
    const reason = "You already have 3 active complaints. You can raise a new one when one of them is resolved or rejected.";
    fakeServer({ allowed: false, reason, activeCategories: ["plumbing", "food", "internet"] });

    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send complaint" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← My complaints" })).toHaveAttribute("href", "/");
  });
});

describe("NewComplaintPage: the optional photo (day 8)", () => {
  const photoInput = () => screen.getByLabelText("Photo (optional)");
  const fillIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "furniture");
    await user.type(description(), "The cupboard door in room 204 fell off.");
  };

  it("shrinks the chosen photo and sends it with the complaint as form data", async () => {
    const { user, posts } = fakeServer(ALLOWED);
    await fillIn(user);
    const original = cameraPhoto();
    await user.upload(photoInput(), original);

    expect(await screen.findByText("Photo ready (480 KB)")).toBeInTheDocument();
    expect(compress.fn).toHaveBeenCalledWith(original);
    await user.click(send());

    expect(await screen.findByText('Landed on /complaints/43 {"created":true}')).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    const sent = posts[0] as Record<string, FormDataEntryValue>;
    expect(sent.category).toBe("furniture");
    expect(sent.description).toBe("The cupboard door in room 204 fell off.");
    // The compressed photo, not the original.
    expect(sent.photo).toBeInstanceOf(File);
    expect((sent.photo as File).size).toBe(COMPRESSED.size);
    expect((sent.photo as File).type).toBe("image/jpeg");
  });

  it("keeps Send disabled while the photo is being prepared", async () => {
    let finish: (blob: Blob) => void = () => {};
    compress.fn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { user } = fakeServer(ALLOWED);
    await fillIn(user);
    await user.upload(photoInput(), cameraPhoto());

    expect(await screen.findByText("Preparing photo…")).toBeInTheDocument();
    expect(send()).toBeDisabled();
    finish(COMPRESSED);
    expect(await screen.findByText("Photo ready (480 KB)")).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("can remove the photo again, and then sends plain JSON", async () => {
    const { user, posts } = fakeServer(ALLOWED);
    await fillIn(user);
    await user.upload(photoInput(), cameraPhoto());
    await user.click(await screen.findByRole("button", { name: "Remove photo" }));
    expect(screen.queryByText(/Photo ready/)).not.toBeInTheDocument();
    await user.click(send());

    await screen.findByText(/Landed on/);
    expect(posts).toEqual([{ category: "furniture", description: "The cupboard door in room 204 fell off." }]);
  });

  it("shows why a photo cannot be used, and still lets the student send without it", async () => {
    compress.fn.mockRejectedValue(new PhotoError("This photo could not be read. Try a JPEG or PNG photo."));
    const { user, posts } = fakeServer(ALLOWED);
    await fillIn(user);
    await user.upload(photoInput(), cameraPhoto());

    expect(await screen.findByText("This photo could not be read. Try a JPEG or PNG photo.")).toBeInTheDocument();
    expect(send()).toBeEnabled();
    await user.click(send());
    await screen.findByText(/Landed on/);
    expect(posts).toEqual([{ category: "furniture", description: "The cupboard door in room 204 fell off." }]);
  });

  it("offers no photo while uploads are off, and says so", async () => {
    fakeServer(ALLOWED, undefined, false);
    await screen.findByLabelText("Category");
    expect(screen.queryByLabelText("Photo (optional)")).not.toBeInTheDocument();
    expect(screen.getByText("Photos are switched off for now. You can still send the complaint as text.")).toBeInTheDocument();
  });

  it("shows the server's photo refusal word for word, keeping the photo to retry", async () => {
    const message = "Photo uploads are switched off for now. Please send the complaint without a photo.";
    const { user } = fakeServer(ALLOWED, () => jsonResponse(409, { error: { code: "photo_uploads_off", message } }));
    await fillIn(user);
    await user.upload(photoInput(), cameraPhoto());
    await screen.findByText("Photo ready (480 KB)");
    await user.click(send());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Remove photo" })).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });
});
