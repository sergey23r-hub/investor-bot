# xStocks / USDC monitor — 0.8.1

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
