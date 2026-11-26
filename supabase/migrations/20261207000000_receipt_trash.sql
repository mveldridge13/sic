-- Receipt photos are deleted by the server, not the phone.
--
-- Files can only be removed through the Storage API, so the database can't delete them itself.
-- Instead, whenever a photo stops being needed its path goes into receipt_trash, in the same
-- transaction as the change that made it unneeded:
--   * an expense with a photo is deleted (expenses are now deleted for good, see below)
--   * a photo is removed from an expense, or replaced by another
--   * someone deletes their account (see the next migration)
--   * a photo was uploaded but never put on an expense for a day (left behind by older app
--     versions, or a phone that lost signal mid-save); an hourly job finds these
-- The empty-receipt-trash edge function deletes the files and clears the rows. The app calls it
-- straight after a delete and once each time it starts, so a failed delete is tried again later.
-- Each path is tried up to 10 times; the error is kept so a stuck file can be looked at.

create table public.receipt_trash (
  path       text primary key,
  queued_at  timestamptz not null default now(),
  attempts   integer not null default 0,
  tried_at   timestamptz,
  last_error text
);
-- Server only: no policies, so the app can't read or change it.
alter table public.receipt_trash enable row level security;
revoke all on public.receipt_trash from public, anon, authenticated;

create function public.trash_receipt_on_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.receipt_path is not null and (tg_op = 'DELETE' or new.receipt_path is distinct from old.receipt_path) then
    insert into public.receipt_trash (path) values (old.receipt_path) on conflict (path) do nothing;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger trash_receipt_on_change
  after update of receipt_path or delete on public.expenses
  for each row execute function public.trash_receipt_on_change();

-- A path that's put back on an expense (say, set again by an older app) is no longer rubbish.
create function public.untrash_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.receipt_path is not null then
    delete from public.receipt_trash where path = new.receipt_path;
  end if;
  return new;
end $$;

create trigger untrash_receipt
  after insert or update of receipt_path on public.expenses
  for each row execute function public.untrash_receipt();

-- Deleting an expense now deletes it for good: its splits and edit history go with it
-- (cascade), payments that pointed at it keep going but no longer point at it (set null), and
-- its photo is queued above. Who can delete is unchanged.
create or replace function public.delete_expense(p_expense_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid;
  v_creator uuid;
begin
  perform public.require_user();
  select group_id, created_by into v_group, v_creator from public.expenses where id = p_expense_id and deleted_at is null for update;
  if v_group is null or not public.can_see_expense(v_group, v_creator) then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;

  delete from public.expenses where id = p_expense_id;
end $$;

-- Changes the server makes on someone's behalf (tidying up after a deleted account, or this
-- migration) can touch closed groups. They set sic.system_change for their own transaction only;
-- the app can't set it, since it can only call the functions in the public schema.
create or replace function public.guard_closed_group() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid := case when tg_op = 'DELETE' then old.group_id else new.group_id end;
begin
  if coalesce(current_setting('sic.system_change', true), '') <> 'on' and public.is_group_closed(v_group) then
    raise exception 'This group is closed. Reopen it to make changes.' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Expenses deleted before this change were only hidden. Delete them for good too.
select set_config('sic.system_change', 'on', true);
delete from public.expenses where deleted_at is not null;
select set_config('sic.system_change', '', true);

-- Photos uploaded but never put on an expense, after a day: queue them.
create function public.queue_orphan_receipts() returns integer
language sql security definer set search_path = '' as $$
  with queued as (
    insert into public.receipt_trash (path)
    select o.name from storage.objects o
    where o.bucket_id = 'receipts'
      and o.created_at < now() - interval '1 day'
      and not exists (select 1 from public.expenses e where e.receipt_path = o.name)
    on conflict (path) do nothing
    returning 1
  )
  select count(*)::integer from queued;
$$;

revoke execute on function public.queue_orphan_receipts() from public, anon, authenticated;

select cron.schedule('sic-orphan-receipts', '35 * * * *', 'select public.queue_orphan_receipts()');

-- For the edge function (service role only): what to delete, and how it went.
create function public.receipts_to_remove(p_limit integer default 100) returns setof text
language sql security definer set search_path = '' as $$
  select path from public.receipt_trash
  where attempts < 10
  order by attempts, queued_at
  limit least(greatest(p_limit, 1), 1000);
$$;

create function public.receipts_removed(p_paths text[]) returns void
language sql security definer set search_path = '' as $$
  delete from public.receipt_trash where path = any (p_paths);
$$;

create function public.receipts_not_removed(p_paths text[], p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.receipt_trash
  set attempts = attempts + 1, tried_at = now(), last_error = left(p_error, 500)
  where path = any (p_paths);
$$;

revoke execute on function public.receipts_to_remove(integer) from public, anon, authenticated;
revoke execute on function public.receipts_removed(text[]) from public, anon, authenticated;
revoke execute on function public.receipts_not_removed(text[], text) from public, anon, authenticated;
grant execute on function public.receipts_to_remove(integer) to service_role;
grant execute on function public.receipts_removed(text[]) to service_role;
grant execute on function public.receipts_not_removed(text[], text) to service_role;
grant select, insert, update, delete on public.receipt_trash to service_role;
