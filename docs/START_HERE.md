# T-Invest Robot Knowledge Base

This is the entry point for humans, Codex threads, and Obsidian.

If a new AI thread needs to work on this project, start by reading only this file, then open the linked file that matches the task. Do not load the whole repository first.

## Current Project Shape

- The robot is a Node.js/TypeScript T-Invest trading system with a React dashboard.
- Main branch for active work: `test`.
- Production server path: `/home/mil/robot.ti.jsnode`.
- Local workspace path: `/Users/mil/Projects/my/tinkoff/robot.ti.jsnode`.
- The server directory is not a git repository; deploy with `git archive HEAD | ssh ... tar -x`.
- Secrets live in `.env`; never commit tokens, passwords, cookies, or PSID values.

## Read This First

| Task | Read |
| --- | --- |
| Understand architecture | [[ARCHITECTURE]] |
| Change buy/sell logic | [[TRADING_ENGINE]] |
| Change order safety/accounting | [[ORDER_SAFETY]] |
| Deploy/restart/check server | [[RUNBOOK]] |
| Continue recent work | [[CURRENT_STATE]] |
| Work with docs/Obsidian | [[KNOWLEDGE_BASE]] |

## High-Signal File Map

| Area | Files |
| --- | --- |
| App startup/runtime loop | `app/index.ts`, `app/modules/common.module.ts` |
| Config/env/runtime overrides | `app/config/env.config.ts`, `app/config/robot.config.ts`, `app/services/runtime-config.service.ts` |
| HTTP dashboard API | `app/http/readonly-server.ts` |
| Dashboard UI | `ui/src/main.jsx`, `ui/src/styles.css` |
| Buy pipeline | `app/services/buy-signal-evaluator.service.ts`, `app/services/daily-buy-list.service.ts`, `app/strategies/score-buy.strategy.ts` |
| Sell pipeline | `app/services/sell-brain.service.ts`, `app/services/sell-policy.service.ts`, `app/strategies/strategy-engine.ts` |
| Broker orders | `app/services/orders.service.ts`, `app/services/protective-stop.service.ts` |
| Accounting/P&L | `app/services/trade-pnl.service.ts`, `app/services/trades.service.ts`, `app/services/robot-position-ledger.service.ts` |
| Social/Pulse | `app/services/social-collector.service.ts`, `app/services/social-profile-score.service.ts`, `app/services/social-consensus.service.ts` |

## New Chat Bootstrap Prompt

Use this prompt when starting a fresh Codex chat:

```text
We are working on /Users/mil/Projects/my/tinkoff/robot.ti.jsnode, branch test.
First read docs/START_HERE.md, then only the linked docs/files relevant to the task.
Do not load the whole project into context unless necessary.
Preserve secrets. Do not print .env tokens/cookies.
Use npm test and npm run lint before deploy when code changes.
Server deploy is by git archive to /home/mil/robot.ti.jsnode, because the server folder is not a git repo.
```

## Working Rules

- Prefer small, safe changes.
- Do not change trading thresholds or scoring casually; inspect evidence first.
- Money boundary is `OrdersService` plus risk/budget/sell-policy checks.
- Unknown broker order states must not be retried automatically.
- Dashboard and reports should use caches and avoid burning T-Invest API limits.
- Push commits to `origin test` after successful checks.

