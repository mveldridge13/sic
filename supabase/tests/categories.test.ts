/**
 * Expense categories: one of ten per expense, optional, and passed on by recurring expenses.
 *
 * Run against the LOCAL Supabase stack: npm run test:db
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const run = Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);

async function signUp(name: string): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email: `${name}-${run}@example.com`, password: 'correct-horse-battery', options: { data: { name } } });
  if (error || !data.user) throw error ?? new Error('no user');
  return { client, id: data.user.id };
}
type Who = Awaited<ReturnType<typeof signUp>>;

describe('Expense categories', () => {
  let kim: Who;
  let lou: Who;
  let groupId: string;
  const splits = () => [{ user_id: kim.id, amount_cents: 500 }, { user_id: lou.id, amount_cents: 500 }];
  const expense = (extra: Record<string, unknown>) =>
    kim.client.rpc('create_expense', { p_group_id: groupId, p_description: 'Dinner', p_amount_cents: 1000, p_payer_id: kim.id, p_split_method: 'equal', p_splits: splits(), ...extra });

  beforeAll(async () => {
    [kim, lou] = await Promise.all([signUp('CatKim'), signUp('CatLou')]);
    const { data: g } = await kim.client.rpc('create_group', { p_name: 'Flat', p_currency: 'AUD' });
    groupId = g.id;
    const { data: t } = await kim.client.rpc('create_invite', { p_group_id: groupId });
    await lou.client.rpc('accept_invite', { p_token: t });
  });

  it('saves a category, changes it on edit, and turns away made-up ones', async () => {
    const { data: id, error } = await expense({ p_category: 'food' });
    expect(error).toBeNull();
    expect((await lou.client.from('expenses').select('category').eq('id', id).single()).data?.category).toBe('food');
    const edit = await kim.client.rpc('update_expense', {
      p_expense_id: id, p_description: 'Dinner', p_amount_cents: 1000, p_payer_id: kim.id, p_split_method: 'equal',
      p_splits: splits(), p_occurred_at: new Date().toISOString(), p_category: 'entertainment',
    });
    expect(edit.error).toBeNull();
    expect((await kim.client.from('expenses').select('category').eq('id', id).single()).data?.category).toBe('entertainment');
    expect((await expense({ p_category: 'yachts' })).error).not.toBeNull();
  });

  it('is optional, so older apps keep working', async () => {
    const { data: id, error } = await expense({});
    expect(error).toBeNull();
    expect((await kim.client.from('expenses').select('category').eq('id', id).single()).data?.category).toBeNull();
  });

  it('a recurring expense passes its category on to each expense it adds', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const base = {
      p_description: 'Rent', p_payer_id: kim.id, p_split_method: 'equal',
      p_split_input: { method: 'equal', participants: [kim.id, lou.id] }, p_variable: false, p_amount_cents: 1000,
      p_splits: splits().map((s) => ({ ...s, weight: null })), p_items: null, p_frequency: 'monthly', p_end_date: null,
      p_remaining: null, p_heads_up_days: 0,
    };
    const { data: rid, error } = await kim.client.rpc('create_recurring', { ...base, p_group_id: groupId, p_start_date: tomorrow });
    expect(error).toBeNull();
    expect((await lou.client.rpc('set_recurring_category', { p_id: rid, p_category: 'home' })).error?.message).toMatch(/not found/);
    expect((await kim.client.rpc('set_recurring_category', { p_id: rid, p_category: 'home' })).error).toBeNull();
    // Bring it forward to today: it's added straight away, with its category.
    expect((await kim.client.rpc('update_recurring', { ...base, p_id: rid, p_next_date: today() })).error).toBeNull();
    const { data: added } = await kim.client.from('expenses').select('category').eq('recurring_id', rid);
    expect(added).toEqual([{ category: 'home' }]);
  });
});
