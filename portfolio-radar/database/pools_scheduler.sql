-- Run after deploying 0.8.0. The secret is read inside Postgres, not copied here.
select cron.schedule('portfolio-radar-pools','* * * * *',$job$
 select net.http_post(
  url := 'https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/pools-work',
  headers := jsonb_build_object('Content-Type','application/json',
   'x-portfolio-worker-secret',portfolio_private.read_config()->>'worker_secret'),
  body := '{}'::jsonb,
  timeout_milliseconds := 10000
 );
$job$);
