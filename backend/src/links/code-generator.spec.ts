import { generateLinkCode } from './code-generator';

describe('generateLinkCode', () => {
  it('generates an 8-character code', () => {
    expect(generateLinkCode()).toHaveLength(8);
  });

  it('only uses unambiguous uppercase characters (no 0/O/1/I)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateLinkCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it('produces different codes across calls (no fixed seed)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateLinkCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
