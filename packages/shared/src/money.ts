/**
 * All money in sic is an integer number of minor units ("cents").
 * $125.50 is 12550. Never use floats for money.
 */
export type Cents = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: unknown, label = 'amount'): asserts value is Cents {
  if (!isCents(value)) {
    throw new MoneyError(`${label} must be a safe integer number of cents, got ${String(value)}`);
  }
}

/**
 * Parse a user-entered decimal string ("125.5", "125.50", "1,250.00") into cents
 * using string arithmetic only, so no floating-point rounding can occur.
 * Assumes a currency with 2 decimal places.
 */
export function parseToCents(input: string): Cents {
  const cleaned = input.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) {
    throw new MoneyError(`"${input}" is not a valid amount`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  const result = sign ? -cents : cents;
  assertCents(result);
  return result;
}

/** Format cents as a plain decimal string, e.g. 12550 -> "125.50". */
export function centsToDecimalString(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

/** Currencies with no minor unit (¥1 is the smallest amount). Kept in step with currency.ts. */
const NO_DECIMALS = new Set(['JPY', 'KRW', 'ISK', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);

/**
 * Format minor units for display using Intl, e.g. formatMoney(12550, 'USD') -> "$125.50" and
 * formatMoney(1250, 'JPY') -> "¥1,250".
 */
export function formatMoney(cents: Cents, currency: string, locale?: string): string {
  assertCents(cents);
  const decimals = NO_DECIMALS.has(currency) ? 0 : 2;
  // Dividing for display only; the result is never stored or used in arithmetic.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(cents / 10 ** decimals);
}
