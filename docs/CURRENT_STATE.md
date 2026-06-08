# Current State

Last updated: 2026-06-08.

## Operating Mode

- The robot runs on the server in Docker.
- Trading account: `2054310628`.
- Long-term/IIS/savings accounts are observed/protected unless explicitly changed in runtime config.
- Live actions have included `buy` and `sell`.
- The dashboard is served on port `5757`.

## Recent Work

- Added API throttling/caching for technical analysis, analyst forecasts, order books, and buy preview reports.
- Added negative technical score buffer: if technical adjustment is negative, the buy score must clear a higher threshold.
- Added add-on buy protection: do not add to an existing robot-owned ticker unless the current robot position is already profitable enough.
- Added same-day stop-loss re-entry protection.
- Added net P/L support using broker report commissions where matched.
- Added protective stop handling for robot-owned positions.
- Added volatility-aware trade budget sizing: buy preview now exposes adaptive `riskStopPercent` and `maxRiskAdjustedOrderRub` so the UI can show per-trade risk instead of only order amount.
- Added structured protective stop rejection diagnostics: remembered broker/API failures include `kind`, `shortReason`, full `reason`, `failedAt`, and retry cooldown.

## Protective Stop Orders

`PostStopOrder` previously returned `INVALID_ARGUMENT: 30099` for some protective stop-loss orders.

Changes already made:

- Stop price is rounded down to the instrument `minPriceIncrement`.
- For market stop-loss, `price` is omitted and only `stopPrice` is sent.
- If broker rejects market stop-loss with `INVALID_ARGUMENT: 30099`, the robot retries once as stop-limit with a limit price below the stop trigger.
- Failed protective stop attempts are throttled for 30 minutes per account/instrument.
- Safe diagnostics are logged without secrets.
- Latest protective stop failure is exposed to `/api/protective-stops` and shown in the dashboard as a short reason such as `broker price limits`, with the full broker/API error in details.
- Sync skips stale protective stops when current price is already at or below the calculated stop.
- Sync now skips robot-ledger positions that are absent from the broker portfolio (`currentPrice` missing/zero), because stop orders against absent positions produced `30099`.

Current observation:

- Fresh real buys usually receive active protective stops; if the broker rejects one, the position is marked as `broker-rejected`/software fallback instead of silently looking covered.
- `INVALID_ARGUMENT: 30099` with text like `price is outside the limits for this instrument` is classified as `price-limits`; the robot cools down retries and blocks new buys for that account/instrument until a protective stop is accepted.
- There are still historical/ledger mismatches to audit separately: some old robot-owned ledger positions are no longer present in the broker portfolio.

## Recent Server Commands

Deploy:

```bash
ssh -o StrictHostKeyChecking=no igorjan94.ru 'cd /home/mil/robot.ti.jsnode && docker-compose exec -T robot rm -rf public/assets public/index.html' \
&& git archive HEAD | ssh -o StrictHostKeyChecking=no igorjan94.ru 'cd /home/mil/robot.ti.jsnode && tar -x -f - && docker-compose exec -T robot npm test && docker-compose restart robot social_collector'
```

Check logs:

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no igorjan94.ru \
  'docker logs --since 10m robot_ti_jsnode 2>&1 | grep -Ei "Protective stop|PostStopOrder|INVALID_ARGUMENT|RESOURCE_EXHAUSTED" || true'
```
