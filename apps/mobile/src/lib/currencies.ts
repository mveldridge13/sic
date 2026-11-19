import { requireOptionalNativeModule } from 'expo';
import type * as Localization from 'expo-localization';

/**
 * Currencies sic offers for groups. All amounts are stored as integer cents, which
 * assumes 2 decimal places, so zero-decimal currencies (JPY, KRW, …) are deliberately
 * excluded until the money layer supports per-currency precision.
 */
export const CURRENCIES = ['AUD', 'USD', 'EUR', 'GBP', 'NZD', 'CAD', 'SGD', 'INR', 'PHP'] as const;

export type Currency = (typeof CURRENCIES)[number];

/**
 * Currencies an expense can be paid in: every currency with a European Central Bank daily rate
 * (the exchange-rate function's list). The amount is converted into the group's currency.
 */
export const PAY_CURRENCIES: { code: string; name: string }[] = [
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'BRL', name: 'Brazilian real' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'CZK', name: 'Czech koruna' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'HUF', name: 'Hungarian forint' },
  { code: 'IDR', name: 'Indonesian rupiah' },
  { code: 'ILS', name: 'Israeli shekel' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'ISK', name: 'Icelandic króna' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'KRW', name: 'South Korean won' },
  { code: 'MXN', name: 'Mexican peso' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'RON', name: 'Romanian leu' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'THB', name: 'Thai baht' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'USD', name: 'US dollar' },
  { code: 'ZAR', name: 'South African rand' },
];

export function canPayIn(code: string | null | undefined): code is string {
  return !!code && PAY_CURRENCIES.some((c) => c.code === code);
}

export function isSupportedCurrency(code: string | null | undefined): code is Currency {
  return !!code && (CURRENCIES as readonly string[]).includes(code);
}

/**
 * The currency of the phone's region (Settings → language & region), e.g. AUD in Australia.
 * Returns null when the region's currency isn't one sic supports yet.
 */
export function deviceCurrency(): Currency | null {
  // Only load expo-localization if this build includes its native module. An older
  // development build without it would otherwise report "Cannot find native module".
  if (!requireOptionalNativeModule('ExpoLocalization')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLocales } = require('expo-localization') as typeof Localization;
    for (const locale of getLocales()) {
      if (isSupportedCurrency(locale.currencyCode)) return locale.currencyCode;
    }
  } catch {
    // Fall through: keep the server default.
  }
  return null;
}

/** The phone's time zone, e.g. "Australia/Sydney", or null if it can't be read. */
export function deviceTimeZone(): string | null {
  if (requireOptionalNativeModule('ExpoLocalization')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCalendars } = require('expo-localization') as typeof Localization;
      const tz = getCalendars()[0]?.timeZone;
      if (tz) return tz;
    } catch {
      // Fall back to Intl below.
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
