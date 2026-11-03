-- The Larder: share one app's rows with a household member, and keep a ledger of Claude spend.
-- Run after schema.sql. Safe to run again.

-- 1. Who shares what. One row per (owner, member, app). The owner's rows for that app become
--    readable and writable by the member; nothing else of the owner's is visible to them.
--    Rows are added by hand (see README: "Inviting Maggie"), never from the apps.
create table if not exists public.household_members (
  owner_id  uuid not null references auth.users (id) on delete cascade,
  member_id uuid not null references auth.users (id) on delete cascade,
  app       text not null,
  added_at  timestamptz not null default now(),
  primary key (owner_id, member_id, app),
  check (owner_id <> member_id)
);
alter table public.household_members enable row level security;

drop policy if exists "see own memberships" on public.household_members;
create policy "see own memberships" on public.household_members
  for select to authenticated
  using ((select auth.uid()) in (owner_id, member_id));

-- 2. Members may read and write the owner's rows for the shared app only.
drop policy if exists "household shared apps" on public.app_data;
create policy "household shared apps" on public.app_data
  for all to authenticated
  using (exists (
    select 1 from public.household_members h
    where h.owner_id = app_data.user_id and h.member_id = (select auth.uid()) and h.app = app_data.app))
  with check (exists (
    select 1 from public.household_members h
    where h.owner_id = app_data.user_id and h.member_id = (select auth.uid()) and h.app = app_data.app));

-- 3. Whose rows an app should use: the owner's if I'm a member, otherwise my own.
create or replace function public.shared_owner(p_app text) returns uuid
language sql stable security invoker set search_path = '' as $$
  select coalesce(
    (select h.owner_id from public.household_members h
      where h.member_id = (select auth.uid()) and h.app = p_app
      order by h.added_at limit 1),
    (select auth.uid()))
$$;

-- 4. Claude spend, written only by the edge function (service role). Readable by the household
--    so the app can show "this month: $0.42 of $5".
create table if not exists public.ai_usage (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  action     text not null,
  model      text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  searches   integer not null default 0,
  cost_usd   numeric(10, 5) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_owner_month_idx on public.ai_usage (owner_id, created_at);
alter table public.ai_usage enable row level security;

drop policy if exists "household reads usage" on public.ai_usage;
create policy "household reads usage" on public.ai_usage
  for select to authenticated
  using (owner_id = (select public.shared_owner('larder')));
