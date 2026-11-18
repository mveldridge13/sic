/**
 * Deleting your account: blocked until you're settled everywhere; then your login and personal
 * data go, groups you own pass to someone else, and the money history keeps your name.
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
const PASSWORD = 'correct-horse-battery';
const emailOf = (name: string) => `${name}-${run}@example.com`;

type User = { client: SupabaseClient; id: string };

async function signUp(name: string): Promise<User> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email: emailOf(name), password: PASSWORD, options: { data: { name } } });
  if (error || !data.user) throw error ?? new Error('no user');
  return { client, id: data.user.id };
}

async function groupWith(owner: User, others: User[], name: string): Promise<string> {
  const { data: g } = await owner.client.rpc('create_group', { p_name: name, p_currency: 'AUD' });
  for (const u of others) {
    const { data: t } = await owner.client.rpc('create_invite', { p_group_id: g.id });
    await u.client.rpc('accept_invite', { p_token: t });
  }
  return g.id;
}

describe('Deleting your account', () => {
  let alice: User; // deletes her account
  let bob: User;
  let cara: User;
  let shared: string; // Alice owns; Bob member, Cara co-owner
  let solo: string; // Alice owns; only a guest besides her
  let bobs: string; // Bob owns; Alice member
  let dinner: string;

  beforeAll(async () => {
    [alice, bob, cara] = await Promise.all([signUp('DelAlice'), signUp('DelBob'), signUp('DelCara')]);
    shared = await groupWith(alice, [bob, cara], 'House');
    await alice.client.rpc('set_co_owner', { p_group_id: shared, p_user_id: cara.id, p_co_owner: true });
    solo = await groupWith(alice, [], 'Just me');
    await alice.client.rpc('add_guest', { p_group_id: solo, p_name: 'Gus' });
    bobs = await groupWith(bob, [alice], 'Trip');
    await alice.client.rpc('set_payid', { p_type: 'phone', p_value: '0412345678' });

    const { data, error } = await alice.client.rpc('create_expense', {
      p_group_id: shared,
      p_description: 'Dinner',
      p_amount_cents: 2000,
      p_payer_id: alice.id,
      p_split_method: 'equal',
      p_splits: [
        { user_id: alice.id, amount_cents: 1000 },
        { user_id: bob.id, amount_cents: 1000 },
      ],
    });
    expect(error).toBeNull();
    dinner = data;
  });

  it('is refused while you are owed or owe money, naming the groups', async () => {
    const { error } = await alice.client.rpc('delete_my_account');
    expect(error?.message).toMatch(/Settle up first.*House/);
    // Nothing changed.
    const { data } = await bob.client.from('group_members').select('user_id, left_at').eq('group_id', shared).eq('user_id', alice.id).single();
    expect(data?.left_at).toBeNull();
  });

  it('works once settled', async () => {
    // Bob pays Alice back; Alice records it, so it counts straight away.
    const pay = await alice.client.rpc('record_settlement', { p_group_id: shared, p_from_user_id: bob.id, p_to_user_id: alice.id, p_amount_cents: 1000 });
    expect(pay.error).toBeNull();
    // A pending payment nobody could confirm after she goes.
    const pending = await bob.client.rpc('record_settlement', { p_group_id: bobs, p_from_user_id: bob.id, p_to_user_id: alice.id, p_amount_cents: 500 });
    expect(pending.error).toBeNull();

    const { error } = await alice.client.rpc('delete_my_account');
    expect(error).toBeNull();

    const { data: p } = await bob.client.from('settlements').select('status').eq('id', pending.data).single();
    expect(p?.status).toBe('voided');
  });

  it('she can no longer sign in', async () => {
    const fresh = createClient(URL, ANON, { auth: { persistSession: false } });
    const { error } = await fresh.auth.signInWithPassword({ email: emailOf('DelAlice'), password: PASSWORD });
    expect(error).not.toBeNull();
  });

  it('her owned group passes to the co-owner, and she has left it', async () => {
    const { data } = await bob.client.from('group_members').select('user_id, role, left_at').eq('group_id', shared);
    const byId = Object.fromEntries((data ?? []).map((m) => [m.user_id, m]));
    expect(byId[cara.id].role).toBe('owner');
    expect(byId[alice.id].left_at).not.toBeNull();
    expect(byId[alice.id].role).toBe('member');
  });

  it('a group with nobody else with an account is deleted', async () => {
    const { data } = await bob.client.rpc('my_group_summaries');
    expect(JSON.stringify(data)).not.toContain(solo);
  });

  it('the history stays and still shows her name', async () => {
    const { data: e } = await cara.client.from('expenses').select('payer_id').eq('id', dinner).single();
    expect(e?.payer_id).toBe(alice.id);
    const { data: p } = await bob.client.from('profiles').select('name, deleted_at').eq('id', alice.id).single();
    expect(p?.name).toBe('DelAlice');
    expect(p?.deleted_at).not.toBeNull();
  });

  it('her balances are still square for everyone else', async () => {
    const { data } = await bob.client.rpc('group_balances', { p_group_id: shared });
    for (const row of data ?? []) expect(Number(row.balance_cents)).toBe(0);
  });

  it('she is no longer offered as someone to add', async () => {
    const { data } = await bob.client.rpc('split_partners');
    expect((data ?? []).map((r: { user_id: string }) => r.user_id)).not.toContain(alice.id);
    const { error } = await bob.client.rpc('add_members', { p_group_id: bobs, p_user_ids: [alice.id] });
    expect(error).not.toBeNull();
  });

  it('her PayID is gone', async () => {
    const { data } = await cara.client.from('payment_methods').select('user_id').eq('user_id', alice.id);
    expect(data ?? []).toEqual([]);
  });
});
