-- Run after storing portfolio_telegram_token and portfolio_openai_key in Vault.
-- No secret values need to be copied into SQL or command history.
select net.http_post(
 url:='https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/register',
 headers:=jsonb_build_object('Content-Type','application/json','x-portfolio-worker-secret',portfolio_private.read_config()->>'worker_secret'),
 body:='{}'::jsonb,
 timeout_milliseconds:=30000
) as request_id;
-- In a subsequent query, inspect net._http_response using the returned request_id.
-- Successful registration returns the bot's username and Telegram URL.
