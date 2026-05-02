# robot.ti.jsnode

TypeScript robot for T-Invest.

## Current Mode

The runtime is intentionally conservative:

- trades only accounts listed in `ROBOT_ACCOUNT_IDS`;
- observes accounts listed in `ROBOT_OBSERVE_ACCOUNT_IDS`;
- refuses to trade accounts listed in `ROBOT_PROTECTED_ACCOUNT_IDS`;
- starts in `ROBOT_DRY_RUN=true` by default;
- requires an explicit live confirmation phrase before real-money trading can start;
- writes every decision into the `trade_decisions` table;
- writes executed orders into the `trades` table.

## Local Run

```bash
npm run build
npm run start
```

For the long-running robot process:

```bash
npm run robot
```

To inspect recent decisions:

```bash
npm run decisions
npm run decisions -- 50
```

## Required Environment

Keep these values in `.env`; the file is ignored by git.

```env
INVEST_TOKEN=
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_DIALECT=postgres
DB_PORT=3579

ROBOT_ACCOUNT_IDS=2054310628
ROBOT_OBSERVE_ACCOUNT_IDS=2002465405,2006532697,2201800992
ROBOT_ACCOUNT_ALIASES=2054310628:торговый счет,2002465405:долгосрочный счет,2006532697:ИИС,2201800992:Инвесткопилка
ROBOT_PROTECTED_ACCOUNT_IDS=2002465405,2006532697,2091363693,2045881687,2051251635,2201800992,2011287614
ROBOT_DRY_RUN=true
ROBOT_INTERVAL_MS=60000
ROBOT_POSITION_DELAY_MS=1000
ROBOT_MIN_PROFIT_PERCENT=0.5
ROBOT_MAX_LOTS_PER_ORDER=1
ROBOT_LIVE_CONFIRMATION=
```

## Live Trading

Live trading requires both:

```env
ROBOT_DRY_RUN=false
ROBOT_LIVE_CONFIRMATION=I_UNDERSTAND_THIS_TRADES_REAL_MONEY
```

Do not enable live mode until dry-run decisions in `trade_decisions` look correct.

`ROBOT_OBSERVE_ACCOUNT_IDS` is read-only from the robot's point of view. The
robot may write analysis into `trade_decisions`, but order execution is only
allowed for `ROBOT_ACCOUNT_IDS`, and only after live mode is explicitly enabled.
