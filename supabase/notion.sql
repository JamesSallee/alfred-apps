-- Notion copies and the weekly backup (supabase/functions/alfred-notion).
-- Run after schema.sql. Replace the five placeholders before running; never commit the real values.
--
--   OWNER_EMAIL      the owner's sign-in email
--   TASKS_DB_ID      Notion Tasks database id
--   DESK_DB_ID       Notion "Writing Desk" database id
--   BACKUP_PAGE_ID   Notion "Alfred backups" page id
--   PROJECT_REF      the Supabase project ref (the subdomain of its URL)
--
-- Then add NOTION_TOKEN under Supabase -> Edge Functions -> Secrets and deploy the function with
-- verify_jwt off (it checks the caller itself): supabase functions deploy alfred-notion --no-verify-jwt

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Config in the vault: the owner, the Notion ids, and a random secret the scheduled calls carry.
do $$
declare
  cfg text := json_build_object(
    'owner', (select id from auth.users where email = 'OWNER_EMAIL'),
    'cron', encode(extensions.gen_random_bytes(24), 'hex'),
    'tasksDb', 'TASKS_DB_ID',
    'deskDb', 'DESK_DB_ID',
    'backupPage', 'BACKUP_PAGE_ID')::text;
  existing uuid := (select id from vault.secrets where name = 'alfred_notion_config');
begin
  if existing is null then perform vault.create_secret(cfg, 'alfred_notion_config');
  else perform vault.update_secret(existing, cfg); end if;
end $$;

-- Only the function (service role) and the cron job can read it.
create or replace function public.alfred_notion_config() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'alfred_notion_config'
$$;
revoke all on function public.alfred_notion_config() from public, anon, authenticated;
grant execute on function public.alfred_notion_config() to service_role;

-- The scheduled calls. Times are UTC: the mirror at 7 past every hour, the backup Sunday 08:00 (3 or 4 am in New York).
create or replace function public.alfred_notion_call(action text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/alfred-notion',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (public.alfred_notion_config()::json->>'cron')),
    body := jsonb_build_object('action', action),
    timeout_milliseconds := 60000)
$$;
revoke all on function public.alfred_notion_call(text) from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('alfred-notion-mirror', 'alfred-weekly-backup');
select cron.schedule('alfred-notion-mirror', '7 * * * *', $$ select public.alfred_notion_call('mirror') $$);
select cron.schedule('alfred-weekly-backup', '0 8 * * 0', $$ select public.alfred_notion_call('backup') $$);
