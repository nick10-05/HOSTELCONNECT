import bcrypt from "bcryptjs";

// Each extra point doubles the work. 12 is the design's choice.
export const BCRYPT_COST = 12;

// Returns a bcrypt hash of the password, with a fresh random salt each time.
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

// True only when the password matches the hash.
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}