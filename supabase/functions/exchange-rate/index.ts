// The exchange rate for an expense paid in another currency: how many units of the group's
// currency one unit of the paid currency was worth. Rates are the European Central Bank's daily
// reference rates, from Frankfurter (frankfurter.dev, free, no key). Fetched here rather than on
// the phone, so people's phones never contact another company.
//
// POST { from: "JPY", to: "AUD", date?: "2026-11-19" } → { rate: 0.0093, date: "2026-11-18", source: "ecb" }
// date is the day the rate is for; weekends and holidays get the last working day's rate.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

// Every currency Frankfurter has a rate for.
const CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
  'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Rates for a past day never change, so keep them while this server is warm.
const cache = new Map<string, { rate: number; date: string }>();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  // Signed-in people only.
  const authorization = req.headers.get('Authorization');
  if (!authorization) return reply(401, { error: 'Sign in first' });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: user } = await supabase.auth.getUser();
  if (!user?.user) return reply(401, { error: 'Sign in first' });

  let from: unknown, to: unknown, date: unknown;
  try {
    ({ from, to, date } = await req.json());
  } catch {
    return reply(400, { error: 'Send the two currencies' });
  }
  if (typeof from !== 'string' || typeof to !== 'string' || !CURRENCIES.has(from) || !CURRENCIES.has(to)) {
    return reply(400, { error: 'There’s no exchange rate for that currency' });
  }
  if (from === to) return reply(200, { rate: 1, date: new Date().toISOString().slice(0, 10), source: 'ecb' });
  const day = typeof date === 'string' && DATE_RE.test(date) ? date : null;

  const key = `${from}-${to}-${day ?? 'latest'}`;
  const hit = day ? cache.get(key) : undefined;
  if (hit) return reply(200, { ...hit, source: 'ecb' });

  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${day ?? 'latest'}?base=${from}&symbols=${to}`);
    if (!res.ok) return reply(502, { error: 'Couldn’t get today’s exchange rate. Type the rate or what your bank charged.' });
    const body = (await res.json()) as { date: string; rates: Record<string, number> };
    const rate = body.rates?.[to];
    if (typeof rate !== 'number' || !(rate > 0)) return reply(502, { error: 'Couldn’t get the exchange rate.' });
    const result = { rate, date: body.date };
    if (day) cache.set(key, result);
    return reply(200, { ...result, source: 'ecb' });
  } catch {
    return reply(502, { error: 'Couldn’t get today’s exchange rate. Type the rate or what your bank charged.' });
  }
});
