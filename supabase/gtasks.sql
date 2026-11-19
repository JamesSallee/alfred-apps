-- Alfred on the wrist through Google Tasks (supabase/functions/alfred-gtasks). Run after notion.sql.
-- Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET under Supabase -> Edge Functions -> Secrets and deploy the
-- function with verify_jwt off: supabase functions deploy alfred-gtasks --no-verify-jwt

-- A small vault wrapper so functions can keep tokens out of app_data (which the rooms sync to browsers).
create or replace function public.alfred_secret_set(secret_name text, secret_value text) returns void
language plpgsql security definer set search_path = '' as $$
declare existing uuid := (select id from vault.secrets where name = secret_name);
begin
  if secret_name not like 'alfred\_%' then raise exception 'Only alfred_ secrets.'; end if;
  if existing is null then perform vault.create_secret(secret_value, secret_name);
  else perform vault.update_secret(existing, secret_value); end if;
end $$;
create or replace function public.alfred_secret_get(secret_name text) returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name and secret_name like 'alfred\_%'
$$;
revoke all on function public.alfred_secret_set(text, text) from public, anon, authenticated;
revoke all on function public.alfred_secret_get(text) from public, anon, authenticated;
grant execute on function public.alfred_secret_set(text, text) to service_role;
grant execute on function public.alfred_secret_get(text) to service_role;

-- The sync, every 5 minutes. It does nothing until Google Tasks is connected.
create or replace function public.alfred_gtasks_sync() returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://llirhlpsfylhbvogjutj.supabase.co/functions/v1/alfred-gtasks',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (public.alfred_notion_config()::json->>'cron')),
    body := jsonb_build_object('a', 'sync'),
    timeout_milliseconds := 60000)
$$;
revoke all on function public.alfred_gtasks_sync() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'alfred-gtasks-sync';
select cron.schedule('alfred-gtasks-sync', '*/5 * * * *', $$ select public.alfred_gtasks_sync() $$);
