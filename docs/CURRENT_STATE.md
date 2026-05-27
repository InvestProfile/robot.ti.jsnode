# Current State

Last updated: 2026-05-28.

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

## Open Issue: Protective Stop Orders

`PostStopOrder` returned `INVALID_ARGUMENT: 30099` for protective stop-loss orders.

Changes already made:

- Stop price is rounded down to the instrument `minPriceIncrement`.
- For market stop-loss, `price` is omitted and only `stopPrice` is sent.
- Failed protective stop attempts are throttled for 30 minutes per account/instrument.
- Safe diagnostics are logged without secrets.
- Sync skips stale protective stops when current price is already at or below the calculated stop.

Next observation:

- Wait for the next real new buy.
- Check logs for `Protective stop checked`.
- If it appears without `Protective stop placement failed`, the latest fix worked.
- If `30099` returns, inspect the logged diagnostics and verify whether the instrument supports stop orders or whether account/trading status blocks stop placement.

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

