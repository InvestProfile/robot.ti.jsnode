# Historical accounting reconciliation — 2026-09-18

Scope: verify historical accounting after the order-safety review, repair only
broker-supported fields, and preserve the effective sell-only trading policy.

## Evidence and repair

- Snapshotted all 843 trade rows before changing data.
- Verified 513 executions: 510 by account/order ID against broker operations,
  two by broker order state plus the May 19–20 broker report, and one legacy
  SBER record by unique account/instrument/side/quantity/price/time matching
  corroborated by the May 5 broker report.
- No falsely rejected filled order was found among the 329 local rejections.
- Corrected 288 existing rows in one serializable transaction: 287 instrument
  lot sizes, 37 per-security execution prices (overlapping those rows), and the
  legacy record's missing order/execution metadata. No new trade rows were added.
- The 287 lot repairs cover 160 filled, 126 rejected, and one cancelled row.
  Rejected/cancelled statuses and their zero execution quantities were preserved.
- Each changed row was locked and compared to its complete pre-repair snapshot.
  Verification checked every persisted field, all 555 untouched rows, and the
  unchanged total row count. No remaining instrument lot mismatch was found.
- `instrumentUid` is not a persisted Sequelize attribute in the existing trades
  model. The legacy record uses the persisted `instrumentId` and existing `uid`;
  the final verified repair plan reflects that schema.
- Broker portfolio and robot ledger both have no open securities; the broker's
  only portfolio position is currency. No ledger ghosts or quantity mismatches.
- Full-window gross P/L for the currently configured trading account remains
  -1322.02 RUB, 228 closed matches, zero unmatched sells and zero open lots.
  This ledger check excludes commissions and must not be presented as net P/L.
- Independent broker cash reconciliation of 511 executed BUY/SELL operations
  confirms the same gross result. Operation commissions total 125.48 RUB;
  the broker report supplies two omitted commissions of 0.09 RUB each.
  Complete trading commissions are 125.66 RUB and verified net trade result
  is -1447.68 RUB. This is trade P/L, not the cash balance or total account return.

## Root cause and regression coverage

`GetOrderState.executedOrderPrice` is an aggregate value, whereas the local
`executedPrice*` columns expect a per-security price. Use the positive
`averagePositionPrice` from order state, retaining the stored price when no
positive average is available. Do not change `PostOrder` response semantics.
This is confirmed by live order-state/operation comparison and the
[T-Bank Orders API documentation](https://developer.tbank.ru/invest/services/orders/methods).

Two new regressions cover multi-share/multi-lot execution and a missing/zero
average price. Local full validation: 384 tests, TypeScript/UI builds and lint.

## Protected evidence

Host: Hyperion, accessed through the project-specific `hyperion-trading` alias.
Directory: `/home/mil/robot-audits/20260918`, owner-only access.

- `trades-before.json`: complete original trade snapshot.
- `repair-plan.json`: broker-supported field changes and original rows.
- `trades-after.json`: verified post-repair snapshot.
- `verification.json`: field/count checks, ledger audit and gross P/L.
- Broker operations, instrument metadata, order states and broker reports are
  retained alongside the snapshots. No credentials were copied into this repo.

Rollback of accounting must use the original rows, an explicit reviewed plan,
row locks and comparison with the post-repair snapshot; do not blindly replace
newer runtime data. Runtime settings were not changed by this repair.

## Production release

- The running pre-repair sources were hash-verified against `d2cbd7d`.
- Deployed `/home/mil/releases/robot-ti-safety-42f5457`: that production base
  plus only the three safety source files, two regression-test files and
  safety/audit documentation from `42f5457`. `RELEASE.json` records exact
  base/overlay commits and file hashes. This is not a full-HEAD deployment.
- The exact assembled release passed 282 tests, TypeScript/UI builds and lint
  on Hyperion in an isolated container with dummy DB settings and no production
  credentials. Local latest-branch validation passed 384 tests.
- Only `robot_ti_jsnode` was recreated, with the new release mounted read-only;
  the social collector was left running.
- Before deployment, the old runtime circuit breaker was open after five
  historical tick errors despite a current consecutive-error count of zero.
  Since restarting clears that in-memory block, the new Compose file explicitly
  sets `ROBOT_TRADING_PAUSED=true` while preserving sell-only actions and the
  existing shadow-outbox configuration. This prevents inadvertent trading
  reactivation; clearing the pause is a separate trading-policy decision.
- After restart, the entire trades table matched the post-repair snapshot's
  SHA-256 exactly: 843 rows and no new/changed trades caused by deployment.
- Authenticated health/status/order-safety checks passed. The first post-restart
  cycle finished at 2026-09-18 21:10:53 UTC with zero consecutive errors; broker
  sell sync found zero candidates and imported zero trades. Open, pending,
  unknown, partial and stale-limit counters were all zero.
- Active deployment/rollback procedures are in [[RUNBOOK]].

Private Mac inventory follow-up: Hyperion SSH authentication through
`hyperion-trading` is verified; update the active release/Compose paths,
read-only source mount and preserved trading pause. `System-Admin/CHAT-AGENTS.md`
contains only a last-known Mac inventory route; its current task title/ID could
not be live-verified in this session. No credentials were changed or disclosed.
