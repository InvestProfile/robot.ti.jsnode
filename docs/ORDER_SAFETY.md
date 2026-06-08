# Order Safety And Accounting

This file is for tasks that touch real-money order placement, order states, broker reconciliation, or P/L.

## Money Boundary

Treat these as high-risk files:

- `app/services/orders.service.ts`
- `app/services/protective-stop.service.ts`
- `app/modules/common.module.ts`
- `app/services/trades.service.ts`
- `app/services/trade-pnl.service.ts`
- `app/services/robot-position-ledger.service.ts`
- `app/utils/order-status.ts`

## Rules

- Never retry an unknown order automatically.
- Preserve `clientOrderId`/`orderId`.
- Rejected/unknown/pending local statuses must not inflate robot-owned lots or daily accounting.
- Sell logic must only sell robot-owned lots.
- If a broker call fails after possible submission, mark unknown/pending-reconcile rather than pretending it failed before submit.
- Protective stops are useful but must not spam broker APIs on repeated `INVALID_ARGUMENT`.

## Current Status Handling

Shared helpers live in `app/utils/order-status.ts`.

Accounting ignores:

- local pending submit;
- local submit unknown;
- local post rejected;
- broker rejected/cancelled/new states where appropriate.

Accounting includes:

- filled/executed orders;
- confirmed broker orders eligible for P/L matching.

## Protective Stops

Current implementation:

- Uses `StopOrdersService.PostStopOrder`.
- Rounds sell stop price down to `minPriceIncrement`.
- Uses market stop-loss request shape: `stopPrice` set, `price` omitted.
- If market stop-loss is rejected with `INVALID_ARGUMENT: 30099`, retries once as stop-limit with a limit price below `stopPrice`.
- Uses the same adaptive stop-loss percent as `StopLossStrategy`: base `ROBOT_STOP_LOSS_PERCENT`, widened by average daily range, capped by `ROBOT_STOP_LOSS_MAX_PERCENT`.
- Skips stale stop creation when current price is already at/below calculated stop.
- Cools down failed attempts for 30 minutes per account/instrument.
- Logs diagnostics without secrets when stop placement fails.
- Remembers the latest failed attempt in process memory with:
  - `kind`: `price-limits`, `stop-order-rejected`, `invalid-argument`, `fallback-rejected`, `broker-api`, or `unknown`;
  - `shortReason`: compact dashboard label;
  - full broker/API `reason`;
  - `failedAt` and retry cooldown.
- Dashboard marks uncovered robot positions as `broker rejected` when the latest protective stop attempt was rejected by the broker/API, counts active stop-limit fallbacks separately, and shows `software` fallback coverage when live sell is enabled.
- Software fallback means the normal sell loop still evaluates `StopLossStrategy` and submits a sell through the regular order/accounting path. It is not as strong as broker-side protection because it depends on the robot process being alive.
- New buys are blocked while the current process remembers a broker protective stop rejection for the same account/instrument.

Interpretation:

- `price-limits` usually means the broker rejected the stop/limit price as outside the current exchange limits for that instrument. Do not keep blindly retrying the same request; inspect the position and let the next sync recalculate after the market moves.
- `stop-order-rejected` means the market stop-loss attempt and both fallback variants were rejected with `INVALID_ARGUMENT: 30099`; treat this as broker/instrument rejection until proven otherwise.
- `fallback-rejected` means both the market stop-loss attempt and stop-limit fallback failed for another reason.
- A `broker-rejected` uncovered position is not unmonitored: the software sell loop can still exit it when live sell is enabled, but broker-side protection is missing.
- `/api/protective-stops` also exposes `nearSoftwareStop` and `losingUncovered` so the dashboard can highlight broker-rejected positions that are already close to the software stop. This is monitoring only; it does not cancel or widen stops.

Useful log query:

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no igorjan94.ru \
  'docker logs --since 10m robot_ti_jsnode 2>&1 | grep -Ei "Protective stop|PostStopOrder|INVALID_ARGUMENT|RESOURCE_EXHAUSTED" || true'
```

## P/L

P/L is based on matched robot trades and, where available, broker report commissions.

Important:

- Gross P/L is before commissions.
- Net P/L subtracts matched commissions.
- If broker report matching is incomplete, net P/L can still be optimistic.
