/**
 * Deleting your account (tester feedback, 25 Nov 2026): no need to settle up first. In each group
 * your place goes to a numbered stand-in ("Deleted member 1", "Deleted member 2"…), so balances
 * and pending payments stay; your name, login, personal data and receipt photos go; groups you
 * own pass to someone else; the owner or a co-owner answers payments that were waiting for you.
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
type Member = { user_id: string; role: string; left_at: string | null; profiles: { name: string; is_guest: boolean; deleted_at: string | null } };

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

const members = async (who: User, groupId: string) =>
  ((await who.client.from('group_members').select('user_id, role, left_at, profiles ( name, is_guest, deleted_at )').eq('group_id', groupId)).data ??
    []) as unknown as Member[];

describe('Deleting your account', () => {
  let alice: User; // deletes her account while Bob still owes her
  let bob: User;
  let cara: User;
  let dan: User; // deletes his account later, in the same group
  let shared: string; // Alice owns; Bob and Dan members, Cara co-owner
  let solo: string; // Alice owns; only a guest besides her
  let bobs: string; // Bob owns; Alice member, all square
  let dinner: string;
  let pending: string; // Bob → Alice, waiting for her to confirm
  let rent: string; // repeating, Bob pays, split with Alice
  let receipt: string;
  let aliceInvite: string;

  beforeAll(async () => {
    [alice, bob, cara, dan] = await Promise.all([signUp('DelAlice'), signUp('DelBob'), signUp('DelCara'), signUp('DelDan')]);
    shared = await groupWith(alice, [bob, cara, dan], 'House');
    await alice.client.rpc('set_co_owner', { p_group_id: shared, p_user_id: cara.id, p_co_owner: true });
    solo = await groupWith(alice, [], 'Just me');
    await alice.client.rpc('add_guest', { p_group_id: solo, p_name: 'Gus' });
    bobs = await groupWith(bob, [alice], 'Trip');
    await alice.client.rpc('set_payid', { p_type: 'phone', p_value: '0412345678' });

    // Alice paid 20.00 for dinner with Bob: he owes her 10.00. Her photo of the receipt is on it.
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
    receipt = `${shared}/${crypto.randomUUID()}.jpg`;
    expect((await alice.client.storage.from('receipts').upload(receipt, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { contentType: 'image/jpeg' })).error).toBeNull();
    expect((await alice.client.rpc('set_expense_receipt', { p_expense_id: dinner, p_path: receipt })).error).toBeNull();

    // Bob says he paid back 4.00 of it; Alice hasn't confirmed yet.
    const pay = await bob.client.rpc('record_settlement', { p_group_id: shared, p_from_user_id: bob.id, p_to_user_id: alice.id, p_amount_cents: 400 });
    expect(pay.error).toBeNull();
    pending = pay.data;

    // Rent repeats monthly: Bob pays, split with Alice.
    const r = await bob.client.rpc('create_recurring', {
      p_group_id: shared,
      p_description: 'Rent',
      p_payer_id: bob.id,
      p_split_method: 'equal',
      p_split_input: { method: 'equal', participants: [alice.id, bob.id] },
      p_variable: false,
      p_amount_cents: 1000,
      p_splits: [
        { user_id: alice.id, amount_cents: 500 },
        { user_id: bob.id, amount_cents: 500 },
      ],
      p_items: null,
      p_frequency: 'monthly',
      p_start_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
      p_end_date: null,
      p_remaining: null,
      p_heads_up_days: 0,
    });
    expect(r.error).toBeNull();
    rent = r.data;

    const inv = await alice.client.rpc('create_invite', { p_group_id: shared });
    aliceInvite = inv.data;
  });

  it('works without settling up first', async () => {
    const { error } = await alice.client.rpc('delete_my_account');
    expect(error).toBeNull();
  });

  it('she can no longer sign in', async () => {
    const fresh = createClient(URL, ANON, { auth: { persistSession: false } });
    const { error } = await fresh.auth.signInWithPassword({ email: emailOf('DelAlice'), password: PASSWORD });
    expect(error).not.toBeNull();
  });

  it('her name is gone: her profile no longer exists', async () => {
    expect((await bob.client.from('profiles').select('id').eq('id', alice.id)).data).toEqual([]);
    expect((await cara.client.from('group_members').select('user_id').eq('user_id', alice.id)).data).toEqual([]);
  });

  it('her owned group passes to the co-owner, and "Deleted member 1" takes her place', async () => {
    const list = await members(cara, shared);
    expect(list.find((m) => m.user_id === cara.id)?.role).toBe('owner');
    const stand = list.find((m) => m.profiles.name === 'Deleted member 1');
    expect(stand).toBeDefined();
    expect(stand!.profiles.is_guest).toBe(true);
    expect(stand!.profiles.deleted_at).not.toBeNull();
    // Still owed money, so still in the group.
    expect(stand!.left_at).toBeNull();
    expect(stand!.role).toBe('member');
  });

  it('balances are unchanged: Bob still owes the deleted member 10.00', async () => {
    const list = await members(cara, shared);
    const standId = list.find((m) => m.profiles.name === 'Deleted member 1')!.user_id;
    const { data: e } = await cara.client.from('expenses').select('payer_id, created_by, description').eq('id', dinner).single();
    expect(e).toMatchObject({ payer_id: standId, created_by: standId, description: 'Dinner' });
    const { data } = await cara.client.rpc('group_balances', { p_group_id: shared });
    const byId = Object.fromEntries((data ?? []).map((r: { user_id: string; balance_cents: number }) => [r.user_id, Number(r.balance_cents)]));
    expect(byId[standId]).toBe(1000);
    expect(byId[bob.id]).toBe(-1000);
  });

  it('the new owner is told the group is theirs, by the deleted member', async () => {
    const { data } = await cara.client.rpc('my_notifications');
    const note = (data as { kind: string; group_id: string; actor_name: string }[]).find((n) => n.kind === 'owner_handed_over');
    expect(note).toMatchObject({ group_id: shared, actor_name: 'Deleted member 1' });
    const { data: bobs } = await bob.client.rpc('my_notifications');
    expect((bobs as { kind: string }[]).some((n) => n.kind === 'owner_handed_over')).toBe(false);
  });

  it('the pending payment stays pending, and the owner answers it', async () => {
    const { data: s } = await cara.client.from('settlements').select('status').eq('id', pending).single();
    expect(s?.status).toBe('pending');

    // Cara (now owner) is asked to confirm it, on the deleted member's behalf.
    const { data: list } = await cara.client.rpc('payments_to_confirm');
    expect(list).toEqual([expect.objectContaining({ id: pending, from_user_id: bob.id, to_name: 'Deleted member 1' })]);
    const { data: notes } = await cara.client.rpc('my_notifications');
    expect((notes as { kind: string; settlement_id: string }[]).some((n) => n.kind === 'payment_to_confirm' && n.settlement_id === pending)).toBe(true);

    // Bob paid it, so he can't confirm it himself (he isn't the owner).
    expect((await bob.client.rpc('respond_to_payment', { p_settlement_id: pending, p_received: true })).error).not.toBeNull();
    expect((await cara.client.rpc('respond_to_payment', { p_settlement_id: pending, p_received: true })).error).toBeNull();

    const { data: done } = await cara.client.from('settlements').select('status, responded_by').eq('id', pending).single();
    expect(done).toEqual({ status: 'recorded', responded_by: cara.id });
    // Bob is told who confirmed it.
    const { data: bobNotes } = await bob.client.rpc('my_notifications');
    expect((bobNotes as { kind: string; actor_name: string }[]).find((n) => n.kind === 'payment_confirmed')).toMatchObject({ actor_name: 'DelCara' });
  });

  it('her receipt photo is deleted, and the expense keeps what was read from it', async () => {
    const { data: e } = await cara.client.from('expenses').select('receipt_path, description, amount_cents').eq('id', dinner).single();
    expect(e).toEqual({ receipt_path: null, description: 'Dinner', amount_cents: 2000 });
    const res = await fetch(`${URL}/functions/v1/empty-receipt-trash`, { method: 'POST', headers: { Authorization: `Bearer ${ANON}` } });
    expect(res.status).toBe(200);
    // The owner could read it while it was on the expense; now the file is gone.
    expect((await cara.client.storage.from('receipts').download(receipt)).error).not.toBeNull();
  });

  it('repeating expenses she was in are paused, and point at the stand-in', async () => {
    const { data } = await bob.client.from('recurring_expenses').select('paused, stopped_at, splits, split_input').eq('id', rent).single();
    expect(data?.paused).toBe(true);
    expect(data?.stopped_at).toBeNull();
    expect(JSON.stringify(data)).not.toContain(alice.id);
  });

  it('invites she made stop working', async () => {
    const outsider = await signUp('DelOutsider');
    expect((await outsider.client.rpc('accept_invite', { p_token: aliceInvite })).error).not.toBeNull();
  });

  it('in a group where she was square, her stand-in has left, numbered within that group', async () => {
    const list = await members(bob, bobs);
    const stand = list.find((m) => m.profiles.name === 'Deleted member 1');
    expect(stand).toBeDefined();
    expect(stand!.left_at).not.toBeNull();
  });

  it('a second deleted member in the same group is "Deleted member 2"', async () => {
    expect((await dan.client.rpc('delete_my_account')).error).toBeNull();
    const names = (await members(cara, shared)).filter((m) => m.profiles.deleted_at).map((m) => m.profiles.name).sort();
    expect(names).toEqual(['Deleted member 1', 'Deleted member 2']);
  });

  it("a stand-in can't be sent an invite or a view link", async () => {
    const standId = (await members(cara, shared)).find((m) => m.profiles.name === 'Deleted member 1')!.user_id;
    expect((await cara.client.rpc('create_invite', { p_group_id: shared, p_guest_id: standId })).error).not.toBeNull();
    expect((await cara.client.rpc('guest_link', { p_group_id: shared, p_guest_id: standId })).error).not.toBeNull();
  });

  it('a group with nobody else with an account is deleted', async () => {
    const { data } = await bob.client.rpc('my_group_summaries');
    expect(JSON.stringify(data)).not.toContain(solo);
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

  it('works in a closed group too', async () => {
    const [eve, fay] = await Promise.all([signUp('DelEve'), signUp('DelFay')]);
    const g = await groupWith(eve, [fay], 'Old trip');
    await fay.client.rpc('create_expense', {
      p_group_id: g,
      p_description: 'Taxi',
      p_amount_cents: 1000,
      p_payer_id: fay.id,
      p_split_method: 'equal',
      p_splits: [
        { user_id: eve.id, amount_cents: 500 },
        { user_id: fay.id, amount_cents: 500 },
      ],
    });
    // Eve pays Fay back, so the group can be closed.
    expect((await fay.client.rpc('record_settlement', { p_group_id: g, p_from_user_id: eve.id, p_to_user_id: fay.id, p_amount_cents: 500 })).error).toBeNull();
    expect((await eve.client.rpc('close_group', { p_group_id: g })).error).toBeNull();
    expect((await fay.client.rpc('delete_my_account')).error).toBeNull();
    const list = await members(eve, g);
    const stand = list.find((m) => m.profiles.name === 'Deleted member 1');
    expect(stand).toBeDefined();
    const { data: e } = await eve.client.from('expenses').select('payer_id').eq('group_id', g).single();
    expect(e?.payer_id).toBe(stand!.user_id);
  });
});
