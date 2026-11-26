// Deletes receipt photos that are no longer needed.
//
// The database queues a photo's path in receipt_trash when its expense is deleted, when it's
// removed or replaced, when the person who took it deletes their account, or when it was uploaded
// and never used (see migration 20261207000000_receipt_trash.sql). Files can only be removed
// through the Storage API, so this does that, with the service role.
//
// Anyone may call it (the app does, after a delete and once when it starts): it only ever
// deletes what the database has already queued, so calling it is harmless. A path that fails is
// tried again on a later call, up to 10 times.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  let removed = 0;
  let failed = 0;
  // A few rounds at most, so one call can't run for long.
  for (let round = 0; round < 5; round++) {
    const { data: paths, error } = await admin.rpc('receipts_to_remove', { p_limit: 100 });
    if (error) {
      console.error('receipts_to_remove', error.message);
      return reply(500, { error: 'Couldn’t read the queue' });
    }
    const list = (paths ?? []) as string[];
    if (list.length === 0) break;

    // Storage removes what exists and skips what doesn't; either way the file is gone.
    const result = await admin.storage.from('receipts').remove(list);
    if (result.error) {
      failed += list.length;
      console.error('storage remove', result.error.message);
      await admin.rpc('receipts_not_removed', { p_paths: list, p_error: result.error.message });
      break;
    }
    const done = await admin.rpc('receipts_removed', { p_paths: list });
    if (done.error) {
      console.error('receipts_removed', done.error.message);
      return reply(500, { error: 'Couldn’t update the queue' });
    }
    removed += list.length;
    if (list.length < 100) break;
  }
  return reply(200, { removed, failed });
});
