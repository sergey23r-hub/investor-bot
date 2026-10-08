# Personal CLMM comparison (0.8.6)

Personal recommendations compare the same saved USD capital, verified token contracts, network, and price bounds in USDC per stock. The pool-wide top-five ranking is an independent indicator, not a personal range estimate.

## Model: clmm-spot-v1

This is a **current-conditions scenario**, not a historical position backtest, earned APR, guaranteed forecast, or realized missed profit. It assumes current token price and active liquidity remain fixed while the observed average fee pace continues. USDC is valued at $1. The saved screenshot capital is a common comparison benchmark, not a reconstructed live balance.

For raw square-root prices `a < b`, current `s` clamped to `[a,b]`, raw token amounts per unit of liquidity are `1/s - 1/b` and `s - a`. Normalize by mint decimals, value both tokens at the current pool price, and divide capital by the resulting value to obtain position liquidity `L`.

Active status is `tickLower <= tickCurrent < tickUpper`, not displayed-price comparison: on a downward crossing tickCurrent may be immediately below the tick at sqrtPrice. Exact boundary semantics also apply when quotation is inverted.

Current-position share is `L / activeLiquidity` because existing liquidity is already included. A proposed new position uses `L / (activeLiquidity + L)`. Estimates above a 10% share are unsupported by this small-position model.

Daily fees = rolling gross 24-hour fees × LP fee fraction × active share. Annual indicator = daily fees / capital × 365 × 100. Scenario difference over 30 days = nonnegative difference in daily fees × 30. Known migration costs are deducted separately; unknown costs are never silently set to zero. A second scenario uses average 7-day fees with the **same current state**, not a historical replay.

No rewards, token price appreciation/loss, impermanent loss, bridges, gas or unspecified slippage are included. Repeated equal-range suggestions require two distinct fresh hourly source observations and increasing chain slots; existing entitlement and rate-limit guards remain in force.

## Bounds and exclusions

Canonical bounds are USDC per stock token. Extractor converts explicitly inverse quotations, otherwise leaves unknown bounds empty. Legacy saved bounds retain this convention and are shown for review. `/poolfix 1 минимум=150 максимум=180` corrects bounds through the existing confirmation flow.

Nearest allowed ticks are used. Effective bounds are displayed if changed. Reject deviations over the smaller of 1% of a bound or 5% of requested width, and rounding that changes range activity. Pools must use exactly the same mints and network; prices must agree within 0.5%. Chain and fee observations across venues must be within 10 minutes. Chain snapshots expire after 2 hours; pool fee observations retain the existing 4-hour freshness checks.

Missing bounds, capital, verified states, fees, alternatives, or unsupported venues never fall back to pool-wide APR. An out-of-range current position yields no positive personal opportunity. A lack of alternatives is distinct from evidence that moving is not worthwhile.

## Shared data acquisition

Raydium CLMM and Orca Whirlpool on Solana are supported. Read-only `getMultipleAccounts` requests to the public Solana mainnet RPC obtain program-owned pool states, configs and mint decimals. Owner, Anchor discriminator, pair identities, config tick spacing, initialized mint and extension type are validated. Raydium LP share excludes protocol/fund fees; Orca excludes protocol fees. Raydium paused deposit/withdrawal/fee-collection/swap states are excluded. Unsupported mint extensions and other pool models remain unavailable.

A dependency-discovery read is followed by an atomic pool/config/mint read at a confirmed slot. At most 96 pools per asset, split into batches of 32, are enriched per scheduled job. Successes and failures are shared per asset/hour through pr_lp_fetches. No per-user request, wallet connection, signing or trading is introduced. Schema-v1 cached markets are enriched one asset per scheduled job without updating old fee timestamps or issuing opportunity alerts from that enrichment alone.

External API/RPC errors produce an explicit unavailable state and hourly retry through the normal scheduler. They do not bypass provider restrictions or fabricate fresh observations. No schema or billing changes are required.

## Primary layout references

- https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/states/pool.rs
- https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/states/config.rs
- https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/state/whirlpool.rs
- https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
- https://solana.com/docs/rpc/http/getmultipleaccounts

Tests cover independently calculated dollar flows, token order and unequal decimals, exact tick boundaries, missing/stale states, rounding, paused operations, malformed accounts, fee shares, caching, rollout, cost decisions, UI length and paid delivery guards.
