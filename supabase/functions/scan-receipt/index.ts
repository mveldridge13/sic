// Reads a receipt photo and returns its shop, date, currency, total and line items.
//
// The app uploads the photo to the private "receipts" bucket first, then calls this with its path.
// The photo is downloaded as the signed-in user, so storage rules decide whether they may read it.
//
// Secrets: ANTHROPIC_API_KEY (required), RECEIPT_MODEL (optional, defaults to claude-opus-5-5).

import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

// Secret names are matched exactly, so accept them in either case.
const env = (name: string) => Deno.env.get(name) ?? Deno.env.get(name.toLowerCase());
const MODEL = env('RECEIPT_MODEL') ?? 'claude-opus-5-5';
const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });

const PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f-]{36}\.jpg$/;

const SYSTEM = `You read photos of receipts and bills for a bill-splitting app. Report what is printed; never guess.

- is_receipt: false if the photo isn't a receipt or bill, or is too blurry to read. Then leave every other field empty.
- merchant: the shop or venue name as a short title, e.g. "Mama's Kitchen". Empty if not shown.
- date: the purchase date as YYYY-MM-DD. Empty if not shown.
- currency: the ISO 4217 code (e.g. AUD, PHP, USD). Use the currency symbol, the shop's address or the language to decide. Empty if you can't tell.
- total: the final amount paid, including tax, service charge and tip, as printed (digits and one decimal point, no symbol or thousands separators, e.g. "1250.50"). Empty if not shown.
- items: each purchased line. name is a short, readable name (expand abbreviations where obvious, at most 60 characters). price is that line's total (quantity × unit price) in the same format as total. If a discount applies to one line, take it off that line's price. Leave out tax, service charge, tip, subtotals, payments, change and receipt-wide discounts: those are not items.`;

const SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean' },
    merchant: { type: 'string' },
    date: { type: 'string' },
    currency: { type: 'string' },
    total: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, price: { type: 'string' } },
        required: ['name', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['is_receipt', 'merchant', 'date', 'currency', 'total', 'items'],
  additionalProperties: false,
} as const;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const authorization = req.headers.get('Authorization');
  if (!authorization) return reply(401, { error: 'Sign in to scan receipts' });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  });

  let path: unknown;
  try {
    ({ path } = await req.json());
  } catch {
    return reply(400, { error: 'Send the receipt path' });
  }
  if (typeof path !== 'string' || !PATH_RE.test(path)) return reply(400, { error: 'That isn’t a receipt path' });

  // Counts toward today's allowance (and checks the caller is signed in).
  const claim = await supabase.rpc('claim_receipt_scan');
  if (claim.error) return reply(claim.error.code === 'PT429' ? 429 : 401, { error: claim.error.message });

  const file = await supabase.storage.from('receipts').download(path);
  if (file.error || !file.data) return reply(404, { error: 'Couldn’t find that photo. Please try again.' });
  const image = toBase64(new Uint8Array(await file.data.arrayBuffer()));

  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Read this receipt.' },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') return reply(422, { error: 'Couldn’t read this photo. Please type it in instead.' });
    if (response.stop_reason === 'max_tokens') return reply(422, { error: 'This receipt is too long to read. Please type it in instead.' });
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return reply(502, { error: 'Couldn’t read this photo. Please try again.' });
    return reply(200, JSON.parse(text.text));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return reply(503, { error: 'Scanning is busy right now. Please try again in a minute.' });
    if (e instanceof Anthropic.APIError) {
      console.error('Claude API error', e.status, e.message);
      return reply(502, { error: 'Couldn’t read this photo. Please try again.' });
    }
    console.error(e);
    return reply(500, { error: 'Couldn’t read this photo. Please try again.' });
  }
});
