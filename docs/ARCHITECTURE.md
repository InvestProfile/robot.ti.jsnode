# T-Invest Robot Architecture

Backlinks: [[START_HERE]], [[TRADING_ENGINE]], [[ORDER_SAFETY]], [[RUNBOOK]]

This document is a quick map for future changes. It describes where to look first and how the main trading flow is wired.

## Runtime

- `app/index.ts` starts the application: database, HTTP dashboard, and the trading process.
- `app/modules/common.module.ts` owns the main tick loop and coordinates snapshots, buy checks, sell checks, paper trading, social/market enrichment, and error handling.
- `app/config/env.config.ts` reads environment values and production safety defaults.
- `app/config/robot.config.ts` builds the typed robot config used by services.
- `app/services/runtime-config.service.ts` stores runtime overrides from the dashboard and clamps them to hard caps.

## HTTP And UI

- `app/http/readonly-server.ts` exposes dashboard APIs and admin endpoints protected by auth.
- `ui/src/main.jsx` is the React dashboard shell and pages.
- `ui/src/styles.css` contains the dashboard design system and table layout rules.
- `public/` contains the built frontend served by the Node HTTP server.

## Buy Pipeline

The intended mental model is:

```text
market universe -> daily buy list -> score analysis -> market gate -> risk limits -> order service -> trades ledger
```

- `app/services/daily-buy-list.service.ts` scans the available market and prepares the daily candidate list.
- `app/services/buy-signal-evaluator.service.ts` enriches candidates with social, analyst, technical, and market data.
- `app/strategies/strategy-engine.ts` runs strategy evaluation.
- `app/strategies/score-buy.strategy.ts` calculates the current rule-based buy score.
- `app/services/risk-manager.service.ts` blocks orders that violate cash, daily limits, trading status, or runtime safety.
- `app/services/orders.service.ts` is the final gateway to broker order placement.

## Sell Pipeline

The intended mental model is:

```text
portfolio position -> sell strategy signal -> robot-owned lot policy -> live sell switch -> order service -> trades ledger
```

- Sell candidates are built from portfolio positions and strategy signals inside the main runtime services.
- The sell policy must only sell lots confirmed as bought by the robot.
- `trailing-stop` is a profit/breakeven guard: it only sells after the drawdown from the observed high is large enough and the current position profit is at or above `ROBOT_TRAILING_STOP_MIN_PROFIT_PERCENT`.
- Negative exits should normally come from `stop-loss`, not from `trailing-stop`.
- `app/services/orders.service.ts` submits sell orders only after final validation.
- The `trades` table is the source of truth for robot-owned lots and order status reconciliation.

## Social Collector

- Social collection is intentionally separate from trade execution.
- The collector reads selected Pulse profiles and writes social signals to the database.
- `/api/social-cookies` receives browser cookies from the Chrome extension and requires both Basic Auth and the cookie update secret.
- Social data is an input to scoring; it must not place orders directly.

## Order Safety

- `orders.service.ts` should be treated as the money boundary.
- Unknown order states must not be retried automatically.
- `clientOrderId` should be preserved so reconciliation can identify whether an order reached the broker.
- Dashboard order safety blocks summarize open, pending, unknown, partial, rejected, and filled records.

## Evidence And Lab

- `app/services/strategy-evidence.service.ts` summarizes strategy history and paper/live outcomes.
- The dashboard Lab page shows market scenarios, 24h buy candidates, analyst forecasts, technical indicators, strategy evidence, and social evidence.
- Evidence is diagnostic. It should not silently change trading behavior.

## Deployment

- `docker-compose.yml` runs the robot and related services.
- `.env` contains secrets and runtime environment values. Do not commit it.
- The production container uses mounted project files, so TypeScript/frontend changes need a rebuild and service restart or process reload.

## Where To Look

| Question | Start Here |
| --- | --- |
| Why did the robot buy? | `trade_decisions`, `/api/decisions`, `buy-signal-evaluator.service.ts` |
| Why was a buy blocked? | `/api/preview`, `risk-manager.service.ts`, market gate output |
| Why did the robot sell? | `/api/sell-brain`, `trade_decisions`, `trades`, sell policy code |
| Did an order reach the broker? | `trades`, `clientOrderId`, `/api/order-safety` |
| Why is the dashboard slow? | `readonly-server.ts` endpoint query limits and `ui/src/main.jsx` page endpoint groups |
| Where are runtime limits changed? | `runtime-config.service.ts`, `readonly-server.ts`, Accounts page |
| Where are secrets loaded? | `env.config.ts`, `.env`, Docker env file |
