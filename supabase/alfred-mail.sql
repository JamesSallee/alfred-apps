-- Alfred's morning email (supabase/functions/alfred-mail). Run after notion.sql (it reuses that vault config).
-- Replace PROJECT_REF, add RESEND_API_KEY under Supabase -> Edge Functions -> Secrets, and deploy the
-- function with verify_jwt off: supabase functions deploy alfred-mail --no-verify-jwt
--
-- The morning note writes its content to app_data (app 'alfred', key 'outbox/<YYYY-MM-DD>') and then runs
--   select public.alfred_mail_send('outbox/<YYYY-MM-DD>');
-- The function stamps sentAt (or error) on that row, so check it a few seconds later.

create or replace function public.alfred_mail_send(note_key text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/alfred-mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (public.alfred_notion_config()::json->>'cron')),
    body := jsonb_build_object('action', 'send', 'key', note_key),
    timeout_milliseconds := 30000)
$$;
revoke all on function public.alfred_mail_send(text) from public, anon, authenticated;
