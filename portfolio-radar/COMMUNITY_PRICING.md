# Community subscription pricing

Members of Strategy Romanova (`-1002230180865`) or Take Profit (`-1002094215821`) pay 145 RUB per seven days. Other customers pay 290 RUB. Membership of both does not stack discounts.

Portfolius signs a short-lived, purpose-bound `CommunityMembership` request using its existing Ed25519 key in Vault. MIC verifies only the public key and queries Telegram using its own bot credentials. MIC must be an administrator in both chats. The result carries no member lists or message contents. A failure to check either community cannot become a false non-member result; a positive result from either is sufficient.

Initial checkout requires consent to the displayed price and the 145/290 RUB membership rule. Stale callbacks display fresh conditions. Membership is checked again before preparing a bank order and before each recurring charge. Unknown membership postpones the operation without submitting a charge. When eligibility changes after the bank has fixed an order amount, that automatic renewal is stopped and the user must reconnect, preventing an unexpected amount change.

Bank initialization, reconciliation and charge validation use the exact stored order amount. The gateway permits only 14500 or 29000 kopecks under the isolated Portfolius signature/order namespace. Existing Yield Radar payment routes are untouched. Amount-dependent refunds, access and referrals use the actual order value, including full refunds of discounted weeks.

The feature is gated by `pr_billing_settings.community_pricing_enabled`. Deploy `db/community-pricing.sql`, the MIC endpoint, the isolated gateway, and this Edge Function before enabling it. Disabling the flag is for a coordinated rollback only: do not use it while discounted renewals are pending without reviewing those orders.

Verification: 191 JavaScript tests, 14 MIC Python tests, existing five data isolation tests; rollback-only SQL assertions in `tests/community-transactions.sql` cover both prices, no stacking, access, duplicate confirmations/charges, stale membership, full refunds, referrals and service-role permissions. Live membership audit for owner 85572233 confirmed both communities; production gateway Status confirmed both prices. No live Init or Charge was called during verification.

Operator diagnostic: authenticated POST `community-audit` with `user_id`; uses the existing worker-secret authentication. It only reads Telegram and does not create orders or send messages. `billing-probe` reads gateway capability status.
