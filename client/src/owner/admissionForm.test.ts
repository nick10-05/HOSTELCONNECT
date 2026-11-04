import { describe, expect, it } from "vitest";
import {
  addDays,
  checkAdmission,
  cleanMobile,
  emptyAdmission,
  hostelToday,
  type AdmissionValues,
} from "./admissionForm";

const TODAY = "2026-11-04";

const filled = (overrides: Partial<AdmissionValues> = {}): AdmissionValues => ({
  ...emptyAdmission(TODAY),
  name: " Asha Rao ",
  email: " Asha@Example.com ",
  phone: "+91 98765-43210",
  parentPhone: "9876500000",
  category: "college",
  collegeName: "City College",
  branch: "CSE",
  academicYear: "2",
  foodPreference: "veg",
  monthlyFee: "6500",
  buildingId: "1",
  ...overrides,
});

const errorsOf = (v: AdmissionValues) => {
  const result = checkAdmission(v, TODAY);
  return "errors" in result ? result.errors : {};
};

describe("cleanMobile", () => {
  it("keeps the 10 digits of an Indian mobile number however it is written", () => {
    expect(cleanMobile("9876543210")).toBe("9876543210");
    expect(cleanMobile("+91 98765 43210")).toBe("9876543210");
    expect(cleanMobile("98765-43210")).toBe("9876543210");
  });

  it("refuses anything else", () => {
    for (const s of ["", "98765", "5876543210", "09876543210", "+1 9876543210", "98765432101"]) {
      expect(cleanMobile(s)).toBeNull();
    }
  });
});

describe("hostelToday and addDays", () => {
  it("uses India's date", () => {
    expect(hostelToday(new Date("2026-01-31T20:00:00Z"))).toBe("2026-02-01");
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-11-04", 30)).toBe("2026-12-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("checkAdmission", () => {
  it("returns the cleaned body for a valid college student", () => {
    expect(checkAdmission(filled(), TODAY)).toEqual({
      form: {
        name: "Asha Rao",
        email: "asha@example.com",
        phone: "9876543210",
        parentPhone: "9876500000",
        category: "college",
        collegeName: "City College",
        branch: "CSE",
        academicYear: 2,
        joiningDate: TODAY,
        foodPreference: "veg",
        monthlyFee: 6500,
        buildingId: 1,
        roomId: null,
        bedId: null,
      },
    });
  });

  it("sends only the fields of the chosen category", () => {
    const result = checkAdmission(filled({ category: "working", company: " Acme ", designation: "" }), TODAY);
    expect(result).toHaveProperty("form");
    const form = (result as { form: Record<string, unknown> }).form;
    expect(form.company).toBe("Acme");
    expect(form).not.toHaveProperty("designation");
    expect(form).not.toHaveProperty("collegeName");
    expect(form).not.toHaveProperty("academicYear");
  });

  it("sends a non-veg student's veg days sorted, and none once switched back to Veg", () => {
    expect(checkAdmission(filled({ foodPreference: "non_veg", vegDays: [6, 2] }), TODAY)).toMatchObject({
      form: { foodPreference: "non_veg", vegDays: [2, 6] },
    });
    const veg = checkAdmission(filled({ foodPreference: "veg", vegDays: [6, 2] }), TODAY);
    expect((veg as { form: object }).form).not.toHaveProperty("vegDays");
  });

  it("sends room and bed when chosen, and a blank fee as null", () => {
    const result = checkAdmission(filled({ roomId: "20", bedId: "32", monthlyFee: "" }), TODAY);
    expect(result).toMatchObject({ form: { roomId: 20, bedId: 32, monthlyFee: null } });
  });

  it("names each missing or wrong field", () => {
    expect(errorsOf({ ...emptyAdmission(TODAY) })).toEqual({
      name: "Required.",
      email: "Required.",
      phone: "Required.",
      parentPhone: "Required.",
      category: "Choose a category.",
      foodPreference: "Choose Veg or Non-Veg.",
      buildingId: "Choose a building.",
    });
    expect(errorsOf(filled({ email: "asha@" }))).toEqual({ email: "Enter a valid email address." });
    expect(errorsOf(filled({ phone: "12345" }))).toEqual({ phone: "Enter a 10-digit mobile number." });
  });

  it("asks for the college fields only for a college student, and the company for a working one", () => {
    expect(errorsOf(filled({ collegeName: "", branch: "", academicYear: "" }))).toEqual({
      collegeName: "Required.",
      branch: "Required.",
      academicYear: "Required.",
    });
    expect(errorsOf(filled({ category: "working" }))).toEqual({ company: "Required." });
    expect(errorsOf(filled({ category: "other", collegeName: "" }))).toEqual({});
  });

  it("allows a joining date up to 30 days ahead, and any real past date", () => {
    expect(errorsOf(filled({ joiningDate: addDays(TODAY, 30) }))).toEqual({});
    expect(errorsOf(filled({ joiningDate: "2019-07-01" }))).toEqual({});
    expect(errorsOf(filled({ joiningDate: addDays(TODAY, 31) }))).toEqual({
      joiningDate: "At most 30 days from today.",
    });
    expect(errorsOf(filled({ joiningDate: "2026-02-30" }))).toEqual({ joiningDate: "Enter a valid date." });
  });

  it("refuses a fee that is not whole rupees", () => {
    for (const monthlyFee of ["-1", "6500.5", "abc"]) {
      expect(errorsOf(filled({ monthlyFee }))).toHaveProperty("monthlyFee");
    }
  });
});
