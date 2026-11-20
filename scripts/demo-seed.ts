/**
 * Demo data for website screenshots. LOCAL DATABASE ONLY (refuses any other URL).
 * Makes four made-up people (Maya is "you"), three groups, expenses, a payment and recurring bills,
 * all through the app's own database functions.
 *   npx tsx scripts/demo-seed.ts
 * Sign in to the local web app as maya@demo.sic / demo-password-123.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { computeSplit, type SplitInput } from '../packages/shared/src/split';

const URL = 'http://127.0.0.1:54321';
const ANON = process.env.LOCAL_ANON_KEY!;
if (!ANON || !URL.startsWith('http://127.0.0.1')) throw new Error('Local database only');

const PASSWORD = 'demo-password-123';
const run = Date.now().toString(36);
const days = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

async function person(name: string) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const email = `${name.toLowerCase()}${name === 'Maya' ? '' : '-' + run}@demo.sic`;
  let r = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (r.error) {
    const s = await c.auth.signUp({ email, password: PASSWORD, options: { data: { name, currency: 'AUD' } } });
    if (s.error) throw s.error;
  }
  const { data } = await c.auth.getUser();
  await c.rpc('set_my_time_zone', { p_time_zone: 'Australia/Sydney' });
  return { c, id: data.user!.id, name };
}
type P = Awaited<ReturnType<typeof person>>;

async function ok<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data;
}

async function group(owner: P, name: string, icon: string, members: P[]) {
  const id = ((await ok(owner.c.rpc('create_group', { p_name: name, p_currency: 'AUD', p_icon: icon }))) as { id: string }).id;
  for (const m of members) {
    const token = (await ok(owner.c.rpc('create_invite', { p_group_id: id } as never))) as string;
    await ok(m.c.rpc('accept_invite', { p_token: token } as never));
  }
  return id;
}

async function expense(by: P, groupId: string, description: string, amount: number, payer: string, split: SplitInput, ago: number, category: string) {
  const shares = computeSplit(amount, split);
  await ok(
    by.c.rpc('create_expense', {
      p_group_id: groupId,
      p_description: description,
      p_amount_cents: amount,
      p_payer_id: payer,
      p_split_method: split.method,
      p_occurred_at: days(ago),
      p_splits: shares.map((s) => ({ user_id: s.userId, amount_cents: s.amount, weight: null })),
      p_items: split.method === 'items' ? split.items.map((i) => ({ name: i.name, amount_cents: i.amount, user_ids: i.userIds })) : null,
      p_category: category,
    } as never),
  );
}

async function main() {
  const maya = await person('Maya');
  const already = await ok(maya.c.rpc('my_group_summaries'));
  if (Array.isArray(already) && already.length) {
    console.log('Maya already has groups; nothing added.');
    return;
  }
  const alex = await person('Alex');
  const sam = await person('Sam');
  const jordan = await person('Jordan');

  await ok(alex.c.rpc('set_payid', { p_type: 'email', p_value: 'alex.nguyen@email.com', p_account_name: 'Alex Nguyen' }));

  // Byron trip: Maya's group.
  const byron = await group(maya, 'Byron trip', '🏖️', [sam, jordan]);
  const all3 = [maya.id, sam.id, jordan.id];
  await expense(maya, byron, 'Beach house', 66000, maya.id, { method: 'equal', participants: all3 }, 9, 'accommodation');
  await expense(sam, byron, 'Fuel', 8400, sam.id, { method: 'equal', participants: all3 }, 8, 'transport');
  await expense(jordan, byron, 'Groceries', 12640, jordan.id, { method: 'equal', participants: all3 }, 8, 'groceries');
  await expense(maya, byron, 'Surf lessons', 24000, maya.id, { method: 'equal', participants: [maya.id, sam.id] }, 7, 'entertainment');
  await expense(sam, byron, 'Fish and chips', 6150, sam.id, { method: 'equal', participants: all3 }, 7, 'food');

  // Housemates: Maya's group, with the recurring bills.
  const house = await group(maya, 'Housemates', '🏠', [alex, jordan]);
  const flat = [maya.id, alex.id, jordan.id];
  await expense(maya, house, 'Rent', 78000, maya.id, { method: 'equal', participants: flat }, 3, 'home');
  await expense(maya, house, 'Power bill', 16400, maya.id, { method: 'equal', participants: flat }, 5, 'bills');
  await expense(maya, house, 'Fresh Market', 5450, maya.id, {
    method: 'items',
    items: [
      { name: 'Sourdough', amount: 850, userIds: flat },
      { name: 'Free-range eggs', amount: 920, userIds: flat },
      { name: 'Coffee beans', amount: 2200, userIds: [maya.id, alex.id] },
      { name: 'Washing liquid', amount: 1480, userIds: flat },
    ],
  }, 2, 'groceries');
  await expense(jordan, house, 'Internet', 7900, jordan.id, { method: 'equal', participants: flat }, 12, 'bills');
  const everyone = { method: 'equal', participants: flat } as SplitInput;
  for (const [desc, amount, frequency, cat, inDays] of [
    ['Rent', 78000, 'weekly', 'home', 4],
    ['Power bill', 16400, 'monthly', 'bills', 11],
    ['Internet', 7900, 'monthly', 'bills', 15],
    ['Streaming', 2299, 'monthly', 'entertainment', 18],
  ] as const) {
    const id = await ok(
      maya.c.rpc('create_recurring', {
        p_group_id: house,
        p_description: desc,
        p_payer_id: desc === 'Internet' ? jordan.id : maya.id,
        p_split_method: 'equal',
        p_split_input: everyone,
        p_variable: false,
        p_amount_cents: amount,
        p_splits: computeSplit(amount, everyone).map((s) => ({ user_id: s.userId, amount_cents: s.amount, weight: null })),
        p_items: null,
        p_frequency: frequency,
        p_start_date: new Date(Date.now() + inDays * 86400000).toISOString().slice(0, 10),
        p_end_date: null,
        p_remaining: null,
        p_heads_up_days: 1,
        p_first_expense_id: null,
      } as never),
    );
    await ok(maya.c.rpc('set_recurring_category', { p_id: id, p_category: cat } as never));
  }

  // Ski weekend: Alex's group (Alex has a PayID), where Maya owes Alex.
  const ski = await group(alex, 'Ski weekend', '🎿', [maya, sam]);
  const skiers = [alex.id, maya.id, sam.id];
  await expense(alex, ski, 'Lodge', 54000, alex.id, { method: 'equal', participants: skiers }, 6, 'accommodation');
  await expense(maya, ski, 'Pizza night', 7350, maya.id, { method: 'equal', participants: skiers }, 5, 'food');

  // Friday dinner: split by item.
  const dinner = await group(maya, 'Friday dinner', '🍝', [sam, alex, jordan]);
  const table = [maya.id, sam.id, alex.id, jordan.id];
  await expense(maya, dinner, 'Trattoria Rosa', 21400, maya.id, {
    method: 'items',
    items: [
      { name: 'Lobster linguine', amount: 4800, userIds: [sam.id] },
      { name: 'Margherita', amount: 2600, userIds: [maya.id, jordan.id] },
      { name: 'Gnocchi', amount: 3200, userIds: [alex.id] },
      { name: 'Tiramisu', amount: 1600, userIds: [maya.id] },
      { name: 'Bottle of red', amount: 6800, userIds: table },
    ],
    rest: 'proportional',
  }, 1, 'food');

  // One payment in Byron: Jordan paid Maya back some.
  await ok(jordan.c.rpc('record_settlement', { p_group_id: byron, p_from_user_id: jordan.id, p_to_user_id: maya.id, p_amount_cents: 20000, p_occurred_at: days(4), p_note: null } as never));

  // Alex and Jordan paid Maya back for the rent, and she confirmed it.
  for (const who of [alex, jordan]) {
    const sid = (await ok(who.c.rpc('record_settlement', { p_group_id: house, p_from_user_id: who.id, p_to_user_id: maya.id, p_amount_cents: 26000, p_occurred_at: days(1), p_note: 'Rent' } as never))) as string;
    await ok(maya.c.rpc('respond_to_payment', { p_settlement_id: sid, p_received: true } as never));
  }

  console.log('Demo data added. Sign in as maya@demo.sic /', PASSWORD);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
