// A UPI payment link (upi://pay?...), which UPI apps open with the payee filled in, and
// which the drawn QR code holds (day 9). pa: the UPI ID; pn: the payee name, if set; am:
// the amount in rupees, only when over zero; cu: always INR. Each value is URL-encoded,
// except that the UPI ID keeps its '@', as UPI apps expect it.
export function upiLink(payee: { upiId: string; upiPayeeName: string | null }, amount?: number): string {
  const encode = (value: string) => encodeURIComponent(value);
  const parts = [`pa=${encode(payee.upiId).replace("%40", "@")}`];
  if (payee.upiPayeeName) parts.push(`pn=${encode(payee.upiPayeeName)}`);
  if (amount !== undefined && amount > 0) parts.push(`am=${amount.toFixed(2)}`);
  parts.push("cu=INR");
  return `upi://pay?${parts.join("&")}`;
}
