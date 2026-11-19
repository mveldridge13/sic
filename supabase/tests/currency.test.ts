/**
 * Currency conversion: an expense paid in another currency keeps what was paid and the locked
 * rate; balances use the converted amount. Items in another currency are checked against what
 * was paid. Older apps that don't send what was paid keep working.
 *
 * Run against the LOCAL Supabase stack: npm run test:db
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { convertMinor, convertSplit } from '@tally/shared';
import { beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const run = Math.random().toString(36).slice(2, 8);

async function signUp(name: string): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email: `${name}-${run}@example.com`, password: 'correct-horse-battery', options: { data: { name } } });
  if (error || !data.user) throw error ?? new Error('no user');
  return { client, id: data.user.id };
}
type Who = Awaited<ReturnType<typeof signUp>>;

describe('Currency conversion', () => {
  let ana: Who;
  let ben: Who;
  let groupId: string;

  beforeAll(async () => {
    [ana, ben] = await Promise.all([signUp('FxAna'), signUp('FxBen')]);
    const { data: g } = await ana.client.rpc('create_group', { p_name: 'Tokyo', p_currency: 'AUD' });
    groupId = g.id;
    const { data: t } = await ana.client.rpc('create_invite', { p_group_id: groupId });
    await ben.client.rpc('accept_invite', { p_token: t });
  });

  const original = (amount: number, rate: number, extra: Record<string, unknown> = {}) => ({
    currency: 'JPY', amount, rate, rate_date: '2026-11-18', source: 'ecb', ...extra,
  });

  it('keeps what was paid and the rate, and balances use the converted amount', async () => {
    const aud = convertMinor(10_000, 'JPY', 'AUD', 0.00931); // ¥10,000 → A$93.10
    const half = aud / 2;
    const { data: id, error } = await ana.client.rpc('create_expense', {
      p_group_id: groupId, p_description: 'Ramen', p_amount_cents: aud, p_payer_id: ana.id, p_split_method: 'equal',
      p_splits: [{ user_id: ana.id, amount_cents: half }, { user_id: ben.id, amount_cents: half }],
      p_original: original(10_000, 0.00931),
    });
    expect(error).toBeNull();
    const { data: row } = await ana.client.from('expenses').select('amount_cents, original_currency, original_amount, exchange_rate, rate_date, rate_source').eq('id', id).single();
    expect(row).toMatchObject({ amount_cents: 9310, original_currency: 'JPY', original_amount: 10_000, rate_date: '2026-11-18', rate_source: 'ecb' });
    expect(Number(row?.exchange_rate)).toBeCloseTo(0.00931, 10);
    const { data: sums } = await ben.client.rpc('my_group_summaries');
    expect((sums as { group_id: string; my_balance: number }[]).find((g) => g.group_id === groupId)?.my_balance).toBe(-4655);
  });

  it('checks items against what was paid, not the converted amount', async () => {
    const items = [{ name: 'Sushi', amount_cents: 6000, user_ids: [ben.id] }, { name: 'Beer', amount_cents: 2000, user_ids: [ana.id] }];
    const aud = convertMinor(9000, 'JPY', 'AUD', 0.00931);
    const shares = convertSplit(aud, 9000, {
      method: 'items', items: items.map((i) => ({ name: i.name, amount: i.amount_cents, userIds: i.user_ids })), rest: 'proportional',
    });
    const { error } = await ana.client.rpc('create_expense', {
      p_group_id: groupId, p_description: 'Dinner', p_amount_cents: aud, p_payer_id: ana.id, p_split_method: 'items',
      p_splits: shares.map((s) => ({ user_id: s.userId, amount_cents: s.amount })), p_items: items, p_original: original(9000, 0.00931),
    });
    // ¥8,000 of items is under ¥9,000 paid, though it's far more than the A$83.79 it converts to.
    expect(error).toBeNull();
  });

  it('turns away nonsense', async () => {
    const base = { p_group_id: groupId, p_description: 'Bad', p_amount_cents: 100, p_payer_id: ana.id, p_split_method: 'equal', p_splits: [{ user_id: ana.id, amount_cents: 100 }] };
    expect((await ana.client.rpc('create_expense', { ...base, p_original: original(100, 0) })).error?.message).toMatch(/more than zero/);
    expect((await ana.client.rpc('create_expense', { ...base, p_original: original(0, 1) })).error?.message).toMatch(/what you paid/);
    expect((await ana.client.rpc('create_expense', { ...base, p_original: original(100, 1, { currency: 'AUD' }) })).error?.message).toMatch(/already the group/);
    expect((await ana.client.rpc('create_expense', { ...base, p_original: original(100, 1, { source: 'guess' }) })).error?.message).toMatch(/source/);
  });

  it('older apps that don’t send what was paid still work, and editing can drop the currency', async () => {
    const { data: id, error } = await ana.client.rpc('create_expense', {
      p_group_id: groupId, p_description: 'Taxi', p_amount_cents: 2000, p_payer_id: ana.id, p_split_method: 'equal',
      p_splits: [{ user_id: ana.id, amount_cents: 1000 }, { user_id: ben.id, amount_cents: 1000 }],
    });
    expect(error).toBeNull();
    const edit = await ana.client.rpc('update_expense', {
      p_expense_id: id, p_description: 'Taxi', p_amount_cents: 1862, p_payer_id: ana.id, p_split_method: 'equal',
      p_splits: [{ user_id: ana.id, amount_cents: 931 }, { user_id: ben.id, amount_cents: 931 }], p_occurred_at: new Date().toISOString(),
      p_original: original(2000, 0.00931, { source: 'manual', rate_date: null }),
    });
    expect(edit.error).toBeNull();
    const { data: row } = await ana.client.from('expenses').select('original_currency, rate_source').eq('id', id).single();
    expect(row).toMatchObject({ original_currency: 'JPY', rate_source: 'manual' });
  });
});
