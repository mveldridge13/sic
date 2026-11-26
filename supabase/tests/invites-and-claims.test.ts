/**
 * Invites and taking a guest's place (tester feedback, 25 Nov 2026):
 *   - a group link only lets you join as yourself, and doesn't show who the guests are
 *   - a guest's place is taken with an invite sent to that guest, or by the owner merging them
 *   - the owner and co-owners see open invites, can turn them off or replace them, are told when
 *     someone joins, and can undo someone taking a guest's place
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
type Note = { kind: string; actor_name: string; claim_id: string | null; claim_guest_name: string | null; claim_undone: boolean; claim_via: string | null };
async function signUp(name: string): Promise<User> {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email: `${name}-${run}@example.com`, password: 'correct-horse-battery', options: { data: { name } } });
  if (error || !data.user) throw error ?? new Error('no user');
  return { client, id: data.user.id };
}
const notes = async (who: User) => ((await who.client.rpc('my_notifications')).data ?? []) as Note[];

describe('Invites and taking a guest’s place', () => {
  let ester: User; // owner
  let cohost: User; // co-owner
  let maria: User; // was added by name as the guest "MV"
  let late: User; // joins with the group link as herself
  let wrong: User; // uses MV's invite by mistake
  let groupId: string;
  let mv: string;
  let lia: string;
  let link: string;

  const balances = async () =>
    Object.fromEntries(
      ((await ester.client.rpc('group_balances', { p_group_id: groupId })).data ?? []).map((r: { user_id: string; balance_cents: number }) => [r.user_id, r.balance_cents]),
    );

  beforeAll(async () => {
    [ester, cohost, maria, late, wrong] = await Promise.all([signUp('JEster'), signUp('JCohost'), signUp('JMaria'), signUp('JLate'), signUp('JWrong')]);
    const { data: g } = await ester.client.rpc('create_group', { p_name: 'Groceries', p_currency: 'AUD' });
    groupId = g.id;
    const t = (await ester.client.rpc('create_invite', { p_group_id: groupId })).data;
    await cohost.client.rpc('accept_invite', { p_token: t });
    await ester.client.rpc('set_co_owner', { p_group_id: groupId, p_user_id: cohost.id, p_co_owner: true });
    mv = (await ester.client.rpc('add_guest', { p_group_id: groupId, p_name: 'MV' })).data;
    lia = (await ester.client.rpc('add_guest', { p_group_id: groupId, p_name: 'Lia' })).data;
    // Veges $200, paid by Ester, half for MV. Lia paid $30 for herself and Ester.
    for (const [description, amount, payer, other] of [
      ['Veges', 20000, ester.id, mv],
      ['Bread', 3000, lia, lia],
    ] as const) {
      const r = await ester.client.rpc('create_expense', {
        p_group_id: groupId, p_description: description, p_amount_cents: amount, p_payer_id: payer, p_split_method: 'equal',
        p_splits: [{ user_id: ester.id, amount_cents: amount / 2 }, { user_id: other, amount_cents: amount / 2 }],
      });
      expect(r.error).toBeNull();
    }
    link = (await ester.client.rpc('create_invite', { p_group_id: groupId })).data;
  });

  it('a group link doesn’t show who the guests are', async () => {
    const { data, error } = await late.client.rpc('invite_guests', { p_token: link });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('a group link can’t be used to take a guest’s place', async () => {
    const { error } = await late.client.rpc('accept_invite', { p_token: link, p_guest_id: mv });
    expect(error?.message).toMatch(/ask the owner for your own invite/);
    expect((await balances())[mv]).toBe(-10000);
  });

  it('joining with a group link adds you as yourself, and tells the owner and co-owner', async () => {
    expect((await late.client.rpc('accept_invite', { p_token: link })).error).toBeNull();
    const b = await balances();
    expect(b[late.id]).toBe(0);
    expect(b[mv]).toBe(-10000);
    for (const who of [ester, cohost]) {
      expect((await notes(who)).find((n) => n.kind === 'member_joined' && n.actor_name === 'JLate')).toBeDefined();
    }
    expect((await notes(late)).some((n) => n.kind === 'member_joined')).toBe(false);
  });

  it('an invite sent to a guest takes over their share, and the owner is told', async () => {
    const forMv = (await ester.client.rpc('create_invite', { p_group_id: groupId, p_guest_id: mv })).data;
    expect((await wrong.client.rpc('accept_invite', { p_token: forMv })).error).toBeNull();
    const b = await balances();
    expect(b[wrong.id]).toBe(-10000);
    expect(b[mv]).toBeUndefined();
    const note = (await notes(ester)).find((n) => n.kind === 'guest_claimed');
    expect(note).toMatchObject({ actor_name: 'JWrong', claim_guest_name: 'MV', claim_undone: false });
    // The invite was for MV only: it can't be used again.
    expect((await maria.client.rpc('accept_invite', { p_token: forMv })).error).not.toBeNull();
  });

  it('the owner can undo it: MV is back, and the wrong person leaves', async () => {
    const note = (await notes(ester)).find((n) => n.kind === 'guest_claimed')!;
    // Only the owner or a co-owner.
    expect((await wrong.client.rpc('undo_guest_claim', { p_claim_id: note.claim_id })).error).not.toBeNull();
    expect((await ester.client.rpc('undo_guest_claim', { p_claim_id: note.claim_id })).error).toBeNull();
    const b = await balances();
    expect(b[mv]).toBe(-10000);
    expect(b[wrong.id] ?? 0).toBe(0);
    const { data: row } = await ester.client.from('group_members').select('left_at').eq('group_id', groupId).eq('user_id', wrong.id).single();
    expect(row?.left_at).not.toBeNull();
    const { data: guest } = await ester.client.from('profiles').select('claimed_by').eq('id', mv).single();
    expect(guest?.claimed_by).toBeNull();
    expect((await notes(wrong)).some((n) => n.kind === 'claim_undone')).toBe(true);
    // Shown as undone; can't be undone twice.
    expect((await notes(ester)).find((n) => n.kind === 'guest_claimed')?.claim_undone).toBe(true);
    expect((await ester.client.rpc('undo_guest_claim', { p_claim_id: note.claim_id })).error).not.toBeNull();
  });

  it('a fresh invite for MV works for the right person', async () => {
    const forMv = (await ester.client.rpc('create_invite', { p_group_id: groupId, p_guest_id: mv })).data;
    expect((await maria.client.rpc('accept_invite', { p_token: forMv })).error).toBeNull();
    expect((await balances())[maria.id]).toBe(-10000);
  });

  it('the owner or co-owner can merge a member with a guest', async () => {
    // Late joined as herself; she's really Lia. A plain member can't do it.
    expect((await late.client.rpc('merge_guest', { p_group_id: groupId, p_guest_id: lia, p_user_id: late.id })).error).not.toBeNull();
    expect((await cohost.client.rpc('merge_guest', { p_group_id: groupId, p_guest_id: lia, p_user_id: late.id })).error).toBeNull();
    const b = await balances();
    expect(b[late.id]).toBe(1500); // Lia paid $30, her share $15
    expect(b[lia]).toBeUndefined();
    const { data: bread } = await ester.client.from('expenses').select('payer_id').eq('description', 'Bread').eq('group_id', groupId).single();
    expect(bread?.payer_id).toBe(late.id);
    // Late is told, and so is the owner.
    expect((await notes(late)).find((n) => n.kind === 'merged_with_guest')).toMatchObject({ actor_name: 'JCohost', claim_guest_name: 'Lia' });
    expect((await notes(ester)).find((n) => n.kind === 'guest_claimed' && n.claim_guest_name === 'Lia')).toBeDefined();
    // The co-owner who did it is told too, so they can undo it from there.
    expect((await notes(cohost)).find((n) => n.kind === 'guest_claimed' && n.claim_guest_name === 'Lia')).toMatchObject({ claim_via: 'merge' });
  });

  it('undoing a merge keeps the member in the group', async () => {
    const note = (await notes(late)).find((n) => n.kind === 'merged_with_guest')!;
    expect((await ester.client.rpc('undo_guest_claim', { p_claim_id: note.claim_id })).error).toBeNull();
    const b = await balances();
    expect(b[lia]).toBe(1500);
    expect(b[late.id]).toBe(0);
    const { data: row } = await ester.client.from('group_members').select('left_at').eq('group_id', groupId).eq('user_id', late.id).single();
    expect(row?.left_at).toBeNull();
  });

  it('a guest from another group can’t be merged in', async () => {
    const { data: other } = await ester.client.rpc('create_group', { p_name: 'Other', p_currency: 'AUD' });
    const leo = (await ester.client.rpc('add_guest', { p_group_id: other.id, p_name: 'Leo' })).data;
    expect((await ester.client.rpc('merge_guest', { p_group_id: groupId, p_guest_id: leo, p_user_id: late.id })).error?.message).toMatch(/isn’t a guest in this group/);
  });

  it('owners and co-owners see open invites; members don’t', async () => {
    const { data, error } = await cohost.client.rpc('open_invites', { p_group_id: groupId });
    expect(error).toBeNull();
    expect((data as { token: string }[]).map((i) => i.token)).toContain(link);
    expect((await late.client.rpc('open_invites', { p_group_id: groupId })).error).not.toBeNull();
  });

  it('turning off a link stops it working', async () => {
    const t = (await ester.client.rpc('create_invite', { p_group_id: groupId })).data;
    const { data } = await ester.client.rpc('open_invites', { p_group_id: groupId });
    const inv = (data as { id: string; token: string }[]).find((i) => i.token === t)!;
    // A member can't turn off someone else's invite.
    expect((await late.client.rpc('turn_off_invite', { p_invite_id: inv.id })).error).not.toBeNull();
    expect((await cohost.client.rpc('turn_off_invite', { p_invite_id: inv.id })).error).toBeNull();
    const someone = await signUp('JSomeone');
    expect((await someone.client.rpc('accept_invite', { p_token: t })).error?.message).toMatch(/invalid or has expired/);
    expect(((await ester.client.rpc('open_invites', { p_group_id: groupId })).data as { token: string }[]).map((i) => i.token)).not.toContain(t);
  });

  it('replacing a link turns the old one off and gives a new one of the same kind', async () => {
    const { data } = await ester.client.rpc('open_invites', { p_group_id: groupId });
    const old = (data as { id: string; token: string }[]).find((i) => i.token === link)!;
    const { data: fresh, error } = await ester.client.rpc('replace_invite', { p_invite_id: old.id });
    expect(error).toBeNull();
    expect(fresh).not.toBe(link);
    const someone = await signUp('JSomeone2');
    expect((await someone.client.rpc('accept_invite', { p_token: link })).error).not.toBeNull();
    expect((await someone.client.rpc('accept_invite', { p_token: fresh })).error).toBeNull();
  });
});
