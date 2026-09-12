import { randomInt } from 'node:crypto';

// No 0/O/1/I — visually ambiguous characters excluded so a payer can read a code aloud or off a phone screen.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}
