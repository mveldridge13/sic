/**
 * Joining with a group link and saying which guest you are ("Are you one of these people?").
 * Run against the LOCAL Supabase stack: npm run test:db
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const run = Math.random().toString(36).slice(2, 8);

type User = { client: SupabaseClient; id: string };
async function signUp(name: string): Promise<User> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email: `${name}-${run}@example.com`, password: 'correct-horse-battery', options: { data: { name } } });
  if (error || !data.user) throw error ?? new Error('no user');
  return { client, id: data.user.id };
}

describe('Joining with a group link as one of the guests', () => {
  let ester: User; // owner
  let maria: User; // was added by name as the guest "MV"
  let late: User; // joined as herself first, then says which guest she is
  let groupId: string;
  let mv: string;
  let lia: string;
  let link: string;

  const balances = async () =>
    Object.fromEntries(
      ((await ester.client.rpc('group_balances', { p_group_id: groupId })).data ?? []).map((r: { user_id: string; balance_cents: number }) => [r.user_id, r.balance_cents]),
    );

  beforeAll(async () => {
    [ester, maria, late] = await Promise.all([signUp('JEster'), signUp('JMaria'), signUp('JLate')]);
    const { data: g } = await ester.client.rpc('create_group', { p_name: 'Groceries', p_currency: 'AUD' });
    groupId = g.id;
    mv = (await ester.client.rpc('add_guest', { p_group_id: groupId, p_name: 'MV' })).data;
    lia = (await ester.client.rpc('add_guest', { p_group_id: groupId, p_name: 'Lia' })).data;
    // Veges $200, paid by Ester, half for MV. Lia paid $30 for herself and Ester.
    for (const e of [
      { p_description: 'Veges', p_amount_cents: 20000, p_payer_id: null as string | null, splits: [mv] },
      { p_description: 'Bread', p_amount_cents: 3000, p_payer_id: 'lia', splits: [lia] },
    ]) {
      const payer = e.p_payer_id === 'lia' ? lia : ester.id;
      const other = e.splits[0];
      const half = e.p_amount_cents / 2;
      const r = await ester.client.rpc('create_expense', {
        p_group_id: groupId, p_description: e.p_description, p_amount_cents: e.p_amount_cents, p_payer_id: payer, p_split_method: 'equal',
        p_splits: [{ user_id: ester.id, amount_cents: half }, { user_id: other, amount_cents: half }],
      });
      expect(r.error).toBeNull();
    }
    link = (await ester.client.rpc('create_invite', { p_group_id: groupId })).data;
  });

  it('the link shows the group’s guests to someone signed in', async () => {
    const { data, error } = await maria.client.rpc('invite_guests', { p_token: link });
    expect(error).toBeNull();
    expect(data.map((g: { guest_name: string }) => g.guest_name)).toEqual(['Lia', 'MV']);
    expect(data[0].group_name).toBe('Groceries');
    // Signed out: nothing.
    const anon = createClient(URL, ANON, { auth: { persistSession: false } });
    expect((await anon.rpc('invite_guests', { p_token: link })).data ?? []).toEqual([]);
  });

  it('joining as a guest takes over their share', async () => {
    const { data, error } = await maria.client.rpc('accept_invite', { p_token: link, p_guest_id: mv });
    expect(error).toBeNull();
    expect(data).toBe(groupId);
    const b = await balances();
    expect(b[maria.id]).toBe(-10000);
    expect(b[mv]).toBeUndefined();
    // MV isn't offered any more.
    const { data: left } = await late.client.rpc('invite_guests', { p_token: link });
    expect(left.map((g: { guest_name: string }) => g.guest_name)).toEqual(['Lia']);
  });

  it('a guest can’t be taken over twice', async () => {
    const { error } = await late.client.rpc('accept_invite', { p_token: link, p_guest_id: mv });
    expect(error?.message).toMatch(/already joined|isn’t a guest/);
  });

  it('someone who already joined as themselves can still say which guest they are', async () => {
    expect((await late.client.rpc('accept_invite', { p_token: link })).error).toBeNull();
    const { error } = await late.client.rpc('accept_invite', { p_token: link, p_guest_id: lia });
    expect(error).toBeNull();
    const b = await balances();
    expect(b[late.id]).toBe(1500); // Lia paid $30, her share $15
    expect(b[lia]).toBeUndefined();
    const { data: rows } = await ester.client.from('group_members').select('user_id').eq('group_id', groupId).eq('user_id', late.id);
    expect(rows).toHaveLength(1);
    const { data: bread } = await ester.client.from('expenses').select('payer_id').eq('description', 'Bread').single();
    expect(bread?.payer_id).toBe(late.id);
  });

  it('a guest from another group can’t be claimed with this link', async () => {
    const { data: other } = await ester.client.rpc('create_group', { p_name: 'Other', p_currency: 'AUD' });
    const leo = (await ester.client.rpc('add_guest', { p_group_id: other.id, p_name: 'Leo' })).data;
    const someone = await signUp('JSomeone');
    expect((await someone.client.rpc('accept_invite', { p_token: link, p_guest_id: leo })).error?.message).toMatch(/isn’t a guest in this group/);
  });
});
