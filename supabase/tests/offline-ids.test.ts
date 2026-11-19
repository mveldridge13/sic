/**
 * Offline saving: an expense or payment made with no signal carries its own id, so sending it again
 * after a cut-off connection never saves it twice.
 *
 * Run against the LOCAL Supabase stack: npm run test:db
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
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

describe('Offline ids', () => {
  let ana: Who;
  let ben: Who;
  let groupId: string;

  beforeAll(async () => {
    [ana, ben] = await Promise.all([signUp('OffAna'), signUp('OffBen')]);
    groupId = (await ana.client.rpc('create_group', { p_name: 'Lisbon', p_currency: 'EUR' })).data.id;
    const { data: t } = await ana.client.rpc('create_invite', { p_group_id: groupId });
    await ben.client.rpc('accept_invite', { p_token: t });
  });

  const expense = (who: Who, id?: string, occurredAt?: string) =>
    who.client.rpc('create_expense', {
      p_group_id: groupId,
      p_description: 'Dinner',
      p_amount_cents: 11850,
      p_payer_id: who.id,
      p_split_method: 'equal',
      p_splits: [
        { user_id: ana.id, amount_cents: 5925 },
        { user_id: ben.id, amount_cents: 5925 },
      ],
      ...(occurredAt ? { p_occurred_at: occurredAt } : {}),
      ...(id ? { p_id: id } : {}),
    });

  it('saves an expense with the id the phone gave it, and the time it was entered', async () => {
    const id = randomUUID();
    const when = '2026-11-18T20:15:00.000Z';
    const { data, error } = await expense(ana, id, when);
    expect(error).toBeNull();
    expect(data).toBe(id);
    const row = (await ana.client.from('expenses').select('id, occurred_at').eq('id', id).single()).data;
    expect(new Date(row!.occurred_at).toISOString()).toBe(when);
  });

  it('sending the same expense again doesn’t save it twice', async () => {
    const id = randomUUID();
    expect((await expense(ana, id)).data).toBe(id);
    expect((await expense(ana, id)).data).toBe(id);
    const rows = (await ana.client.from('expenses').select('id').eq('id', id)).data;
    expect(rows).toHaveLength(1);
    const splits = (await ana.client.from('expense_splits').select('user_id').eq('expense_id', id)).data;
    expect(splits).toHaveLength(2);
  });

  it('someone else can’t reuse an id that’s taken', async () => {
    const id = randomUUID();
    await expense(ana, id);
    expect((await expense(ben, id)).error?.message).toMatch(/already taken/);
  });

  it('still works without an id (older apps)', async () => {
    const { data, error } = await expense(ana);
    expect(error).toBeNull();
    expect(data).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a payment sent twice is saved once, and only one confirm request goes out', async () => {
    const id = randomUUID();
    const pay = () =>
      ben.client.rpc('record_settlement', { p_group_id: groupId, p_from_user_id: ben.id, p_to_user_id: ana.id, p_amount_cents: 2000, p_id: id });
    expect((await pay()).data).toBe(id);
    expect((await pay()).data).toBe(id);
    expect((await ben.client.from('settlements').select('id').eq('id', id)).data).toHaveLength(1);
    const notes = (await ana.client.from('notifications').select('id').eq('settlement_id', id)).data;
    expect(notes).toHaveLength(1);
  });
});
