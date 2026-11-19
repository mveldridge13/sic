/**
 * Currencies differ in how many decimal places they have: yen and won have none, dollars and
 * euros have two. Amounts are always whole numbers of the currency's smallest unit ("minor
 * units": ¥1, 1 cent), and every currency-aware helper here takes the currency code.
 *
 * Converting: an expense paid in another currency is converted into the group's currency once,
 * when it's entered, at a rate that's then locked (see the currency_conversion migration).
 */
import { assertCents, centsToDecimalString, MoneyError, parseToCents, type Cents } from './money.js';
import { computeSplit, itemsSubtotal, type ItemsRest, type SplitInput, type SplitItem, type SplitShare, type UserId } from './split.js';

/** ISO 4217 currencies without a minor unit that sic may meet. Everything else has 2 decimals. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'ISK', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);

export function currencyDecimals(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/** Parse a typed amount in this currency into minor units: "1250" yen → 1250, "12.50" dollars → 1250. */
export function parseMoney(input: string, currency: string): Cents {
  if (currencyDecimals(currency) === 2) return parseToCents(input);
  const cleaned = input.trim().replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) throw new MoneyError(`"${input}" is not a valid amount`);
  const result = Number(cleaned);
  assertCents(result);
  return result;
}

/** Minor units as a plain decimal string for an input box: 1250 yen → "1250", 1250 cents → "12.50". */
export function moneyToDecimalString(minor: Cents, currency: string): string {
  assertCents(minor);
  return currencyDecimals(currency) === 2 ? centsToDecimalString(minor) : String(minor);
}

/** What `minor` units of `from` come to in `to`, at `rate` (units of `to` per 1 unit of `from`), rounded. */
export function convertMinor(minor: Cents, from: string, to: string, rate: number): Cents {
  assertCents(minor);
  if (!(rate > 0) || !Number.isFinite(rate)) throw new MoneyError('The exchange rate must be more than zero');
  const result = Math.round(minor * rate * 10 ** (currencyDecimals(to) - currencyDecimals(from)));
  assertCents(result);
  return result;
}

/** The rate implied by two amounts (what was paid, and what the bank charged in the group's currency). */
export function rateFromAmounts(originalMinor: Cents, from: string, convertedMinor: Cents, to: string): number {
  if (originalMinor <= 0) throw new MoneyError('Enter what you paid first');
  return (convertedMinor / originalMinor) * 10 ** (currencyDecimals(from) - currencyDecimals(to));
}

/**
 * Split an expense paid in another currency. The split is worked out on what was paid (so item
 * prices and amounts typed in that currency mean what they say), then each person's part of the
 * converted total follows the same proportions. The result always adds up to `groupTotal` exactly.
 */
export function convertSplit(groupTotal: Cents, originalTotal: Cents, split: SplitInput): SplitShare[] {
  const original = computeSplit(originalTotal, split);
  return computeSplit(groupTotal, { method: 'shares', shares: original.map((s) => ({ userId: s.userId, units: s.amount })) });
}

/**
 * inferItemsRest for an expense paid in another currency: the items are in what was paid, the
 * saved shares in the group's currency. Tries "everything else split equally" and checks it
 * converts to exactly the saved shares; otherwise it was shared in proportion.
 */
export function inferConvertedItemsRest(
  groupTotal: Cents,
  originalTotal: Cents,
  items: SplitItem[],
  shares: SplitShare[],
): { rest: ItemsRest; participants: UserId[] } {
  const all = shares.map((s) => s.userId);
  try {
    const own = new Map(computeSplit(itemsSubtotal(items), { method: 'items', items }).map((s) => [s.userId, s.amount]));
    // Someone shares everything else if their part is more than their own items come to (allowing for rounding).
    const participants = shares
      .filter((s) => s.amount * originalTotal > (own.get(s.userId) ?? 0) * groupTotal + originalTotal)
      .map((s) => s.userId);
    const equal = convertSplit(groupTotal, originalTotal, { method: 'items', items, rest: 'equal', participants });
    const saved = new Map(shares.map((s) => [s.userId, s.amount]));
    if (equal.length === shares.length && equal.every((s) => saved.get(s.userId) === s.amount)) {
      return { rest: 'equal', participants: participants.length ? participants : all };
    }
  } catch {
    // Not split equally.
  }
  return { rest: 'proportional', participants: all };
}
