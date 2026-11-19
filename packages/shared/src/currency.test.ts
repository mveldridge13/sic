import { describe, expect, it } from 'vitest';

import { convertMinor, convertSplit, currencyDecimals, moneyToDecimalString, parseMoney, rateFromAmounts } from './currency.js';
import { formatMoney } from './money.js';

describe('currencies without cents', () => {
  it('parses and prints yen as whole yen', () => {
    expect(currencyDecimals('JPY')).toBe(0);
    expect(parseMoney('1,250', 'JPY')).toBe(1250);
    expect(() => parseMoney('12.50', 'JPY')).toThrow();
    expect(moneyToDecimalString(1250, 'JPY')).toBe('1250');
    expect(formatMoney(1250, 'JPY', 'en-AU')).toMatch(/^JPY\s1,250$/);
  });
  it('leaves two-decimal currencies as they were', () => {
    expect(parseMoney('12.5', 'AUD')).toBe(1250);
    expect(moneyToDecimalString(1250, 'AUD')).toBe('12.50');
    expect(formatMoney(1250, 'AUD', 'en-AU')).toBe('$12.50');
  });
});

describe('converting', () => {
  it('converts between currencies with different decimals', () => {
    // ¥10,000 at 1 JPY = 0.0093 AUD → A$93.00
    expect(convertMinor(10_000, 'JPY', 'AUD', 0.0093)).toBe(9300);
    // A$850.00 at 1 AUD = 0.60 EUR → €510.00
    expect(convertMinor(85_000, 'AUD', 'EUR', 0.6)).toBe(51_000);
    // A$10.00 at 1 AUD = 107.31 JPY → ¥1,073
    expect(convertMinor(1000, 'AUD', 'JPY', 107.31)).toBe(1073);
  });
  it('works out the rate from what the bank charged', () => {
    expect(rateFromAmounts(10_000, 'JPY', 9450, 'AUD')).toBeCloseTo(0.00945, 10);
    expect(convertMinor(10_000, 'JPY', 'AUD', rateFromAmounts(10_000, 'JPY', 9450, 'AUD'))).toBe(9450);
  });
  it('splits the converted total in the same proportions as what was paid, adding up exactly', () => {
    const shares = convertSplit(9301, 10_000, {
      method: 'items',
      items: [
        { name: 'Ramen', amount: 1200, userIds: ['a'] },
        { name: 'Sushi', amount: 6000, userIds: ['b', 'c'] },
      ],
      rest: 'equal',
      participants: ['a', 'b', 'c'],
    });
    expect(shares.reduce((t, s) => t + s.amount, 0)).toBe(9301);
    // Ramen ¥1,200 plus a third of the ¥2,800 left over is ¥2,133 or ¥2,134 of ¥10,000, so about 21.3% of 9,301.
    const a = shares.find((s) => s.userId === 'a')?.amount ?? 0;
    expect(a).toBeGreaterThanOrEqual(1983);
    expect(a).toBeLessThanOrEqual(1985);
  });
});
