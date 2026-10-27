import { describe, expect, test } from 'bun:test';
import { magnitude, money, signedMoney } from './money';

describe('one sign convention', () => {
  test('a spent figure reads positive', () => {
    expect(magnitude(-1234.5, false)).toBe(magnitude(1234.5, false));
    expect(magnitude(-1234.5, false).startsWith('−')).toBe(false);
  });

  test('a row is signed both ways', () => {
    expect(signedMoney(-12.5).startsWith('−')).toBe(true);
    expect(signedMoney(12.5).startsWith('+')).toBe(true);
  });

  test('a balance marks only a negative', () => {
    expect(money(10).startsWith('+')).toBe(false);
    expect(money(-10).startsWith('−')).toBe(true);
  });

  test('nothing that rounds to zero carries a sign', () => {
    expect(signedMoney(-0.004)).toBe(signedMoney(0));
    expect(money(-0.4, false)).toBe(money(0, false));
    expect(signedMoney(0.4, false)).toBe(signedMoney(0, false));
  });
});
