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

To estimate or apply a safe cleanup of noisy `dry-run` / `skip` decisions:

```bash
npm run cleanup:decisions -- 24
CLEANUP_APPLY=true npm run cleanup:decisions -- 24
```

To check readiness before running live:

```bash
npm run preflight
```

## Server Run

The server currently runs Docker with project folders mounted into Node
containers. Keep production secrets in `.env` on the server; do not put tokens
into `docker-compose.yml`.

First install dependencies and build inside the same Linux container volume:

```bash
docker-compose run --rm robot npm ci
docker-compose run --rm robot npm run build
```

Then start or restart the long-running robot:

```bash
docker-compose up -d
docker logs -f robot_ti_jsnode
```

The read-only dashboard is served by the same process. The default compose file
publishes it on `5757:3000`; protect it with:

```env
ROBOT_WEB_USERNAME=robot
ROBOT_WEB_PASSWORD=
```

The dashboard and API are read-only. They do not expose endpoints for posting
orders, enabling live mode, or stopping the robot.

Useful checks:

```bash
docker-compose run --rm robot npm run preflight
docker-compose run --rm robot npm run decisions -- 50
```

The compose file does not publish a port because the robot is a background
trading process, not a web server.

## Required Environment

Keep these values in `.env`; the file is ignored by git. Use `.env.example` as
a non-secret template.

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
ROBOT_LIVE_ALLOWED_ACTIONS=buy
ROBOT_INTERVAL_MS=60000
ROBOT_POSITION_DELAY_MS=1000
ROBOT_ENABLED_STRATEGIES=stop-loss,trailing-stop,profit-take
ROBOT_BUY_TICKERS=SBER,T,YDEX
ROBOT_MAX_ORDER_RUB=1000
ROBOT_MAX_DAILY_ORDERS=3
ROBOT_MAX_DAILY_RUB=2000
ROBOT_SIGNAL_COOLDOWN_MS=1800000
ROBOT_SIGNAL_PRICE_CHANGE_PERCENT=1
ROBOT_MIN_PROFIT_PERCENT=0.5
ROBOT_STOP_LOSS_PERCENT=3
ROBOT_TRAILING_STOP_PERCENT=2
ROBOT_TRAILING_BASELINE=observed
ROBOT_MAX_LOTS_PER_ORDER=1
ROBOT_LIVE_CONFIRMATION=

ROBOT_HTTP_ENABLED=true
ROBOT_HTTP_PORT=3000
ROBOT_WEB_USERNAME=robot
ROBOT_WEB_PASSWORD=
```

## Live Trading

Live trading requires both:

```env
ROBOT_DRY_RUN=false
ROBOT_LIVE_CONFIRMATION=I_UNDERSTAND_THIS_TRADES_REAL_MONEY
```

Do not enable live mode until dry-run decisions in `trade_decisions` look correct.
By default, live trading is buy-only through `ROBOT_LIVE_ALLOWED_ACTIONS=buy`.
Selling requires explicitly setting `ROBOT_LIVE_ALLOWED_ACTIONS=buy,sell`.

`ROBOT_OBSERVE_ACCOUNT_IDS` is read-only from the robot's point of view. The
robot may write analysis into `trade_decisions`, but order execution is only
allowed for `ROBOT_ACCOUNT_IDS`, and only after live mode is explicitly enabled.

## Strategies

Enabled strategies are configured by `ROBOT_ENABLED_STRATEGIES`.

- `profit-take` sends a sell signal when current price is above average price by `ROBOT_MIN_PROFIT_PERCENT`.
- `stop-loss` sends a sell signal when current price is below average price by `ROBOT_STOP_LOSS_PERCENT`.
- `trailing-stop` tracks the highest observed price in `position_states` and sends a sell signal when current price falls by `ROBOT_TRAILING_STOP_PERCENT` from that high.
- `watchlist-buy` sends a buy signal for tickers listed in `ROBOT_BUY_TICKERS` when the instrument is not already in the portfolio and the estimated order fits risk limits.

`ROBOT_TRAILING_BASELINE` controls how the first `highestPrice` is initialized:

- `observed` starts from the first price seen by the robot;
- `history_30d` starts from the max daily candle high over the last 30 days;
- `history_90d` starts from the max daily candle high over the last 90 days.

Signal execution priority is:

```text
stop-loss -> trailing-stop -> profit-take
```

Buy-side risk limits:

- `ROBOT_MAX_ORDER_RUB` caps a single estimated order amount;
- `ROBOT_MAX_DAILY_ORDERS` caps accepted buy orders per account per day;
- `ROBOT_MAX_DAILY_RUB` caps accepted buy order amount per account per day;
- the robot refuses buy signals when there is not enough available RUB cash.

Decision logging is de-duplicated through `signal_states`. Repeated decisions
with the same account, instrument, source, status, and reason are suppressed
until `ROBOT_SIGNAL_COOLDOWN_MS` passes or price changes by at least
`ROBOT_SIGNAL_PRICE_CHANGE_PERCENT`.
