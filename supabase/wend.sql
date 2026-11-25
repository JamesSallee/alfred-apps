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
-- The user id is James's (the owner of the app_data rows).
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
  values ('da1b2990-452c-4a9d-9650-0a391decd188'::uuid, 'wend', 'years/' || lpad(new.year::text, 4, '0'),
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
