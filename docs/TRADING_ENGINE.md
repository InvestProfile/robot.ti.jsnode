# Trading Engine

This file explains how the robot currently decides to buy and sell.

## Buy Pipeline

Mental model:

```text
market universe -> daily candidates -> score -> gates -> risk/budget -> order execution -> accounting
```

Key files:

- `app/services/daily-buy-list.service.ts`
- `app/services/buy-signal-evaluator.service.ts`
- `app/services/buy-score-adjustment.service.ts`
- `app/services/pre-buy-risk.service.ts`
- `app/strategies/score-buy.strategy.ts`
- `app/services/risk-manager.service.ts`
- `app/services/trade-budget.service.ts`

Current buy guards:

- Market regime gate.
- Trading status must be normal.
- Daily order/budget caps.
- Available cash.
- Per-position concentration cap.
- Volatility-aware trade budget: when the adaptive stop for a candidate is wider than the base stop, the allowed order size is reduced so nominal risk stays closer to the configured budget.
- Add-on buy requires existing robot position to be profitable enough.
- Same-day add-on for the same ticker requires price confirmation above the latest robot buy; this is price-based, not a timer cooldown.
- Same-day re-entry after stop-loss is blocked.
- Weak add-on protection blocks adding to a losing robot-owned position.
- Loss guard raises the required buy score for tickers/sectors with recent stop-heavy negative round-trips; it is a score buffer, not a permanent ban.
- Loss guard also counts broker protective stop exits separately. A single large broker-stop loss or a small cluster of stop losses can require the configured score buffer even before the broader closed-trade sample is large.
- Negative technical adjustment requires a higher final score.
- Anti-FOMO blocks buys when price is close to the recent high and either same-day momentum is hot or the move is already too large versus the instrument's normal daily range.
- External analyst/social/technical data may adjust score, but stale positive analyst data should not make the robot more aggressive.
- Dashboard buy preview has a `Риск сделки` column with adaptive stop %, approximate RUB risk to stop, and risk-adjusted max order.

## Sell Pipeline

Mental model:

```text
portfolio position -> sell strategy signal -> risk check -> robot-owned lot policy -> order execution -> accounting
```

Key files:

- `app/services/sell-brain.service.ts`
- `app/services/sell-policy.service.ts`
- `app/strategies/strategy-engine.ts`
- `app/strategies/stop-loss.strategy.ts`
- `app/strategies/trailing-stop.strategy.ts`
- `app/strategies/hold-winner.strategy.ts`
- `app/strategies/profit-take.strategy.ts`
- `app/services/risk-manager.service.ts`

Strategy priority:

1. `stop-loss`
2. `hold-winner`
3. `trailing-stop`
4. `profit-take`

Notes:

- `trailing-stop` is evaluated early to update high-water marks, but it is returned after `stop-loss` and `hold-winner`.
- `stop-loss` is the emergency negative exit.
- Fresh robot-owned positions use a soft stop-loss grace window: the normal adaptive stop can hold briefly after entry, but a wider hard-stop still exits.
- `profit-take` uses `ROBOT_MIN_PROFIT_PERCENT`.
- `hold-winner` can prevent selling a winner too early.
- `sell-policy` only allows robot-owned lots to be sold.
- Non-emergency sells can be blocked when the latest robot action was a buy and the robot-owned position is not profitable enough.
- The dashboard sell page has an observe-only `Exit lab` column. It compares the current exit decision with a candidate stop policy `ATR x2 max10`; this is diagnostic only and does not change real sell orders.

## Research Reports

- `npm run exit:lab -- --net` summarizes real closed exits by signal source, holding time, sector, and ticker.
- `npm run stop:whatif -- 500 --net` compares stop-loss scenarios on real closed stop exits, including wider stops, soft grace, confirmation buffer, and trailing activation thresholds. Treat deferred rows as "would hold for live observation", not guaranteed saved profit.
- `npm run fomo:whatif -- 500 --net` checks whether anti-FOMO filters would have avoided bad entries.

## Important Env Values

- `ROBOT_MIN_PROFIT_PERCENT`
- `ROBOT_TRAILING_STOP_MIN_PROFIT_PERCENT`
- `ROBOT_SELL_HOLD_WINNER_MIN_PROFIT_PERCENT`
- `ROBOT_STOP_LOSS_PERCENT`
- `ROBOT_STOP_LOSS_MAX_PERCENT`
- `ROBOT_STOP_LOSS_GRACE_PERIOD_MS`
- `ROBOT_STOP_LOSS_GRACE_HARD_MULTIPLIER`
- `ROBOT_MAX_DAILY_ORDERS`
- `ROBOT_MAX_DAILY_RUB`
- `ROBOT_MAX_ORDER_RUB`
- `ROBOT_MAX_POSITION_SHARE_PERCENT`
- `ROBOT_BUY_ADD_ON_MIN_PROFIT_PERCENT`
- `ROBOT_BUY_ANTI_FOMO_ENABLED`
- `ROBOT_BUY_ANTI_FOMO_ENFORCED`
- `ROBOT_BUY_ANTI_FOMO_MAX_MOMENTUM_PERCENT`
- `ROBOT_BUY_ANTI_FOMO_MIN_BELOW_HIGH_PERCENT`
- `ROBOT_BUY_ANTI_FOMO_RANGE_DAYS`
- `ROBOT_BUY_ANTI_FOMO_MAX_RANGE_MULTIPLIER`
- `ROBOT_BUY_LOSS_GUARD_ENABLED`
- `ROBOT_BUY_LOSS_GUARD_ENFORCED`
- `ROBOT_BUY_LOSS_GUARD_SCORE_BUFFER`
- `ROBOT_BUY_LOSS_GUARD_MIN_CLOSED`
- `ROBOT_BUY_LOSS_GUARD_MIN_LOSSES`
