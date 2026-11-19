-- Guest links: a guest (someone added by name, with no sic account) gets their own private link
-- that opens their view of the group in a web browser, with no account and no app:
--   * their balance, and who they pay or get paid by
--   * the expenses they're in (paid or shared), and the payments they made or received
--   * the group owner's PayID when they owe the owner (AUD groups, as in the app)
-- View only: nothing can be changed through a link.
--
-- One link per guest. Anyone in the group can share it (like an invite); the owner, co-owners and
-- whoever made the link can turn it off. It stops working by itself when the guest joins sic
-- (claims their place), leaves or is removed, or the group is deleted. Turning it off and
-- sharing again makes a new link; the old one stays dead.

create table public.guest_links (
  token       text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  group_id    uuid not null references public.groups (id) on delete cascade,
  guest_id    uuid not null references public.profiles (id) on delete cascade,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles (id) on delete set null,
  last_viewed_at timestamptz
);
-- At most one working link per guest.
create unique index guest_links_one_active on public.guest_links (guest_id) where revoked_at is null;
create index guest_links_group_idx on public.guest_links (group_id);

alter table public.guest_links enable row level security;
-- People in the group can see whether a guest's link is on (and when it was last opened).
create policy "members read guest links" on public.guest_links for select to authenticated
  using (public.is_group_member(group_id));

-- ─── Share: get the guest's link, making it if there isn't one ───────────────
create function public.guest_link(p_group_id uuid, p_guest_id uuid) returns text
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
    where p.id = p_guest_id and p.is_guest and p.guest_group_id = p_group_id and p.claimed_by is null
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

-- ─── Turn off ────────────────────────────────────────────────────────────────
create function public.turn_off_guest_link(p_group_id uuid, p_guest_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_link public.guest_links;
begin
  select * into v_link from public.guest_links
  where group_id = p_group_id and guest_id = p_guest_id and revoked_at is null
  for update;
  if v_link.token is null then
    return; -- already off
  end if;
  if not (public.group_role_of(p_group_id, uid) in ('owner', 'admin')
          or (v_link.created_by = uid and public.is_group_member(p_group_id))) then
    raise exception 'Only the owner, a co-owner or whoever shared the link can turn it off' using errcode = '42501';
  end if;
  update public.guest_links set revoked_at = now(), revoked_by = uid where token = v_link.token;
end $$;

-- ─── What the link shows ─────────────────────────────────────────────────────
-- Called from the web page without signing in. Everything is limited to what concerns the guest.
create function public.guest_view(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link public.guest_links;
  v_group public.groups;
  v_guest public.profiles;
  v_owner uuid;
  v_payid jsonb;
  v_transfers jsonb;
begin
  select l.* into v_link from public.guest_links l where l.token = p_token and l.revoked_at is null;
  select * into v_group from public.groups where id = v_link.group_id and archived_at is null;
  select * into v_guest from public.profiles where id = v_link.guest_id;
  if v_link.token is null or v_group.id is null or v_guest.claimed_by is not null
     or not exists (select 1 from public.group_members
                    where group_id = v_link.group_id and user_id = v_link.guest_id and left_at is null) then
    raise exception 'This link isn’t working any more. Ask the person who sent it for a new one.' using errcode = '22023';
  end if;

  update public.guest_links set last_viewed_at = now() where token = p_token;

  select user_id into v_owner from public.group_members
  where group_id = v_group.id and role = 'owner' and left_at is null limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'from', pf.name, 'to', pt.name, 'amount', t.amount_cents,
           'guest_pays', t.from_user_id = v_guest.id, 'to_owner', t.to_user_id = v_owner)
           order by t.amount_cents desc), '[]'::jsonb)
    into v_transfers
  from public.simplified_transfers(v_group.id) t
  join public.profiles pf on pf.id = t.from_user_id
  join public.profiles pt on pt.id = t.to_user_id
  where v_guest.id in (t.from_user_id, t.to_user_id);

  -- The owner's PayID, only when the guest has to pay the owner (PayID is Australian: AUD only).
  if v_group.currency = 'AUD' and exists (
    select 1 from public.simplified_transfers(v_group.id) t where t.from_user_id = v_guest.id and t.to_user_id = v_owner
  ) then
    select jsonb_build_object('type', pm.payid_type, 'value', pm.value, 'account_name', pm.account_name)
      into v_payid
    from public.payment_methods pm where pm.user_id = v_owner and pm.kind = 'payid';
  end if;

  return jsonb_build_object(
    'group', jsonb_build_object('name', v_group.name, 'icon', v_group.icon, 'currency', v_group.currency,
                                'closed', v_group.closed_at is not null),
    'guest', v_guest.name,
    'owner', (select name from public.profiles where id = v_owner),
    'balance', public.member_net_balance(v_group.id, v_guest.id),
    'transfers', v_transfers,
    'payid', v_payid,
    'expenses', (
      select coalesce(jsonb_agg(x order by x ->> 'date' desc, x ->> 'created' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'description', e.description,
          'date', e.occurred_at,
          'created', e.created_at,
          'amount', e.amount_cents,
          'payer', pp.name,
          'paid_by_guest', e.payer_id = v_guest.id,
          'share', (select s.amount_cents from public.expense_splits s where s.expense_id = e.id and s.user_id = v_guest.id),
          'category', e.category,
          'original_currency', e.original_currency,
          'original_amount', e.original_amount
        ) as x
        from public.expenses e
        join public.profiles pp on pp.id = e.payer_id
        where e.group_id = v_group.id and e.deleted_at is null
          and (e.payer_id = v_guest.id
               or exists (select 1 from public.expense_splits s where s.expense_id = e.id and s.user_id = v_guest.id))
        order by e.occurred_at desc, e.created_at desc
        limit 200
      ) rows
    ),
    'payments', (
      select coalesce(jsonb_agg(x order by x ->> 'date' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'from', pf.name, 'to', pt.name, 'amount', st.amount_cents, 'date', st.occurred_at,
          'guest_paid', st.from_user_id = v_guest.id, 'pending', st.status::text = 'pending'
        ) as x
        from public.settlements st
        join public.profiles pf on pf.id = st.from_user_id
        join public.profiles pt on pt.id = st.to_user_id
        where st.group_id = v_group.id and st.status::text in ('recorded', 'pending')
          and v_guest.id in (st.from_user_id, st.to_user_id)
        order by st.occurred_at desc
        limit 200
      ) rows
    )
  );
end $$;

revoke execute on function public.guest_link(uuid, uuid), public.turn_off_guest_link(uuid, uuid) from public, anon;
grant execute on function public.guest_link(uuid, uuid), public.turn_off_guest_link(uuid, uuid) to authenticated;
revoke execute on function public.guest_view(text) from public;
grant execute on function public.guest_view(text) to anon, authenticated;
