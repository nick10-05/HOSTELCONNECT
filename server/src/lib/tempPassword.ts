import { randomInt } from "node:crypto";

// Temporary passwords for admission, reset and reactivation.
export const TEMP_PASSWORD_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const TEMP_PASSWORD_LENGTH = 10;

// Generates a secure random temporary password.
export function generateTemporaryPassword(): string {
  let password = "";

  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    const position = randomInt(TEMP_PASSWORD_ALPHABET.length);
    password += TEMP_PASSWORD_ALPHABET[position];
  }

  return password;
}