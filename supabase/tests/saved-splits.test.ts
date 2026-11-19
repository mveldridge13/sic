/**
 * Saved splits: named templates a group picks from on Add expense. Anyone in the group can see,
 * use and create them; whoever made one, the owner and co-owners can change or delete it; the
 * owner and co-owners pick the group default. Someone leaving never changes a saved split.
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

describe('Saved splits', () => {
  let alex: Who; // owner
  let sam: Who; // member
  let jordan: Who; // member, leaves later
  let outsider: Who;
  let groupId: string;
  let electricity: string;

  const pct = (a: number, b: number, c: number) => [
    { user_id: alex.id, weight: a },
    { user_id: sam.id, weight: b },
    { user_id: jordan.id, weight: c },
  ];
  const save = (who: Who, name: string, method: string, shares: unknown) =>
    who.client.rpc('save_split', { p_group_id: groupId, p_name: name, p_method: method, p_shares: shares });
  const row = async (id: string) => (await alex.client.from('saved_splits').select('*').eq('id', id).single()).data;

  beforeAll(async () => {
    [alex, sam, jordan, outsider] = await Promise.all([signUp('SplAlex'), signUp('SplSam'), signUp('SplJordan'), signUp('SplOut')]);
    const { data: g } = await alex.client.rpc('create_group', { p_name: 'Household', p_currency: 'AUD' });
    groupId = g.id;
    for (const who of [sam, jordan]) {
      const { data: t } = await alex.client.rpc('create_invite', { p_group_id: groupId });
      await who.client.rpc('accept_invite', { p_token: t });
    }
  });

  it('any member can save one, and everyone in the group sees it', async () => {
    const { data, error } = await sam.client.rpc('save_split', { p_group_id: groupId, p_name: ' Electricity ', p_method: 'percentage', p_shares: pct(5000, 2500, 2500) });
    expect(error).toBeNull();
    electricity = data as string;
    const r = await row(electricity);
    expect(r).toMatchObject({ name: 'Electricity', method: 'percentage', created_by: sam.id, updated_by: sam.id });
    const { data: asJordan } = await jordan.client.from('saved_splits').select('id').eq('group_id', groupId);
    expect(asJordan).toHaveLength(1);
    const { data: asOutsider } = await outsider.client.from('saved_splits').select('id').eq('group_id', groupId);
    expect(asOutsider).toHaveLength(0);
  });

  it('checks the numbers', async () => {
    expect((await save(alex, 'Bad', 'percentage', pct(5000, 2500, 2000))).error?.message).toMatch(/100%/);
    // A third each can't be typed exactly; 99.99% counts.
    expect((await save(alex, 'Internet', 'percentage', pct(3333, 3333, 3333))).error).toBeNull();
    expect((await save(alex, 'Zero', 'shares', pct(0, 0, 0))).error?.message).toMatch(/share/);
    expect((await save(alex, 'Kids', 'shares', pct(2, 1, 1))).error).toBeNull();
    expect((await save(alex, 'Groceries', 'equal', [{ user_id: alex.id }, { user_id: sam.id }])).error).toBeNull();
    expect((await save(alex, 'Exact', 'exact', pct(1, 1, 1))).error?.message).toMatch(/Equally, Percent and Shares/);
    expect((await save(alex, 'Nobody', 'equal', [])).error?.message).toMatch(/at least one/);
    expect((await save(alex, 'Twice', 'equal', [{ user_id: alex.id }, { user_id: alex.id }])).error?.message).toMatch(/twice/);
    expect((await save(alex, 'Stranger', 'equal', [{ user_id: outsider.id }])).error?.message).toMatch(/in the group/);
    expect((await save(alex, 'electricity', 'equal', [{ user_id: alex.id }])).error?.message).toMatch(/already/);
  });

  it('only whoever made it, the owner or a co-owner can change or delete it', async () => {
    const edit = (who: Who) =>
      who.client.rpc('update_split', { p_id: electricity, p_name: 'Electricity', p_method: 'percentage', p_shares: pct(4000, 3000, 3000) });
    expect((await edit(jordan)).error?.message).toMatch(/not found/);
    expect((await edit(sam)).error).toBeNull();
    expect((await edit(alex)).error).toBeNull();
    expect(await row(electricity)).toMatchObject({ updated_by: alex.id, shares: pct(4000, 3000, 3000) });
    expect((await jordan.client.rpc('delete_split', { p_id: electricity })).error?.message).toMatch(/not found/);
  });

  it('only the owner or a co-owner sets the default', async () => {
    expect((await sam.client.rpc('set_default_split', { p_group_id: groupId, p_split_id: electricity })).error?.message).toMatch(/owner or a co-owner/);
    expect((await alex.client.rpc('set_default_split', { p_group_id: groupId, p_split_id: electricity })).error).toBeNull();
    const { data: g } = await sam.client.from('groups').select('default_split_id').eq('id', groupId).single();
    expect(g?.default_split_id).toBe(electricity);
  });

  it('someone leaving doesn’t change it; it can be fixed afterwards', async () => {
    expect((await jordan.client.rpc('leave_group', { p_group_id: groupId })).error).toBeNull();
    expect((await row(electricity))?.shares).toEqual(pct(4000, 3000, 3000));
    // Still holding Jordan, it can't be saved again until Jordan is taken out.
    const again = await alex.client.rpc('update_split', { p_id: electricity, p_name: 'Electricity', p_method: 'percentage', p_shares: pct(4000, 3000, 3000) });
    expect(again.error?.message).toMatch(/in the group/);
    const fixed = await alex.client.rpc('update_split', {
      p_id: electricity, p_name: 'Electricity', p_method: 'percentage',
      p_shares: [{ user_id: alex.id, weight: 5000 }, { user_id: sam.id, weight: 5000 }],
    });
    expect(fixed.error).toBeNull();
  });

  it('deleting the default clears it', async () => {
    expect((await sam.client.rpc('delete_split', { p_id: electricity })).error).toBeNull();
    const { data: g } = await alex.client.from('groups').select('default_split_id').eq('id', groupId).single();
    expect(g?.default_split_id).toBeNull();
  });
});
