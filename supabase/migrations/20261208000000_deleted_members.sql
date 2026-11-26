-- Deleting your account, take two (tester feedback, 25 Nov 2026).
--
-- You no longer have to settle up first. Instead, in every group you were ever in, your place is
-- taken by a stand-in called "Deleted member 1", "Deleted member 2" and so on (numbered within
-- each group, in the order people deleted their accounts). The stand-in is a guest with
-- deleted_at set: it can't be invited, claimed, given a view link or picked for new expenses.
-- Everything you were part of moves to it, so balances stay exactly as they were:
--   expenses you paid, added or were split into, their edit history, payments to and from you
--   (pending ones stay pending), repeating expenses, saved splits, invites, guests you added.
-- If you still owe or are owed money, the stand-in stays in the group so the balance shows and
-- the owner can record payments; otherwise it's listed as having left.
-- Then your own profile is deleted completely, so your name is gone from every group.
--
-- Payments waiting for you to confirm are now confirmed or declined by the group's owner or a
-- co-owner. Every answer to a payment now records who gave it (responded_by).
--
-- Also: repeating expenses you're split into are paused, every invite you made stops working,
-- and the receipt photos you uploaded are deleted (the expense details read from them stay).

alter table public.settlements add column responded_by uuid references public.profiles (id) on delete set null;

-- A stand-in for a deleted account.
create function public.is_deleted_member(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_user_id and is_guest and deleted_at is not null);
$$;

-- Move one account's place in every group to a numbered stand-in. Internal: called by
-- delete_my_account and once below for accounts deleted before this change.
create function public.retire_account(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_sub uuid;
  v_n integer;
  v_keep boolean;
  v_old text := p_user_id::text;
  v_new text;
begin
  perform set_config('sic.system_change', 'on', true);

  for r in select m.group_id, m.left_at from public.group_members m where m.user_id = p_user_id order by m.joined_at loop
    select count(*) + 1 into v_n
    from public.profiles p where p.guest_group_id = r.group_id and p.is_guest and p.deleted_at is not null;
    v_sub := gen_random_uuid();
    v_new := v_sub::text;
    insert into public.profiles (id, name, currency, is_guest, guest_group_id, deleted_at)
    select v_sub, 'Deleted member ' || v_n, g.currency, true, r.group_id, now() from public.groups g where g.id = r.group_id;

    -- Expenses, their splits and their edit history (item names follow via a trigger).
    update public.expenses set payer_id = v_sub where group_id = r.group_id and payer_id = p_user_id;
    update public.expenses set created_by = v_sub where group_id = r.group_id and created_by = p_user_id;
    update public.expense_splits s set user_id = v_sub
      from public.expenses e where e.id = s.expense_id and e.group_id = r.group_id and s.user_id = p_user_id;
    update public.expense_revisions v set edited_by = v_sub
      from public.expenses e where e.id = v.expense_id and e.group_id = r.group_id and v.edited_by = p_user_id;
    update public.expense_revisions v set before = replace(v.before::text, v_old, v_new)::jsonb
      from public.expenses e where e.id = v.expense_id and e.group_id = r.group_id and v.before::text like '%' || v_old || '%';

    -- Payments.
    update public.settlements set from_user_id = v_sub where group_id = r.group_id and from_user_id = p_user_id;
    update public.settlements set to_user_id = v_sub where group_id = r.group_id and to_user_id = p_user_id;
    update public.settlements set created_by = v_sub where group_id = r.group_id and created_by = p_user_id;
    update public.settlements set responded_by = v_sub where group_id = r.group_id and responded_by = p_user_id;

    -- Repeating expenses and saved splits.
    update public.recurring_expenses set payer_id = v_sub where group_id = r.group_id and payer_id = p_user_id;
    update public.recurring_expenses set created_by = v_sub where group_id = r.group_id and created_by = p_user_id;
    update public.recurring_expenses set splits = replace(splits::text, v_old, v_new)::jsonb
      where group_id = r.group_id and splits::text like '%' || v_old || '%';
    update public.recurring_expenses set items = replace(items::text, v_old, v_new)::jsonb
      where group_id = r.group_id and items::text like '%' || v_old || '%';
    update public.recurring_expenses set split_input = replace(split_input::text, v_old, v_new)::jsonb
      where group_id = r.group_id and split_input::text like '%' || v_old || '%';
    update public.saved_splits set shares = replace(shares::text, v_old, v_new)::jsonb
      where group_id = r.group_id and shares::text like '%' || v_old || '%';
    update public.saved_splits set created_by = v_sub where group_id = r.group_id and created_by = p_user_id;
    update public.saved_splits set updated_by = v_sub where group_id = r.group_id and updated_by = p_user_id;

    -- Who made, joined or closed things.
    update public.group_invites set invited_by = v_sub where group_id = r.group_id and invited_by = p_user_id;
    update public.group_invites set accepted_by = v_sub where group_id = r.group_id and accepted_by = p_user_id;
    update public.profiles set created_by = v_sub where guest_group_id = r.group_id and created_by = p_user_id;
    update public.profiles set claimed_by = v_sub where guest_group_id = r.group_id and claimed_by = p_user_id;
    update public.groups set created_by = v_sub where id = r.group_id and created_by = p_user_id;
    update public.groups set closed_by = v_sub where id = r.group_id and closed_by = p_user_id;
    update public.guest_links set created_by = v_sub where group_id = r.group_id and created_by = p_user_id;
    update public.guest_links set revoked_by = v_sub where group_id = r.group_id and revoked_by = p_user_id;
    update public.notifications set actor_id = v_sub where group_id = r.group_id and actor_id = p_user_id;

    -- Membership: stays while money is still owed either way, or a payment is waiting.
    v_keep := r.left_at is null and (
      public.member_net_balance(r.group_id, v_sub) <> 0
      or exists (
        select 1 from public.settlements s
        where s.group_id = r.group_id and s.status::text = 'pending' and v_sub in (s.from_user_id, s.to_user_id)
      )
    );
    update public.group_members
    set user_id = v_sub, role = 'member',
        left_at = case when v_keep then null else coalesce(r.left_at, now()) end
    where group_id = r.group_id and user_id = p_user_id;

    -- Payments to the deleted member that are still waiting: the owner and co-owners answer them.
    insert into public.notifications (user_id, kind, group_id, actor_id, amount_cents, settlement_id)
    select m.user_id, 'payment_to_confirm', s.group_id, s.from_user_id, s.amount_cents, s.id
    from public.settlements s
    join public.group_members m on m.group_id = s.group_id and m.left_at is null and m.role in ('owner', 'admin')
    join public.groups g on g.id = s.group_id and g.archived_at is null
    where s.group_id = r.group_id and s.to_user_id = v_sub and s.status::text = 'pending'
      and m.user_id <> s.from_user_id;
  end loop;
end $$;

revoke execute on function public.retire_account(uuid) from public, anon, authenticated;

-- A deleted account's profile is no longer kept.
create or replace function public.delete_profile_with_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.profiles where id = old.id and not is_guest;
  return old;
end $$;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_group uuid;
  v_new_owner uuid;
  v_uid text := uid::text;
begin
  -- Hand over (or delete) groups you own.
  for v_group in
    select m.group_id from public.group_members m
    join public.groups g on g.id = m.group_id and g.archived_at is null
    where m.user_id = uid and m.left_at is null and m.role = 'owner'
  loop
    select m.user_id into v_new_owner
    from public.group_members m
    join public.profiles p on p.id = m.user_id and not p.is_guest and p.deleted_at is null
    where m.group_id = v_group and m.user_id <> uid and m.left_at is null
    order by (m.role = 'admin') desc, m.joined_at, m.user_id
    limit 1;

    if v_new_owner is null then
      update public.groups set archived_at = now() where id = v_group;
    else
      update public.group_members set role = 'member' where group_id = v_group and user_id = uid;
      update public.group_members set role = 'owner' where group_id = v_group and user_id = v_new_owner;
      insert into public.notifications (user_id, kind, group_id, actor_id)
      values (v_new_owner, 'owner_handed_over', v_group, uid);
    end if;
  end loop;

  -- Loose ends: your invites stop working, repeating expenses you pay stop, and ones you're split
  -- into are paused until someone changes who's in them.
  update public.group_invites set expires_at = now()
  where invited_by = uid and expires_at > now();
  update public.recurring_expenses set stopped_at = now(), updated_at = now()
  where payer_id = uid and stopped_at is null;
  update public.recurring_expenses set paused = true, updated_at = now()
  where stopped_at is null and not paused
    and (splits::text like '%' || v_uid || '%' or items::text like '%' || v_uid || '%'
         or split_input::text like '%' || v_uid || '%');

  -- Receipt photos you uploaded are deleted; what was read from them stays on the expenses.
  perform set_config('sic.system_change', 'on', true);
  update public.expenses e set receipt_path = null
  from storage.objects o
  where o.bucket_id = 'receipts' and o.owner_id = v_uid and e.receipt_path = o.name;
  insert into public.receipt_trash (path)
  select o.name from storage.objects o where o.bucket_id = 'receipts' and o.owner_id = v_uid
  on conflict (path) do nothing;

  -- Your place in every group goes to a numbered stand-in.
  perform public.retire_account(uid);

  -- Your personal data.
  delete from public.payment_methods where user_id = uid;
  delete from public.notifications where user_id = uid;
  delete from public.hidden_groups where user_id = uid;
  delete from public.receipt_scans where user_id = uid;

  -- Finally the login, which takes the profile (and your name) with it.
  delete from auth.users where id = uid;
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Accounts deleted before this change kept their name: give them stand-ins too, then drop them.
do $$
declare v_id uuid;
begin
  for v_id in select id from public.profiles where not is_guest and deleted_at is not null loop
    perform public.retire_account(v_id);
    delete from public.profiles where id = v_id;
  end loop;
end $$;

-- Answering a payment: the person it was paid to, or (when that's a deleted member) the group's
-- owner or a co-owner. Who answered is kept.
create or replace function public.respond_to_payment(p_settlement_id uuid, p_received boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  s public.settlements;
begin
  select * into s from public.settlements where id = p_settlement_id for update;
  if s.id is null or not public.is_group_member(s.group_id) or not (
    s.to_user_id = uid
    or (public.is_deleted_member(s.to_user_id) and public.group_role_of(s.group_id, uid) in ('owner', 'admin'))
  ) then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  if s.status::text <> 'pending' then
    raise exception 'This payment has already been answered or cancelled' using errcode = '22023';
  end if;

  update public.settlements
  set status = (case when p_received then 'recorded' else 'declined' end)::public.settlement_status,
      responded_at = now(), responded_by = uid
  where id = s.id;

  -- Tell whoever recorded it (unless that's you, or a deleted member).
  if s.created_by <> uid and not exists (select 1 from public.profiles where id = s.created_by and is_guest) then
    insert into public.notifications (user_id, kind, group_id, actor_id, amount_cents, settlement_id)
    values (s.created_by, case when p_received then 'payment_confirmed' else 'payment_declined' end,
            s.group_id, uid, s.amount_cents, s.id);
  end if;
  -- The other owners and co-owners no longer need to answer it.
  if public.is_deleted_member(s.to_user_id) then
    delete from public.notifications
    where settlement_id = s.id and kind = 'payment_to_confirm' and user_id <> uid;
  end if;
end $$;

-- Payments waiting for you: yours, plus (for owners and co-owners) those to deleted members.
drop function public.payments_to_confirm();
create function public.payments_to_confirm()
returns table (id uuid, group_id uuid, group_name text, group_icon text, group_currency text,
               from_user_id uuid, from_name text, amount_cents bigint, occurred_at timestamptz,
               created_at timestamptz, to_user_id uuid, to_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select s.id, s.group_id, g.name, g.icon, g.currency, s.from_user_id, p.name, s.amount_cents, s.occurred_at, s.created_at,
         s.to_user_id, t.name
  from public.settlements s
  join public.groups g on g.id = s.group_id and g.archived_at is null
  join public.profiles p on p.id = s.from_user_id
  join public.profiles t on t.id = s.to_user_id
  where s.status::text = 'pending'
    and public.is_group_member(s.group_id)
    and (
      s.to_user_id = (select auth.uid())
      or (t.is_guest and t.deleted_at is not null and public.group_role_of(s.group_id, (select auth.uid())) in ('owner', 'admin'))
    )
  order by s.created_at desc;
end $$;

revoke execute on function public.payments_to_confirm() from public, anon;
grant execute on function public.payments_to_confirm() to authenticated;

-- Deleted members can't be sent an invite or a view link.
create or replace function public.create_invite(p_group_id uuid, p_guest_id uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_token text;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not a member of this group' using errcode = '42501';
  end if;
  if p_guest_id is not null and not exists (
    select 1 from public.profiles p
    join public.group_members m on m.user_id = p.id and m.group_id = p_group_id and m.left_at is null
    where p.id = p_guest_id and p.is_guest and p.guest_group_id = p_group_id and p.claimed_by is null and p.deleted_at is null
  ) then
    raise exception 'That guest is not in this group, or has already joined' using errcode = '22023';
  end if;

  insert into public.group_invites (group_id, invited_by, guest_id)
  values (p_group_id, uid, p_guest_id)
  returning token into v_token;
  return v_token;
end $$;

create or replace function public.guest_link(p_group_id uuid, p_guest_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_token text;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not a member of this group' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    join public.group_members m on m.user_id = p.id and m.group_id = p_group_id and m.left_at is null
    where p.id = p_guest_id and p.is_guest and p.guest_group_id = p_group_id and p.claimed_by is null and p.deleted_at is null
  ) then
    raise exception 'That guest is not in this group, or has already joined' using errcode = '22023';
  end if;

  select token into v_token from public.guest_links where guest_id = p_guest_id and revoked_at is null;
  if v_token is null then
    insert into public.guest_links (group_id, guest_id, created_by)
    values (p_group_id, p_guest_id, uid)
    returning token into v_token;
  end if;
  return v_token;
end $$;
