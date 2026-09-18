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
  This check excludes commissions and must not be presented as net P/L.

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
