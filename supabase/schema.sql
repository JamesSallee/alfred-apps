-- Alfred's apps: one key-value table, private to the signed-in owner.
-- Each row is one item of one app (a habit, a day, a focus session, a Sunday review).

create table if not exists public.app_data (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  app        text        not null,               -- 'ledger' | 'focus' | 'shutdown' | 'study'
  key        text        not null,               -- e.g. 'days/2026-11-02', 'log', 'settings'
  value      jsonb,
  deleted    boolean     not null default false, -- soft delete so other devices hear about it
  updated_at timestamptz not null default now(),
  primary key (user_id, app, key)
);

create index if not exists app_data_updated_idx on public.app_data (user_id, updated_at);

alter table public.app_data enable row level security;

drop policy if exists "owner only" on public.app_data;
create policy "owner only" on public.app_data
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Server sets the timestamp, so device clocks never decide who wins.
create or replace function public.app_data_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists app_data_touch on public.app_data;
create trigger app_data_touch before insert or update on public.app_data
  for each row execute function public.app_data_touch();

-- Live updates between devices.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_data'
  ) then
    alter publication supabase_realtime add table public.app_data;
  end if;
end $$;
