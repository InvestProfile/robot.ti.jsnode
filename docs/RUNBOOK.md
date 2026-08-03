# Runbook

Operational commands for local checks, server deploys, and incident inspection.

## Local Checks

```bash
npm test
npm run lint
```

Optional but API-heavy:

```bash
npm run blockers:buy -- 20
```

Avoid running API-heavy reports repeatedly during trading hours.

## Server Status

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no igorjan94.ru \
  'cd /home/mil/robot.ti.jsnode && docker-compose ps'
```

## Server Deploy

The server folder is not a git repo. Deploy from local `HEAD`:

```bash
ssh -o StrictHostKeyChecking=no igorjan94.ru 'cd /home/mil/robot.ti.jsnode && docker-compose exec -T robot rm -rf public/assets public/index.html' \
&& git archive HEAD | ssh -o StrictHostKeyChecking=no igorjan94.ru 'cd /home/mil/robot.ti.jsnode && tar -x -f - && docker-compose exec -T robot npm test && docker-compose up -d --force-recreate robot social_collector'
```

`--force-recreate` is required so changes to Compose environment variables,
including `NODE_EXTRA_CA_CERTS`, are applied to the running containers.

## Logs

General:

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no igorjan94.ru \
  'docker logs --since 10m robot_ti_jsnode 2>&1 | tail -200'
```

API/resource errors:

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no igorjan94.ru \
  'docker logs --since 10m robot_ti_jsnode 2>&1 | grep -Ei "RESOURCE_EXHAUSTED|INVALID_ARGUMENT|failed|error" || true'
```

Social collector:

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no igorjan94.ru \
  'docker logs --since 30m robot_ti_social_collector 2>&1 | tail -200'
```

## Safe Restart

```bash
ssh -o StrictHostKeyChecking=no igorjan94.ru \
  'cd /home/mil/robot.ti.jsnode && docker-compose restart robot social_collector'
```

## Before Live-Risk Changes

Run:

```bash
npm test
npm run lint
```

Then inspect:

- `/api/order-safety`
- `/api/trade-pnl`
- `/api/status`
- recent `trade_decisions`
- recent broker/order logs
