/**
 * Guest links: a guest's own private link shows their part of the group in a browser, without an
 * account. View only; it stops working when turned off, or when the guest joins sic.
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

// Nobody signed in: what the web page uses.
const browser = createClient(URL, ANON, { auth: { persistSession: false } });
const view = (token: string) => browser.rpc('guest_view', { p_token: token });

describe('Guest links', () => {
  let olive: Who; // owner
  let max: Who; // member
  let groupId: string;
  let jamie: string; // guest
  let pat: string; // another guest
  let token: string;

  beforeAll(async () => {
    [olive, max] = await Promise.all([signUp('LinkOlive'), signUp('LinkMax')]);
    const { data: g } = await olive.client.rpc('create_group', { p_name: 'Beach house', p_currency: 'AUD' });
    groupId = g.id;
    const { data: t } = await olive.client.rpc('create_invite', { p_group_id: groupId });
    await max.client.rpc('accept_invite', { p_token: t });
    jamie = (await olive.client.rpc('add_guest', { p_group_id: groupId, p_name: 'Jamie' })).data;
    pat = (await olive.client.rpc('add_guest', { p_group_id: groupId, p_name: 'Pat' })).data;
    await olive.client.from('profiles').update({ currency: 'AUD' }).eq('id', olive.id);
    expect((await olive.client.rpc('set_payid', { p_type: 'phone', p_value: '+61412345678', p_account_name: 'Olive Owner' })).error).toBeNull();

    const expense = (who: Who, description: string, cents: number, people: string[]) =>
      who.client.rpc('create_expense', {
        p_group_id: groupId,
        p_description: description,
        p_amount_cents: cents,
        p_payer_id: who.id,
        p_split_method: 'equal',
        p_splits: people.map((id) => ({ user_id: id, amount_cents: cents / people.length })),
      });
    expect((await expense(olive, 'Groceries', 9000, [olive.id, max.id, jamie])).error).toBeNull();
    // Jamie isn't in this one, so it must not show on Jamie's link.
    expect((await expense(max, 'Max and Pat dinner', 4000, [max.id, pat])).error).toBeNull();
    expect(
      (await olive.client.rpc('record_settlement', { p_group_id: groupId, p_from_user_id: jamie, p_to_user_id: olive.id, p_amount_cents: 1000 }))
        .error,
    ).toBeNull();
  });

  it('anyone in the group can share a guest’s link, and it’s the same link each time', async () => {
    const a = await max.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: jamie });
    expect(a.error).toBeNull();
    token = a.data;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const b = await olive.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: jamie });
    expect(b.data).toBe(token);
  });

  it('only for guests in this group who haven’t joined', async () => {
    expect((await olive.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: max.id })).error?.message).toMatch(/not a guest|guest is not/i);
    const outsider = await signUp('LinkOutsider');
    expect((await outsider.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: jamie })).error).not.toBeNull();
    expect((await browser.rpc('guest_link', { p_group_id: groupId, p_guest_id: jamie })).error).not.toBeNull();
  });

  it('opens without an account and shows only what concerns the guest', async () => {
    const { data, error } = await view(token);
    expect(error).toBeNull();
    expect(data.guest).toBe('Jamie');
    expect(data.group).toMatchObject({ name: 'Beach house', currency: 'AUD', closed: false });
    // Jamie's share of Groceries is $30, $10 already paid back.
    expect(data.balance).toBe(-2000);
    expect(data.expenses.map((e: { description: string }) => e.description)).toEqual(['Groceries']);
    expect(data.expenses[0]).toMatchObject({ amount: 9000, share: 3000, payer: 'LinkOlive', paid_by_guest: false });
    expect(data.payments).toHaveLength(1);
    expect(data.payments[0]).toMatchObject({ amount: 1000, guest_paid: true, pending: false });
    expect(data.transfers).toEqual([{ from: 'Jamie', to: 'LinkOlive', amount: 2000, guest_pays: true, to_owner: true }]);
  });

  it('shows the owner’s PayID when the guest owes the owner', async () => {
    const { data } = await view(token);
    expect(data.payid).toEqual({ type: 'phone', value: '+61412345678', account_name: 'Olive Owner' });
  });

  it('no PayID when the guest owes someone else', async () => {
    // Its own group, so the simplified "who pays whom" can't route Kim to the owner.
    const { data: g } = await olive.client.rpc('create_group', { p_name: 'Ski trip', p_currency: 'AUD' });
    const { data: inv } = await olive.client.rpc('create_invite', { p_group_id: g.id });
    await max.client.rpc('accept_invite', { p_token: inv });
    const kim = (await max.client.rpc('add_guest', { p_group_id: g.id, p_name: 'Kim' })).data;
    await max.client.rpc('create_expense', {
      p_group_id: g.id,
      p_description: 'Lift passes',
      p_amount_cents: 4000,
      p_payer_id: max.id,
      p_split_method: 'equal',
      p_splits: [max.id, kim].map((id) => ({ user_id: id, amount_cents: 2000 })),
    });
    const t = (await max.client.rpc('guest_link', { p_group_id: g.id, p_guest_id: kim })).data;
    const { data } = await view(t);
    expect(data.transfers).toEqual([{ from: 'Kim', to: 'LinkMax', amount: 2000, guest_pays: true, to_owner: false }]);
    expect(data.payid).toBeNull();
  });

  it('a made-up link shows nothing', async () => {
    expect((await view('0'.repeat(48))).error?.message).toMatch(/isn’t working/);
  });

  it('the link table can’t be read from outside the group', async () => {
    expect((await browser.from('guest_links').select('token')).data ?? []).toEqual([]);
    const outsider = await signUp('LinkPeek');
    expect((await outsider.client.from('guest_links').select('token')).data).toEqual([]);
    await olive.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: pat });
    expect((await max.client.from('guest_links').select('guest_id').eq('group_id', groupId)).data?.length).toBe(2);
  });

  it('a member who didn’t share it can’t turn it off; the owner can, and a new share makes a new link', async () => {
    const t = (await olive.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: pat })).data;
    expect((await max.client.rpc('turn_off_guest_link', { p_group_id: groupId, p_guest_id: pat })).error?.message).toMatch(/Only the owner/);
    expect((await view(t)).error).toBeNull();

    expect((await olive.client.rpc('turn_off_guest_link', { p_group_id: groupId, p_guest_id: jamie })).error).toBeNull();
    expect((await view(token)).error?.message).toMatch(/isn’t working/);
    const fresh = (await olive.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: jamie })).data;
    expect(fresh).not.toBe(token);
    expect((await view(fresh)).error).toBeNull();
    expect((await view(token)).error).not.toBeNull();
    token = fresh;
  });

  it('whoever shared it can turn it off', async () => {
    const t = (await max.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: pat })).data;
    // Pat's link was made by Olive above, so Max still can't.
    expect((await max.client.rpc('turn_off_guest_link', { p_group_id: groupId, p_guest_id: pat })).error).not.toBeNull();
    await olive.client.rpc('turn_off_guest_link', { p_group_id: groupId, p_guest_id: pat });
    const mine = (await max.client.rpc('guest_link', { p_group_id: groupId, p_guest_id: pat })).data;
    expect(mine).not.toBe(t);
    expect((await max.client.rpc('turn_off_guest_link', { p_group_id: groupId, p_guest_id: pat })).error).toBeNull();
    expect((await view(mine)).error).not.toBeNull();
  });

  it('stops working once the guest joins sic', async () => {
    const real = await signUp('LinkJamie');
    const invite = (await olive.client.rpc('create_invite', { p_group_id: groupId, p_guest_id: jamie })).data;
    expect((await real.client.rpc('accept_invite', { p_token: invite })).error).toBeNull();
    expect((await view(token)).error?.message).toMatch(/isn’t working/);
  });
});
