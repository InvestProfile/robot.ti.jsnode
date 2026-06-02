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
- Uses the same adaptive stop-loss percent as `StopLossStrategy`: base `ROBOT_STOP_LOSS_PERCENT`, widened by average daily range, capped by `ROBOT_STOP_LOSS_MAX_PERCENT`.
- Skips stale stop creation when current price is already at/below calculated stop.
- Cools down failed attempts for 30 minutes per account/instrument.
- Logs diagnostics without secrets when stop placement fails.
- Dashboard marks uncovered robot positions as `broker rejected` when the latest protective stop attempt was rejected by the broker/API.

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
