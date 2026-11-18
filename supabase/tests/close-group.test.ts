/**
 * Closing a group: the owner or a co-owner ends it for everyone, only once everyone's square.
 * A closed group is read-only, and repeating expenses wait until it's reopened.
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

async function signUp(name: string): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email: `${name}-${run}@example.com`, password: 'correct-horse-battery', options: { data: { name } } });
  if (error || !data.user) throw error ?? new Error('no user');
  return { client, id: data.user.id };
}
type Who = Awaited<ReturnType<typeof signUp>>;

const today = () => new Date().toISOString().slice(0, 10);

describe('Closing a group', () => {
  let alice: Who; // owner
  let bob: Who; // co-owner
  let cara: Who; // member
  let groupId: string;

  const expense = (who: Who, cents: number) =>
    who.client.rpc('create_expense', {
      p_group_id: groupId,
      p_description: 'Tree',
      p_amount_cents: cents,
      p_payer_id: who.id,
      p_split_method: 'equal',
      p_splits: [alice, bob, cara].map((p) => ({ user_id: p.id, amount_cents: cents / 3 })),
    });
  const closedAt = async () => (await alice.client.from('groups').select('closed_at, closed_by').eq('id', groupId).single()).data;
  const expenseCount = async () => (await alice.client.from('expenses').select('id').eq('group_id', groupId)).data?.length ?? 0;

  beforeAll(async () => {
    [alice, bob, cara] = await Promise.all([signUp('CloseAlice'), signUp('CloseBob'), signUp('CloseCara')]);
    const { data: g } = await alice.client.rpc('create_group', { p_name: 'Christmas', p_currency: 'AUD' });
    groupId = g.id;
    for (const who of [bob, cara]) {
      const { data: t } = await alice.client.rpc('create_invite', { p_group_id: groupId });
      await who.client.rpc('accept_invite', { p_token: t });
    }
    await alice.client.rpc('set_co_owner', { p_group_id: groupId, p_user_id: bob.id, p_co_owner: true });
    expect((await expense(alice, 9000)).error).toBeNull();
  });

  it('can’t be closed while someone owes money', async () => {
    const { error } = await alice.client.rpc('close_group', { p_group_id: groupId });
    expect(error?.message).toMatch(/square/);
    expect((await closedAt())?.closed_at).toBeNull();
  });

  it('can’t be closed while a payment is waiting to be confirmed', async () => {
    // Bob says he paid; Alice hasn't confirmed yet.
    const { error: payErr } = await bob.client.rpc('record_settlement', {
      p_group_id: groupId, p_from_user_id: bob.id, p_to_user_id: alice.id, p_amount_cents: 3000,
    });
    expect(payErr).toBeNull();
    // Cara's payment is recorded by Alice, who received it.
    await alice.client.rpc('record_settlement', { p_group_id: groupId, p_from_user_id: cara.id, p_to_user_id: alice.id, p_amount_cents: 3000 });
    const { error } = await alice.client.rpc('close_group', { p_group_id: groupId });
    expect(error?.message).toMatch(/square|waiting/);
  });

  it('a member can’t close it, the co-owner can once everyone’s square', async () => {
    const { data: pending } = await alice.client.from('settlements').select('id').eq('group_id', groupId).eq('status', 'pending').single();
    expect((await alice.client.rpc('respond_to_payment', { p_settlement_id: pending!.id, p_received: true })).error).toBeNull();

    const byCara = await cara.client.rpc('close_group', { p_group_id: groupId });
    expect(byCara.error?.message).toMatch(/owner or a co-owner/);

    expect((await bob.client.rpc('close_group', { p_group_id: groupId })).error).toBeNull();
    const row = await closedAt();
    expect(row?.closed_at).not.toBeNull();
    expect(row?.closed_by).toBe(bob.id);
    // Everyone in the group sees it closed.
    const { data: asCara } = await cara.client.from('groups').select('closed_at').eq('id', groupId).single();
    expect(asCara?.closed_at).not.toBeNull();
  });

  it('nothing can be added, changed or undone once it’s closed', async () => {
    expect((await expense(cara, 300)).error?.message).toMatch(/closed/);
    const { data: e } = await alice.client.from('expenses').select('id').eq('group_id', groupId).single();
    expect((await alice.client.rpc('delete_expense', { p_expense_id: e!.id })).error?.message).toMatch(/closed/);
    const pay = await alice.client.rpc('record_settlement', { p_group_id: groupId, p_from_user_id: cara.id, p_to_user_id: alice.id, p_amount_cents: 100 });
    expect(pay.error?.message).toMatch(/closed/);
    const { data: s } = await alice.client.from('settlements').select('id').eq('group_id', groupId).eq('status', 'recorded').limit(1).single();
    expect((await alice.client.rpc('void_settlement', { p_settlement_id: s!.id })).error?.message).toMatch(/closed/);
    expect(await expenseCount()).toBe(1);
  });

  it('a member can’t reopen it; the owner can, and then it works as before', async () => {
    expect((await cara.client.rpc('reopen_group', { p_group_id: groupId })).error?.message).toMatch(/owner or a co-owner/);
    expect((await alice.client.rpc('reopen_group', { p_group_id: groupId })).error).toBeNull();
    expect((await closedAt())?.closed_at).toBeNull();
    expect((await expense(cara, 300)).error).toBeNull();
    expect(await expenseCount()).toBe(2);
  });

  it('a repeating expense waits while the group is closed and carries on after', async () => {
    // Square everyone again (Cara paid 300, so Alice and Bob each owe her 100).
    for (const who of [alice, bob]) {
      await cara.client.rpc('record_settlement', { p_group_id: groupId, p_from_user_id: who.id, p_to_user_id: cara.id, p_amount_cents: 100 });
    }
    expect((await alice.client.rpc('close_group', { p_group_id: groupId })).error).toBeNull();

    // Can't set one up in a closed group.
    const create = (start: string) =>
      alice.client.rpc('create_recurring', {
        p_group_id: groupId,
        p_description: 'Lights',
        p_payer_id: alice.id,
        p_split_method: 'equal',
        p_split_input: { method: 'equal', participants: [alice.id, bob.id, cara.id] },
        p_variable: false,
        p_amount_cents: 900,
        p_splits: [alice, bob, cara].map((p) => ({ user_id: p.id, amount_cents: 300, weight: null })),
        p_items: null,
        p_frequency: 'weekly',
        p_start_date: start,
        p_end_date: null,
        p_remaining: null,
        p_heads_up_days: 0,
      });
    expect((await create(today())).error?.message).toMatch(/closed/);

    // Reopen, set one up starting next week, close again: nothing is added while closed.
    await alice.client.rpc('reopen_group', { p_group_id: groupId });
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const { data: rid, error } = await create(nextWeek);
    expect(error).toBeNull();
    expect((await alice.client.rpc('close_group', { p_group_id: groupId })).error).toBeNull();
    const before = await expenseCount();
    // Bring it forward to today while closed: it's due, but nothing is added and it isn't paused.
    const { error: editErr } = await alice.client.rpc('update_recurring', {
      p_id: rid, p_description: 'Lights', p_payer_id: alice.id, p_split_method: 'equal',
      p_split_input: { method: 'equal', participants: [alice.id, bob.id, cara.id] }, p_variable: false,
      p_amount_cents: 900, p_splits: [alice, bob, cara].map((p) => ({ user_id: p.id, amount_cents: 300, weight: null })),
      p_items: null, p_frequency: 'weekly', p_end_date: null, p_remaining: null, p_heads_up_days: 0, p_next_date: today(),
    });
    expect(editErr).toBeNull();
    const { data: r } = await alice.client.from('recurring_expenses').select('paused, stopped_at, next_date').eq('id', rid).single();
    expect(r).toMatchObject({ paused: false, stopped_at: null, next_date: today() });
    expect(await expenseCount()).toBe(before);

    // Reopened: today's one goes in, once.
    expect((await alice.client.rpc('reopen_group', { p_group_id: groupId })).error).toBeNull();
    const { data: added } = await alice.client.from('expenses').select('id').eq('recurring_id', rid);
    expect(added).toHaveLength(1);
    expect(await expenseCount()).toBe(before + 1);
  });
});
