# T-Invest Paper/Margin Lab

## Purpose

Paper/Margin Lab is a safe environment for evaluating the robot's existing
strategy with virtual money before any live-risk expansion. It must answer two
separate questions:

1. Does the strategy produce positive results after realistic costs?
2. How do cash-only and bounded-margin portfolios behave on the same decisions?

The lab belongs in this repository so that live-shadow and virtual runs can use
the same market inputs, strategy code, gates, sizing rules, and decision trace.
It is a separate bounded context: it owns virtual accounts, execution, fills,
ledger, positions, margin accounting, and experiment reporting, but it never
owns broker execution.

T-Invest Sandbox may later be added as an API-integration adapter. It is not the
source of truth for virtual cash, margin, interest, liquidation, or performance.

## Bounded Context

The intended boundary is:

```text
market snapshot
    -> shared decision engine
    -> immutable decision plan and trace
        -> live execution adapter -> broker order gateway
        -> virtual execution adapter -> fill model -> virtual ledger
                                               -> positions and margin state
```

Shared code may provide market data, instrument metadata, strategy evaluation,
risk policies, and immutable decision plans. The lab may consume these shared
contracts, but it must not import the live broker gateway.

Future lab implementation lives under:

- `app/paper/` for paper orchestration and compatibility during migration;
- `app/virtual/` for virtual accounts, execution, ledger, fills, and margin;
- shared decision contracts outside those namespaces.

The existing `PaperTradingService` and `paper_positions` table remain legacy
behavior during migration. PM-00 does not change them. Characterization of that
legacy behavior is a separate PM-00B slice.

## Hard Safety Rules

1. Code under `app/paper/` and `app/virtual/` must never import
   `OrdersService`, `get-sdk`, `ProtectiveStopService`, or the T-Invest SDK.
2. Only a live execution adapter outside the lab boundary may call the broker
   order gateway.
3. Every virtual account, order, fill, position, and ledger entry must carry an
   explicit virtual account identity. A broker account id is not a virtual
   account id.
4. Paper mode must be safe without a broker trading token. Missing lab state
   must fail closed; it must never fall back to live execution.
5. Virtual and live records must use separate tables and status vocabularies.
6. A virtual fill is applied atomically and idempotently to order, cash ledger,
   position, P/L, and margin state.
7. Experiment configuration and strategy version are immutable for a run.
8. Comparable runs consume the same timestamped market snapshot. Results based
   on different snapshots must not be presented as direct strategy parity.
9. Commission, spread, slippage, interest, rejected orders, and partial fills
   are explicit inputs. Optimistic zero-cost defaults are not permitted for
   readiness decisions.
10. Margin violations switch a virtual account to reduce-only before any
    liquidation simulation. Margin support starts long-only; short selling
    requires a separate safety decision.
11. No paper result can automatically enable live actions, change live limits,
    or promote a strategy. Promotion requires evidence review and an explicit
    owner decision.
12. Production deployment and live configuration remain separate operations
    with the normal test, review, and runbook controls.

The architecture-boundary test uses the TypeScript compiler API. It treats every
source file under `app/paper/` and `app/virtual/` as a root, recursively follows
resolved local imports under `app/`, and fails with the complete import chain if
any reachable module imports a forbidden gateway. Static imports, re-exports,
TypeScript import-equals declarations, `require()` and dynamic `import()` are
parsed from the AST. Computed `require()` or `import()` calls anywhere in the
reachable graph fail closed because their target cannot be proven safe.

Both namespaces contain checked marker modules. The test asserts those roots so
a missing, renamed, or incorrectly resolved namespace cannot pass vacuously. It
also validates the repository root and fails when invoked from an unexpected
working directory.

## Target Contracts

The shared decision layer should eventually expose contracts equivalent to:

- `TradingAccountSnapshot`: cash, equity, positions, daily activity, realized
  P/L and available buying power;
- `DecisionPlan`: side, instrument, size, reference price, signal source,
  reasons, factors, configuration identity and market-snapshot identity;
- `ExecutionAdapter`: submits a decision plan to either live or virtual
  execution without changing the decision;
- `FillModel`: turns a virtual order and market snapshot into deterministic,
  auditable fills;
- `MarginPolicy`: calculates requirements, buying power, reduce-only state and
  a deterministic liquidation plan.

Live and virtual account providers may differ, but identical normalized account
and market snapshots must produce identical decision plans.

## Target Data Model

The target lab storage is separate from the legacy `paper_positions` table:

- `virtual_accounts` for starting cash, current cash, experiment identity,
  strategy/config snapshot and margin policy;
- `virtual_positions` for signed lots, average cost, marks and unrealized P/L;
- `virtual_orders` for requested and filled quantities and order state;
- `virtual_fills` for price, commission, spread/slippage and execution model;
- `virtual_ledger_entries` for deposits, trades, fees, borrowing, repayment,
  interest and liquidation;
- `virtual_margin_snapshots` for equity, exposure, requirements, leverage and
  distance to margin call;
- `decision_runs` and `decision_plans` for reproducibility and live-shadow
  parity analysis.

Schema changes must use versioned, idempotent migrations. The legacy paper rows
are evidence only and must not be silently converted into ledger-backed results.

## Delivery Stages

### PM-00: boundary enforcement

- record the architecture and safety rules;
- enforce the lab-to-live import boundary;
- create and assert non-vacuous paper and virtual namespace roots.

### PM-00B: legacy characterization

- capture the current `PaperTradingService` behavior in characterization tests;
- document its known differences from the future shared decision pipeline;
- preserve that baseline until the replacement is proven and migration is
  approved.

### PM-01: virtual cash account

- create a virtual account with starting cash;
- implement immutable ledger entries and portfolio valuation;
- prove cash/equity invariants without trading.

### PM-02: shared buy decision plan

- extract a normalized account provider and decision-plan builder;
- run live-shadow and virtual evaluation on identical market snapshots;
- add parity tests for signal, gates, sizing, and reasons.

### PM-03: long-only cash execution

- add virtual orders, deterministic fills, commission and slippage;
- update ledger and positions transactionally and idempotently;
- reject purchases that exceed available cash.

### PM-04: shared sell decision plan

- reuse the live strategy and risk pipeline for virtual positions;
- remove the second independent set of paper exit rules;
- preserve complete decision and execution traces.

### PM-05: parallel experiments

- run independent `1.0x`, `1.2x`, and `1.5x` virtual accounts;
- feed them the same snapshots and strategy decisions;
- report divergence instead of hiding it.

### PM-06: long-only margin accounting

- model borrowing, interest, initial and maintenance margin;
- implement reduce-only and deterministic virtual liquidation;
- validate accounting and margin invariants under adverse scenarios.

### PM-07: dashboard and readiness evidence

- expose equity curve, drawdown, realized/unrealized P/L, costs, leverage,
  margin utilization, decisions and divergence;
- compare experiments and a declared benchmark;
- require a documented evidence window before considering live expansion.

### PM-08: optional T-Invest Sandbox adapter

- verify broker API order lifecycle separately from internal economics;
- keep sandbox limitations visible in reports;
- never substitute sandbox balances for the lab ledger or margin model.

## PM-00 Exit Criteria

- this design is present in the repository;
- the architecture-boundary test is part of the default unit test command;
- the test recursively fails with a full chain on direct or transitive imports
  of a forbidden live gateway from either lab namespace;
- computed `require()` and dynamic `import()` calls in the reachable graph fail;
- real marker roots for both namespaces are present and asserted;
- legacy paper runtime behavior and production state are unchanged.

## Qualified Evidence Runtime

The independent market-mark collector has a dedicated CLI:

```sh
npm run marks:collector
```

It is disabled unless `ROBOT_MARK_COLLECTOR_ENABLED=true`. The process accepts
only `TINVEST_READONLY_TOKEN`; it never falls back to `INVEST_TOKEN`. Its
broker endpoint is fixed to `invest-public-api.tbank.ru:443`, and the SDK is
wrapped to expose only trading-status reads, depth-one order-book reads, and
disconnect.

Required non-secret runtime settings:

- `ROBOT_MARK_COLLECTOR_LEASE_NAME`;
- bounded interval, lease TTL, batch, attempts, and backoff settings documented
  by `market-mark-collector.worker.ts`;
- the isolated PostgreSQL connection variables already used by the observation
  worker.

Startup authenticates PostgreSQL, verifies all migration records, verifies the
physical collector tables/columns, and only then constructs the read-only SDK.
Collection and shutdown are fenced, bounded, and fail closed.

Do not put a token into Git, this document, a shared `.env`, Compose YAML, or
the live robot environment. Production activation requires a Hyperion-local
model-blind credential profile dedicated to this process. Until that profile is
installed and independently verified, the qualified 14-day evidence window has
not started.
