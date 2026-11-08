-- The allow-list: only the accounts listed here may read or write anything, or call the edge functions.
-- Belt and braces on top of the per-owner rules in schema.sql, larder.sql and wardrobe.sql:
-- even if "Allow new users to sign up" is switched back on, a stranger's account sees nothing and can't spend anything.
-- Run after schema.sql, larder.sql and wardrobe.sql. Safe to run again.

-- 1. Who is allowed. Keyed by account id, so no email addresses live in this repo.
create table if not exists public.allowed_users (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.allowed_users enable row level security;   -- no policies: only is_allowed() and the service role read it
revoke all on public.allowed_users from anon, authenticated;

-- Seed: the Larder's owner and every household member (today, the two accounts that exist).
insert into public.allowed_users (user_id)
select owner_id from public.household_members
union
select member_id from public.household_members
on conflict do nothing;

-- 2. Is the signed-in account on the list?
create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.allowed_users a where a.user_id = (select auth.uid()))
$$;
revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated, service_role;

-- 3. Restrictive policies are ANDed with the existing ones, so every current rule still applies,
--    and now only for accounts on the list.
drop policy if exists "allow-listed only" on public.app_data;
create policy "allow-listed only" on public.app_data
  as restrictive for all to authenticated
  using ((select public.is_allowed())) with check ((select public.is_allowed()));

drop policy if exists "allow-listed only" on public.household_members;
create policy "allow-listed only" on public.household_members
  as restrictive for all to authenticated
  using ((select public.is_allowed())) with check ((select public.is_allowed()));

drop policy if exists "allow-listed only" on public.ai_usage;
create policy "allow-listed only" on public.ai_usage
  as restrictive for all to authenticated
  using ((select public.is_allowed())) with check ((select public.is_allowed()));

drop policy if exists "allow-listed only" on storage.objects;
create policy "allow-listed only" on storage.objects
  as restrictive for all to authenticated
  using ((select public.is_allowed())) with check ((select public.is_allowed()));

-- 4. No new accounts unless a pass has been issued for that email first.
--    To add someone: insert their email here, invite them (Authentication -> Users -> Invite user),
--    then add their id to allowed_users (and household_members if they share the Larder). Delete the pass afterwards.
create table if not exists public.signup_passes (
  email    text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
alter table public.signup_passes enable row level security;
revoke all on public.signup_passes from anon, authenticated;

create or replace function public.guard_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or not exists (select 1 from public.signup_passes p where p.email = lower(new.email)) then
    raise exception 'Sign-ups are closed.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_new_user() from public, anon, authenticated;

drop trigger if exists guard_new_user on auth.users;
create trigger guard_new_user before insert on auth.users
  for each row execute function public.guard_new_user();
