# xStocks / USDC monitor — 0.8.3

## 0.8.3 — common top five

`/top5` and “Топ-5 пулов сейчас” show five pools from the entire shared market
cache, independent of a customer's holdings. Paid customers without LP imports
see this ranking when opening `/pools`. Personal LP summaries include a compact
top five; ordinary paid portfolio summaries include it when space permits and
always expose the full ranking button. Free/trial customers keep the existing
upgrade teaser. Delivery rechecks current entitlement and market freshness.

The ranking orders positive gross 24h fee APR, with the existing verified-pair,
four-hour freshness, TVL, volume, warning/halt and anomaly filters. It chooses the
newest comparable observation per pool identity before ranking, removes duplicate
addresses, and permits multiple different pools of one asset. Fewer than five
eligible pools produces an explicitly incomplete list, never fabricated entries.

Each full card shows asset, platform, network, fee tier, 24h/7d fee APR, separate
reward APR, TVL, volume, measurement time, pool link and source. Both views state
the actual watched-asset and eligible-pool counts: this is a top five of covered
sources, not an assertion of exhaustive worldwide coverage or a live tick feed.
Buttons and `/top5` read the shared cache without forcing provider calls. Source
collection cadence, subscription price and billing are unchanged.

Validation: 185 tests pass, including cross-asset ranking, newest-observation
deduplication, exclusion filters, empty/partial rankings, no-upload access,
delivery-time downgrade, cache-only callbacks and Telegram message lengths.

## 0.8.2 — proposals and opportunity-first reports

The default `/pools` screen now proposes a complete interpretation of unresolved
positions from verified cached pairs. A user can confirm and save it in one tap.
The same shortcut is offered after screenshot extraction, with a compact ten-row
preview. Detailed addresses, alternate candidates and manual corrections remain
behind “Изменить / другие варианты”. No identity is silently confirmed. Proposal
tokens bind the normalized positions and selected addresses, not changing yields
or ranking offsets; ownership, paid access and profile-version checks still apply.
Interrupted commits resume the same staged import. Repeated taps cannot replace
a newer profile. No new schema or public endpoints are required.

The home page leads with concrete alternatives: current pool → alternative,
comparable fee APR difference, a 30-day dollar scenario on the saved capital, and
the maximum one-time switching cost that the scenario could cover in 30 days.
It also identifies positions with no fee advantage from switching. A provisional
comparison before confirmation is explicitly labelled as an assumption. Pool
links and timestamps are shown; screenshots' personal APR/APY are not used as
current benchmarks. The detailed method remains available in comparison pages.

`lp-opportunities.js` distinguishes meaningful upside, small differences (under
$1/30 days), an adverse 7-day comparison, unknown capital, unknown/stale data,
out-of-range snapshots and flagged/anomalous pools. Out-of-range positions and
short-lived/uneconomic candidates do not inflate the actionable total. No missing
gas/bridge/swap cost is replaced with zero. Optional user-supplied USD switching
costs can be set with `/poolfix 1 расходы=5`; they enable a net-of-these-costs
scenario and payback time. All scenarios still exclude protocol deductions,
impermanent loss, token price movement and unspecified costs. They are not realized
forgone profit or a prediction of the user's actual concentrated-liquidity earnings.

The existing shared hourly collection, daily scheduled report and paid gating are
preserved. Daily reports now contain the opportunity summary. Extra notifications
require the same alternative in two fresh observations at least 30 minutes apart,
>= 5 percentage points and >= $1/30 days of practical scenario upside, with a 24h
cooldown. Known costs, an out-of-range snapshot or a contradictory 7-day window
prevent such a signal. Delivery checks the exact alternative again and drops a
signal whose premise disappeared. `/pause` and expired subscriptions stop delivery.

Validation: 180 Node tests pass, including one-tap confirmation, double taps,
interrupted commit recovery, stale proposals, ownership and downgrade checks,
scenario/cost math, weekly reversals, stable-signal filtering, delivery-time
revalidation and Telegram pagination. A read-only replay of the customer's saved
positions verified the compact proposal and opportunity report; private positions
are not committed as fixtures. No test Telegram messages or wallet actions.

## 0.8.1 — screenshot recovery and comparison UX

The first real import exposed a missing-context problem: the extractor saved
`CLMM` as the venue even though it describes the liquidity mechanism. Normalization
now stores CLMM/DLMM/AMM/CPMM in `pool_type`; a generic label never establishes a
venue or chain. The extraction schema and instructions enforce the same rule.

`/pools` now shows a compact overview (ten positions per page), saved USD value,
matching progress, historical screenshot rates, and a prominent out-of-range
notice. Detailed current pool comparisons are a separate view, also used by
automatic alerts. Screenshot timestamps survive later corrections.

“Уточнить мои пулы” opens a preview copied from the saved profile without a new
upload or AI request. Cached verified pairs supply venue/chain suggestions and
individual pool choices. Suggestions match the asset and any known fee tier and
pool type; a venue suggestion applies only where that context has one candidate.
Unknown identities never get assigned from the largest TVL or highest APR.
The user selects a context/pool, reviews the exact addresses, and explicitly saves.
Amounts, ranges, screenshot APR/APY and the screenshot timestamp are preserved.
The existing ownership, paid-access and optimistic profile-version commit checks
remain in force. Candidate callbacks use stable identity tokens, not mutable
ranking offsets; ambiguous tokens are rejected. Delivery rechecks entitlement.

DEX Screener's nullable `pairs` response is cached as no indexed data and shown in
coverage instead of being misclassified as a schema error. It does not acquire a
yield or enter the ranking. There are no new manual market refresh endpoints.

Validation: full Node suite, regression coverage for legacy CLMM imports, ambiguous
matches, reordering, ownership, downgrade at delivery, historical date preservation,
alert page routing, no-data responses, Telegram limits, and a read-only replay of
the saved real import. Production customer positions are never test fixtures or
part of this repository. No billing operations or test chat messages are required.

This release adds `/pools` and the home/report button. Paid subscribers can upload
up to 8 screenshots, inspect up to 30 LP positions, correct them with `/poolfix`,
and explicitly replace their saved LP list. Ordinary portfolio imports remain
separate. Free, pending and trial users receive a sourced conditional $1,000
scenario and an upgrade button, never the paid pool list. TBank billing is unchanged.

## Data and coverage

* The public xStocks v2 asset endpoint is authoritative for token deployments,
  wrapper addresses and the USDC contracts recognized for each network. Symbols
  alone are never trusted. EVM addresses are case-insensitive; Solana addresses
  are case-sensitive. USDT, USDG, SOL pairs, lending and leveraged vaults are excluded.
* DEX Screener discovers pairs for every registered deployment and wrapper with a
  verifiable USDC counterasset. The public DeFiLlama yield feed supplies additional
  candidates. This is indexed coverage, not a guarantee that every existing DEX
  or pool has been discovered. Missing chains/sources/USDC contracts are visible.
* Raydium, Orca and Meteora DLMM provide rolling volume/fees/TVL. For Fluxion on
  Mantle and Nest v3 on HyperEVM, fixed fee metadata is verified against the exact
  pair, then combined with that pool's current DEX Screener 24h volume and TVL.
  This estimate is labelled. Pools without a verified method remain visible in
  “Другие найденные пулы” and cannot lead the comparable ranking. Uniswap v4 pool
  IDs are preserved, but dynamic fees/hooks are not guessed.
* Registry and fixed fee metadata: daily / 6h shared cache. Discovery: 6h. Direct
  yields: hourly cache. One asset is processed per scheduled worker pass; queued
  assets are refreshed oldest-first. Source data are never fetched on button clicks.
  The initial market sample is MSFTx, TSLAx, NVDAx, SPYx, QQQx, COINx, AAPLx;
  paid users' saved LP assets automatically extend it. The public registry supports
  thousands of assets; no need to download every asset every hour.

## What the number means

The comparable metric is **gross pool fee APR**:

`rolling 24h gross fees USD / current pool TVL USD * 365 * 100`.

It excludes rewards, protocol deductions, compounding and token-price movement.
Rewards are a separate field; missing rewards remain unknown. Weekly fee indicators
use rolling 7d fees and current TVL. Raydium `volumeFee` is used directly; Meteora's
LP `fees` and `protocol_fees` are added to obtain gross fees. Meteora's field named
`apr` is not assumed to be annual: the observed API returns its daily fee/TVL
percentage. DeFiLlama's `apy` fields contain mixed adapter methodologies and never
enter the comparable APR ranking as-is.

Ranked pools require verified tokens, age <= 4h, TVL >= $10,000, daily volume >=
$1,000, no halted/warned asset, and APR <= 1,000%. Free examples additionally require
TVL >= $50,000 and APR <= 300%. These are eligibility filters, not safety ratings.

Personal comparison only compares the same xStock and an unambiguously identified
current pool. Screenshot APR/APY is preserved as historical display data and never
silently used as today's baseline. The 30d dollar difference is a conditional
scenario assuming the capital's share of fees equals its share of pool capital.
Concentrated liquidity, range, IL, protocol/bridge risk, gas, slippage and wrapping
make actual outcomes different. This is not guaranteed income or realized forgone
profit. No wallet signing, wallet tracking, transactions or automatic rebalancing.

## Reliability and access

`pr_lp_fetches` atomically reserves each source/bucket before HTTP; failures and
ambiguous requests are cached. No automatic request loop on HTTP 429/403. A failed
collection may retain older rows only with their original timestamps. A private
lease prevents concurrent collectors. Screenshots have a durable AI request intent;
an ambiguous completion is not automatically billed twice.

LP tables have RLS and service-role-only grants. Import ownership and base version
are checked on commit. Delivery revalidates paid access, opt-in and LP version.
`/pause`, blocked Telegram chats and `/delete` also stop LP notifications; user
tables cascade on deletion. Open imports expire after 24h; closed imports after
7d; source history after 8d; product events after 90d.

One daily report uses the user's existing time/timezone. An additional alert needs
two distinct fresh source observations at least 30 minutes apart, the same leading
pool and >= 5 percentage points difference, with a 24h cooldown. Alert delivery
checks that the difference still exists and opens the relevant positions page.
First ready reports and all automatic sends are deduplicated in the existing outbox.

`/admin` and the authenticated `/pools-metrics` endpoint expose adoption, upgrade
clicks, source failures and market coverage. No extra paid market-data keys needed.

## Release / operations

1. Apply `supabase/migrations/20261001205801_xstocks_liquidity_monitor.sql`.
   The migration name was generated using `supabase migration new`.
2. Deploy the current `src/*.js`, `src/index.ts`, and `deno.json` as the existing
   `portfolio-radar` Edge Function. Preserve existing custom webhook/worker auth.
3. Schedule `portfolio-radar-pools` every minute, POSTing `/pools-work` with the
   existing worker secret loaded inside SQL from `portfolio_private.read_config()`.
   This endpoint performs market collection; it does not charge subscriptions.
4. Call authenticated `/register` to expose `/pools` in Telegram's command menu.
5. Check `/health` version, `pr_lp_metrics()`, source states and new cron runs.

Validation: the full Node suite, identity/math/entitlement/ownership/cache/source
failure tests, and real MSFTx and NVDAx collection on 2026-10-01. Live collection
confirmed Solana, Mantle and HyperEVM pools. No customer test messages, wallet
transactions, charges or test subscriptions are created. Actual screenshot OCR
needs a real user LP screenshot; schema and workflow are tested without spending
on fabricated customer images.

Primary references:

* https://docs.xstocks.fi/developers
* https://docs.xstocks.fi/apis/openapi
* https://docs.dexscreener.com/api/reference
* https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/api/type.ts
* https://docs.orca.so/api-reference/whirlpools
* https://docs.meteora.ag/api-reference/dlmm/pools/pools
* https://github.com/DefiLlama/yield-server/tree/master/src/adaptors/fluxion-network
* https://github.com/DefiLlama/yield-server/tree/master/src/adaptors/nest-cl
