-- Receipt scanning sends photos to Anthropic, so each person is asked first. null = not asked yet,
-- true = accepted, false = declined. The time is kept as a record of when they chose.
alter table public.profiles
  add column receipt_scan_consent boolean,
  add column receipt_scan_consent_at timestamptz;

-- Same allowance check as before, but no scan (and nothing sent to Anthropic) without consent.
create or replace function public.claim_receipt_scan() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  used int;
begin
  if not coalesce((select receipt_scan_consent from public.profiles where id = uid), false) then
    raise exception 'Receipt scanning is off. Update Tally and tap Scan receipt to turn it on.' using errcode = 'PT403';
  end if;
  select count(*) into used from public.receipt_scans
  where user_id = uid and created_at > now() - interval '24 hours';
  if used >= 20 then
    raise exception 'You’ve scanned 20 receipts today. You can scan more tomorrow, or type this one in.' using errcode = 'PT429';
  end if;
  insert into public.receipt_scans (user_id) values (uid);
end $$;
