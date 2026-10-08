-- Reclassify the first collection using the context actually rendered in cards.
-- A generic macro survey alone does not count as stock or crypto coverage.
update public.pr_outlook_snapshots s
set data=jsonb_set(s.data,'{status}','"unavailable"'::jsonb)
from public.pr_outlook_jobs j
where s.asset_key=j.asset_key and s.service_day=j.service_day
 and s.data->>'status'='context'
 and coalesce(s.data->'bond','null'::jsonb)='null'::jsonb
 and coalesce(s.data->'crypto','null'::jsonb)='null'::jsonb
 and not (coalesce(s.data->'macro','null'::jsonb)<>'null'::jsonb and
  (j.asset->>'kind' in ('bond','fund','cash','currency') or j.asset->>'provider'='cash'));
