-- Fun money for the Daily Ledger: one-off data change, run once after the new ledger.html is live.
-- Re-scores habits (new point values and weekly bonus targets), reprices the store in dollars,
-- and adds the hourly treats. Safe to run twice: every statement sets fixed values.

-- 1. Habit points and weekly bonus targets
with v(id, points, bonus_at, bonus) as (values
  ('workout',   10, 6, 10),
  ('write',     10, 4, 10),
  ('bootcamp',  30, 2, 10),
  ('piano',      6, 5, 10),
  ('bed-by-11',  5, 0, 0),
  ('meditate',   4, 0, 0),
  ('journal',    3, 0, 0),
  ('tidy',       3, 0, 0),
  ('hmw5umw9e',  2, 0, 0),  -- Drink 64 oz of water
  ('walk-mara',  2, 0, 0)
)
update public.app_data a
   set value = a.value || jsonb_build_object('points', v.points, 'bonusAt', v.bonus_at, 'bonus', v.bonus)
  from v
 where a.app = 'ledger' and a.key = 'habits/' || v.id;

-- 2. Store: real prices in dollars
with v(id, price) as (values ('coffee', 6), ('book', 20), ('sheetmusic', 15), ('dinner', 60))
update public.app_data a
   set value = (a.value - 'cost') || jsonb_build_object('price', v.price, 'kind', 'thing', 'note', '')
  from v
 where a.app = 'ledger' and a.key = 'store/' || v.id;

-- Rest is free: the lie-in leaves the shop (soft delete, so every device hears about it)
update public.app_data set deleted = true where app = 'ledger' and key = 'store/liein';

-- 3. Hourly treats
insert into public.app_data (user_id, app, key, value)
select u.user_id, 'ledger', x.key, x.value::jsonb
  from (select distinct user_id from public.app_data where app = 'ledger' and key = 'settings/main') u,
       (values
         ('store/playstation', '{"name":"PlayStation","kind":"time","price":5,"extraPrice":8,"gateAny":2,"note":"After any two habits today"}'),
         ('store/tv',          '{"name":"Extra hour of TV","kind":"time","price":2,"extraPrice":2,"note":"One show a night is free"}')
       ) as x(key, value)
on conflict (user_id, app, key) do update set value = excluded.value, deleted = false;

-- 4. Money settings (defaults also live in js/money.js)
update public.app_data
   set value = value || '{"money":{"monthly":500,"start":"2026-11-02","phone":{"start":6}}}'::jsonb
 where app = 'ledger' and key = 'settings/main';
