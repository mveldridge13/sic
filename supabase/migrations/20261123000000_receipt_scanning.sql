-- Receipt scanning: a photo of the bill is stored with the expense, and the scan-receipt edge
-- function reads it to fill in the items.
--
-- Photos live in a private "receipts" bucket at <group id>/<random id>.jpg. Who can see one
-- follows member privacy: the person who took it, and anyone who can see the expense it's on.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

-- The group a receipt path belongs to, or null if the path isn't <uuid>/<file>.
create function public.receipt_group(p_name text) returns uuid
language plpgsql immutable set search_path = '' as $$
declare
  folder text := split_part(p_name, '/', 1);
begin
  if folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return folder::uuid;
end $$;

create index expenses_receipt_path_idx on public.expenses (receipt_path) where receipt_path is not null;

create policy "members upload receipts to their groups" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_group_member(public.receipt_group(name)));

create policy "read own receipts and receipts on visible expenses" on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (
      owner_id = (select auth.uid())::text
      or exists (
        select 1 from public.expenses e
        where e.receipt_path = name and e.deleted_at is null and public.can_see_expense(e.group_id, e.created_by)
      )
    )
  );

create policy "delete own receipts" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and owner_id = (select auth.uid())::text);

-- Attach a receipt photo to an expense (or remove it with null). The photo must be one you
-- uploaded, in the expense's group.
create function public.set_expense_receipt(p_expense_id uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_group uuid;
  v_creator uuid;
begin
  select group_id, created_by into v_group, v_creator from public.expenses where id = p_expense_id and deleted_at is null;
  if v_group is null or not public.can_see_expense(v_group, v_creator) then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if p_path is not null then
    if public.receipt_group(p_path) is distinct from v_group then
      raise exception 'That receipt belongs to a different group' using errcode = '22023';
    end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'receipts' and o.name = p_path and o.owner_id = uid::text
    ) then
      raise exception 'Receipt not found' using errcode = 'P0002';
    end if;
  end if;
  update public.expenses set receipt_path = p_path where id = p_expense_id;
end $$;

-- One row per scan, so each person gets a fair daily allowance (each scan costs money).
create table public.receipt_scans (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index receipt_scans_user_time_idx on public.receipt_scans (user_id, created_at);
alter table public.receipt_scans enable row level security;
-- No policies: only claim_receipt_scan touches this table.

-- Called by the scan-receipt edge function before it reads a photo. Raises once you've used
-- today's allowance.
create function public.claim_receipt_scan() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  used int;
begin
  select count(*) into used from public.receipt_scans
  where user_id = uid and created_at > now() - interval '24 hours';
  if used >= 20 then
    raise exception 'You’ve scanned 20 receipts today. You can scan more tomorrow, or type this one in.' using errcode = 'PT429';
  end if;
  insert into public.receipt_scans (user_id) values (uid);
end $$;

revoke execute on function
  public.receipt_group(text),
  public.set_expense_receipt(uuid, text),
  public.claim_receipt_scan()
from public, anon;
grant execute on function
  public.receipt_group(text),
  public.set_expense_receipt(uuid, text),
  public.claim_receipt_scan()
to authenticated;
