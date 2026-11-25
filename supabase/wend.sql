-- The Isle of Wend (see wend/storyteller.md). Applied 24 Nov 2026.
-- A separate schema, closed to the browser keys: only the storyteller task and the island page
-- (through James's Supabase connector) read and write it. The Reading Room sees each year
-- through a copy in app_data (app 'wend', key years/NNNN), made by the trigger below.

create schema if not exists island;
revoke all on schema island from anon, authenticated;

create table island.world (
  id int primary key default 1 check (id = 1),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table island.chronicle (
  id bigserial primary key,
  year int not null,
  era text not null,
  real_date date not null,
  real_weather text,
  title text not null,
  body text not null,
  dispatch text not null,
  historian text not null,
  created_at timestamptz not null default now()
);

create table island.omens (
  id bigserial primary key,
  kind text not null check (kind in ('sky','object')),
  payload text check (payload is null or char_length(payload) <= 60),
  created_at timestamptz not null default now(),
  consumed_year int
);

alter table island.world enable row level security;
alter table island.chronicle enable row level security;
alter table island.omens enable row level security;
revoke all on all tables in schema island from anon, authenticated;

-- Copy the whole day into the Reading Room: the entry, the dispatch, the omens James sent,
-- the places on the map and a snapshot of the island at the end of that year.
-- <james-user-id> is James's auth user id (the owner of the app_data rows); the live function has the real one.
create or replace function island.copy_year_to_app_data() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  snap jsonb;
  oms jsonb;
begin
  select w.state - 'seed' - 'features' into snap from island.world w where w.id = 1 and (w.state->>'year')::int = new.year;
  select coalesce(jsonb_agg(jsonb_build_object('kind', o.kind, 'payload', o.payload, 'sent', o.created_at) order by o.id), '[]'::jsonb)
    into oms from island.omens o where o.consumed_year = new.year;
  insert into public.app_data (user_id, app, key, value, deleted, updated_at)
  values ('<james-user-id>'::uuid, 'wend', 'years/' || lpad(new.year::text, 4, '0'),
    jsonb_build_object('year', new.year, 'era', new.era, 'date', new.real_date, 'weather', new.real_weather,
      'title', new.title, 'body', new.body, 'dispatch', new.dispatch, 'historian', new.historian,
      'omens', oms,
      'places', (select coalesce(jsonb_agg(f->>'name'), '[]'::jsonb) from island.world w, jsonb_array_elements(w.state->'features') f where w.id = 1 and (w.state->>'year')::int = new.year),
      'state', snap),
    false, now())
  on conflict (user_id, app, key) do update
    set value = excluded.value || jsonb_build_object('state', coalesce(excluded.value->'state', public.app_data.value->'state'),
                                                     'places', case when excluded.value->'state' is null then public.app_data.value->'places' else excluded.value->'places' end),
        deleted = false, updated_at = now();
  return new;
end $$;
revoke all on function island.copy_year_to_app_data() from public, anon, authenticated;

create trigger chronicle_to_app_data after insert or update on island.chronicle
for each row execute function island.copy_year_to_app_data();

-- Added 25 Nov 2026: a copy of the island at the end of each year, for the island page's year slider.
alter table island.chronicle add column if not exists world_state jsonb;

create or replace function island.snapshot_world() returns trigger
language plpgsql security definer set search_path = '' as $$
declare snap jsonb;
begin
  select w.state into snap from island.world w where w.id = 1 and (w.state->>'year')::int = new.year;
  if snap is not null then new.world_state := snap; end if;
  return new;
end $$;
revoke all on function island.snapshot_world() from public, anon, authenticated;

drop trigger if exists chronicle_snapshot_world on island.chronicle;
create trigger chronicle_snapshot_world before insert or update on island.chronicle
for each row execute function island.snapshot_world();

update island.chronicle c set world_state = w.state
from island.world w where w.id = 1 and (w.state->>'year')::int = c.year and c.world_state is null;



-- ===== Study Wend page (wend.html): fuller yearly copies + sign-in-only omens =====
-- Applied by the island page itself (ensureSite). Replace <james-user-id> before running by hand.
-- Added 25 Nov 2026: the Isle of Wend inside Alfred's Study (wend.html), for James's signed-in account only.
-- 1) The Reading Room / Study copy (app_data app 'wend', years/NNNN) now carries the whole island as it stood
--    at the end of that year, map and seed included, so the Study can draw it without reaching the island schema.
create or replace function island.copy_year_to_app_data() returns trigger
language plpgsql security definer set search_path = '' as $$
-- v2: full snapshot (features and seed kept) for the Study's Wend page
declare
  snap jsonb;
  oms jsonb;
begin
  snap := new.world_state;
  if snap is null then
    select w.state into snap from island.world w where w.id = 1 and (w.state->>'year')::int = new.year;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', o.kind, 'payload', o.payload, 'sent', o.created_at) order by o.id), '[]'::jsonb)
    into oms from island.omens o where o.consumed_year = new.year;
  insert into public.app_data (user_id, app, key, value, deleted, updated_at)
  values ('<james-user-id>'::uuid, 'wend', 'years/' || lpad(new.year::text, 4, '0'),
    jsonb_build_object('year', new.year, 'era', new.era, 'date', new.real_date, 'weather', new.real_weather,
      'title', new.title, 'body', new.body, 'dispatch', new.dispatch, 'historian', new.historian,
      'omens', oms,
      'places', coalesce((select jsonb_agg(f->>'name') from jsonb_array_elements(snap->'features') f), '[]'::jsonb),
      'state', snap),
    false, now())
  on conflict (user_id, app, key) do update
    set value = excluded.value || jsonb_build_object('state', coalesce(excluded.value->'state', public.app_data.value->'state'),
                                                     'places', case when excluded.value->'state' is null then public.app_data.value->'places' else excluded.value->'places' end),
        deleted = false, updated_at = now();
  return new;
end $$;
revoke all on function island.copy_year_to_app_data() from public, anon, authenticated;

-- 2) Two narrow doors for the Study, open only to James's signed-in account: see the omens waiting for dawn, and send one.
create or replace function public.wend_pending_omens()
returns table (id bigint, kind text, payload text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.kind, o.payload, o.created_at from island.omens o
  where o.consumed_year is null and (select auth.uid()) = '<james-user-id>'::uuid
  order by o.id
$$;
revoke all on function public.wend_pending_omens() from public, anon;
grant execute on function public.wend_pending_omens() to authenticated;

create or replace function public.wend_send_omen(p_kind text, p_payload text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare n int; clean text;
begin
  if (select auth.uid()) is distinct from '<james-user-id>'::uuid then raise exception 'not allowed'; end if;
  if p_kind = 'sky' then
    if exists (select 1 from island.omens where kind = 'sky' and consumed_year is null) then return 'already'; end if;
    insert into island.omens (kind, payload) values ('sky', null);
    return 'ok';
  elsif p_kind = 'object' then
    clean := left(btrim(regexp_replace(coalesce(p_payload, ''), '[[:cntrl:]]', ' ', 'g')), 40);
    if clean = '' then return 'empty'; end if;
    select count(*) into n from island.omens where kind = 'object' and consumed_year is null;
    if n >= 3 then return 'full'; end if;
    insert into island.omens (kind, payload) values ('object', clean);
    return 'ok';
  end if;
  raise exception 'unknown omen';
end $$;
revoke all on function public.wend_send_omen(text, text) from public, anon;
grant execute on function public.wend_send_omen(text, text) to authenticated;

-- 3) Re-copy the years already written, so they carry the full island.
update island.chronicle set title = title;
