import { describe, expect, it } from "vitest";
import { upiLink } from "./upiLink";

describe("upiLink", () => {
  it("gives the UPI ID, payee name and currency", () => {
    expect(upiLink({ upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel" })).toBe(
      "upi://pay?pa=owner@okaxis&pn=Sri%20Lakshmi%20Hostel&cu=INR",
    );
  });

  it("leaves out a missing payee name", () => {
    expect(upiLink({ upiId: "9876543210@ybl", upiPayeeName: null })).toBe("upi://pay?pa=9876543210@ybl&cu=INR");
  });

  it("adds an amount over zero, in rupees with two decimals", () => {
    expect(upiLink({ upiId: "owner@okaxis", upiPayeeName: null }, 6500)).toBe(
      "upi://pay?pa=owner@okaxis&am=6500.00&cu=INR",
    );
    expect(upiLink({ upiId: "owner@okaxis", upiPayeeName: null }, 0)).toBe("upi://pay?pa=owner@okaxis&cu=INR");
  });

  it("encodes characters that would break the link, keeping the '@'", () => {
    expect(upiLink({ upiId: "a&b=c@ok#x", upiPayeeName: "Ravi & Sons / 100%" })).toBe(
      "upi://pay?pa=a%26b%3Dc@ok%23x&pn=Ravi%20%26%20Sons%20%2F%20100%25&cu=INR",
    );
  });
});
