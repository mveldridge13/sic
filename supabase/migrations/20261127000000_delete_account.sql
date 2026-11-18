-- Deleting your account (Profile → Delete account).
--
-- Other people's groups depend on your expenses, splits and payments, so the money history
-- stays and keeps showing your name. Everything else that's yours goes:
--   * your login (email, password, sessions) is deleted from auth.users
--   * your PayID, notifications, put-away groups, receipt-scan log, photo, time zone and
--     scan consent are removed; your profile keeps only its name, marked deleted_at
--   * you leave every group; groups you own pass to a co-owner, or else the longest-standing
--     member with an account; a group with nobody else with an account is deleted
--   * your unanswered payments are cancelled, your open invites expire, and repeating
--     expenses you pay are stopped (ones you're only split into pause themselves, as they do
--     when anyone leaves)
--
-- You can't delete while you owe or are owed money in any group: settle up first, so nobody
-- is left out of pocket. Signing up again with the same email starts a new, empty account.

alter table public.profiles add column deleted_at timestamptz;

-- Keep a deleted account's profile (it holds the name the history shows).
create or replace function public.delete_profile_with_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.profiles where id = old.id and not is_guest and deleted_at is null;
  return old;
end $$;

-- A deleted account can't be added to groups again.
create or replace function public.split_partners()
returns table (user_id uuid, name text, shared_groups integer, last_shared_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, count(distinct me.group_id)::integer, max(greatest(me.joined_at, them.joined_at))
  from public.group_members me
  join public.group_members them on them.group_id = me.group_id and them.user_id <> me.user_id
  join public.profiles p on p.id = them.user_id and not p.is_guest and p.deleted_at is null
  where me.user_id = (select auth.uid())
  group by p.id, p.name
  order by max(greatest(me.joined_at, them.joined_at)) desc, p.name;
$$;

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_unsettled text;
  v_group uuid;
  v_new_owner uuid;
begin
  -- Settled everywhere first.
  select string_agg(g.name, ', ' order by g.name) into v_unsettled
  from public.group_members m
  join public.groups g on g.id = m.group_id and g.archived_at is null
  where m.user_id = uid and m.left_at is null
    and public.member_net_balance(m.group_id, uid) <> 0;
  if v_unsettled is not null then
    raise exception 'Settle up first. You still owe or are owed money in: %', v_unsettled using errcode = '23514';
  end if;

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
    end if;
  end loop;

  -- Leave every group (history stays, as with leaving).
  update public.group_members set left_at = now(), role = 'member'
  where user_id = uid and left_at is null;

  -- Loose ends nobody could finish without you.
  update public.settlements set status = 'voided'
  where status::text = 'pending' and (from_user_id = uid or to_user_id = uid);
  update public.group_invites set expires_at = now()
  where invited_by = uid and accepted_at is null and expires_at > now();
  update public.recurring_expenses set stopped_at = now(), updated_at = now()
  where payer_id = uid and stopped_at is null;

  -- Your personal data.
  delete from public.payment_methods where user_id = uid;
  delete from public.notifications where user_id = uid;
  delete from public.hidden_groups where user_id = uid;
  delete from public.receipt_scans where user_id = uid;
  update public.profiles set
    avatar_url = null, time_zone = null,
    receipt_scan_consent = null, receipt_scan_consent_at = null,
    deleted_at = now()
  where id = uid;

  -- Finally the login itself.
  delete from auth.users where id = uid;
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
