/**
 * Receipt photos and the scan allowance, against the LOCAL Supabase stack. Run: npm run test:db
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

const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // smallest possible JPEG markers
const uuid = () => crypto.randomUUID();

describe('Receipts', () => {
  let alice: Awaited<ReturnType<typeof signUp>>; // owner
  let bob: Awaited<ReturnType<typeof signUp>>; // member
  let cara: Awaited<ReturnType<typeof signUp>>; // member
  let outsider: Awaited<ReturnType<typeof signUp>>;
  let groupId: string;
  let otherGroupId: string;

  const upload = (who: typeof alice, path: string) =>
    who.client.storage.from('receipts').upload(path, photo, { contentType: 'image/jpeg' });
  const canRead = async (who: typeof alice, path: string) => !(await who.client.storage.from('receipts').download(path)).error;
  const addExpense = async (who: typeof alice) => {
    const { data, error } = await who.client.rpc('create_expense', {
      p_group_id: groupId,
      p_description: 'Dinner',
      p_amount_cents: 3000,
      p_payer_id: who.id,
      p_split_method: 'equal',
      p_splits: [alice, bob, cara].map((p) => ({ user_id: p.id, amount_cents: 1000 })),
    });
    if (error) throw error;
    return data as string;
  };

  beforeAll(async () => {
    [alice, bob, cara, outsider] = await Promise.all([signUp('RcptAlice'), signUp('RcptBob'), signUp('RcptCara'), signUp('RcptOut')]);
    const { data: g } = await alice.client.rpc('create_group', { p_name: 'Dinners', p_currency: 'AUD' });
    groupId = g.id;
    for (const who of [bob, cara]) {
      const { data: t } = await alice.client.rpc('create_invite', { p_group_id: groupId });
      await who.client.rpc('accept_invite', { p_token: t });
    }
    const { data: other } = await alice.client.rpc('create_group', { p_name: 'Other', p_currency: 'AUD' });
    otherGroupId = other.id;
  });

  it('lets members upload to their group, but not outsiders or outside a group folder', async () => {
    expect((await upload(bob, `${groupId}/${uuid()}.jpg`)).error).toBeNull();
    expect((await upload(outsider, `${groupId}/${uuid()}.jpg`)).error).not.toBeNull();
    expect((await upload(bob, `not-a-group/${uuid()}.jpg`)).error).not.toBeNull();
  });

  it('shows a photo to whoever can see its expense, and keeps it from other members', async () => {
    const path = `${groupId}/${uuid()}.jpg`;
    await upload(bob, path);
    // Before it's on an expense, only the uploader sees it.
    expect(await canRead(bob, path)).toBe(true);
    expect(await canRead(alice, path)).toBe(false);

    const expenseId = await addExpense(bob);
    expect((await bob.client.rpc('set_expense_receipt', { p_expense_id: expenseId, p_path: path })).error).toBeNull();
    expect((await bob.client.from('expenses').select('receipt_path').eq('id', expenseId).single()).data?.receipt_path).toBe(path);

    // Member privacy: the owner sees Bob's expense, Cara doesn't.
    expect(await canRead(alice, path)).toBe(true);
    expect(await canRead(cara, path)).toBe(false);
    expect(await canRead(outsider, path)).toBe(false);
  });

  it('only attaches your own photo from the same group', async () => {
    const expenseId = await addExpense(bob);
    const alicesPhoto = `${groupId}/${uuid()}.jpg`;
    await upload(alice, alicesPhoto);
    expect((await bob.client.rpc('set_expense_receipt', { p_expense_id: expenseId, p_path: alicesPhoto })).error).not.toBeNull();

    const elsewhere = `${otherGroupId}/${uuid()}.jpg`;
    await upload(alice, elsewhere);
    const alicesExpense = await addExpense(alice);
    expect((await alice.client.rpc('set_expense_receipt', { p_expense_id: alicesExpense, p_path: elsewhere })).error?.message).toMatch(/different group/);

    // Cara can't touch an expense she can't see.
    const carasPhoto = `${groupId}/${uuid()}.jpg`;
    await upload(cara, carasPhoto);
    expect((await cara.client.rpc('set_expense_receipt', { p_expense_id: expenseId, p_path: carasPhoto })).error).not.toBeNull();
  });

  it('lets you delete only your own photos', async () => {
    const path = `${groupId}/${uuid()}.jpg`;
    await upload(bob, path);
    await alice.client.storage.from('receipts').remove([path]);
    expect(await canRead(bob, path)).toBe(true);
    await bob.client.storage.from('receipts').remove([path]);
    expect(await canRead(bob, path)).toBe(false);
  });

  it('allows 20 scans a day per person', async () => {
    for (let i = 0; i < 20; i++) expect((await outsider.client.rpc('claim_receipt_scan')).error).toBeNull();
    const over = await outsider.client.rpc('claim_receipt_scan');
    expect(over.error?.code).toBe('PT429');
    // Someone else still has their own allowance.
    expect((await cara.client.rpc('claim_receipt_scan')).error).toBeNull();
  });
});
