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
- Add-on buy requires existing robot position to be profitable enough.
- Same-day re-entry after stop-loss is blocked.
- Weak add-on protection blocks adding to a losing robot-owned position.
- Negative technical adjustment requires a higher final score.
- Anti-FOMO blocks buys when the current daily momentum is already hot and the price is too close to the recent high.
- External analyst/social/technical data may adjust score, but stale positive analyst data should not make the robot more aggressive.

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
