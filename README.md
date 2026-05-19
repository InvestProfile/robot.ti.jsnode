# robot.ti.jsnode

TypeScript robot for T-Invest.

## Current Mode

The runtime is intentionally conservative:

- trades only accounts listed in `ROBOT_ACCOUNT_IDS`;
- observes accounts listed in `ROBOT_OBSERVE_ACCOUNT_IDS`;
- refuses to trade accounts listed in `ROBOT_PROTECTED_ACCOUNT_IDS`;
- starts in `ROBOT_DRY_RUN=true` by default;
- requires an explicit live confirmation phrase before real-money trading can start;
- can pause live order placement through `ROBOT_TRADING_PAUSED=true`;
- opens a circuit breaker after repeated tick errors;
- writes every decision into the `trade_decisions` table;
- writes posted orders into the `trades` table;
- writes portfolio history into the `portfolio_snapshots` table;
- reconciles posted orders against the broker order state.

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
npm run scan:universe
npm run market:regime
npm run scan:buy
npm run scan:buy -- SBER T YDEX
npm run backtest:buy
npm run backtest:buy -- --days 120 SBER T YDEX
npm run optimize:buy
npm run optimize:buy -- --days 120 --windows 10,20,30 --thresholds 60,65,70 SBER T YDEX
npm run signals:buy
npm run signals:buy -- --capture
npm run paper
npm run paper -- --tick
```

To estimate or apply a safe cleanup of noisy `dry-run` / `skip` decisions:

```bash
npm run cleanup:decisions -- 24
CLEANUP_APPLY=true npm run cleanup:decisions -- 24
```

To check readiness before running live:

```bash
npm run preflight
npm run preflight:live
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

Read-only endpoints:

- `/api/status`
- `/api/config`
- `/api/accounts`
- `/api/positions`
- `/api/preview`
- `/api/scan-universe`
- `/api/market-regime`
- `/api/buy-scan`
- `/api/buy-backtest`
- `/api/buy-optimize`
- `/api/buy-signals`
- `/api/paper-positions`
- `/api/decisions`
- `/api/trades`
- `/api/snapshots`
- `/api/performance`
- `/api/limits`

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
INVEST_API_URL=invest-public-api.tinkoff.ru:443
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
ROBOT_ORDER_TYPE=market
ROBOT_STALE_LIMIT_ORDER_MS=300000
ROBOT_STALE_LIMIT_PRICE_DRIFT_PERCENT=0.5
ROBOT_TRADING_PAUSED=false
ROBOT_MAX_CONSECUTIVE_TICK_ERRORS=3
ROBOT_SNAPSHOT_INTERVAL_MS=900000
ROBOT_INTERVAL_MS=60000
ROBOT_POSITION_DELAY_MS=1000
ROBOT_ENABLED_STRATEGIES=stop-loss,trailing-stop,profit-take,score-buy,trend-follow-buy,watchlist-buy
ROBOT_BUY_TICKERS=SBER,T,YDEX
ROBOT_SCAN_TICKERS=SBER,T,YDEX,GAZP,MOEX,LKOH,ROSN,VTBR,MGNT,NVTK
ROBOT_SCAN_UNIVERSE=manual
ROBOT_SCAN_UNIVERSE_LIMIT=150
ROBOT_SCAN_MAX_LOT_RUB=10000
ROBOT_BUY_TREND_DAYS=20
ROBOT_BUY_MIN_TREND_PERCENT=0.5
ROBOT_BUY_MIN_MOMENTUM_PERCENT=0
ROBOT_BUY_MIN_SCORE=70
ROBOT_BUY_SCORE_PROFILES=
ROBOT_MAX_ORDER_RUB=1000
ROBOT_MAX_DAILY_ORDERS=10
ROBOT_MAX_DAILY_RUB=10000
ROBOT_MAX_RUNTIME_ORDER_RUB=5000
ROBOT_MAX_RUNTIME_DAILY_ORDERS=40
ROBOT_MAX_RUNTIME_DAILY_RUB=50000
ROBOT_SIGNAL_COOLDOWN_MS=1800000
ROBOT_SIGNAL_PRICE_CHANGE_PERCENT=1
ROBOT_BUY_SIGNAL_JOURNAL_INTERVAL_MS=900000
ROBOT_MARKET_REGIME_ENABLED=true
ROBOT_MARKET_REGIME_TICKERS=SBER,LKOH,GAZP,YDEX,MOEX
ROBOT_MARKET_REGIME_DAYS=20
ROBOT_MARKET_REGIME_MIN_HEALTH_PERCENT=40
ROBOT_MARKET_REGIME_MIN_AVG_TREND_PERCENT=-1
ROBOT_PAPER_TRADING_ENABLED=true
ROBOT_PAPER_TRADING_INTERVAL_MS=900000
ROBOT_PAPER_MAX_POSITIONS=10
ROBOT_PAPER_MAX_POSITION_RUB=1000
ROBOT_PAPER_COMMISSION_PERCENT=0.05
ROBOT_PAPER_REENTRY_COOLDOWN_MS=10800000
ROBOT_SOCIAL_PROFILE_URLS=
ROBOT_SOCIAL_MIN_RETURN_PERCENT=100
ROBOT_SOCIAL_COLLECTOR_INTERVAL_MS=900000
ROBOT_SOCIAL_AUTH_COOKIE=
ROBOT_SOCIAL_SESSION_ID=
ROBOT_SOCIAL_REQUEST_MIN_DELAY_MS=5000
ROBOT_SOCIAL_REQUEST_MAX_DELAY_MS=10000
ROBOT_SOCIAL_INSTRUMENT_LIMIT=100
ROBOT_SOCIAL_OPERATION_LIMIT=1
ROBOT_SOCIAL_CONSENSUS_ENABLED=true
ROBOT_SOCIAL_CONSENSUS_DAYS=3
ROBOT_SOCIAL_CONSENSUS_MAX_SCORE_ADJUSTMENT=10
ROBOT_SOCIAL_CONSENSUS_MIN_ACTORS=1
ROBOT_ANALYST_CONSENSUS_ENABLED=true
ROBOT_ANALYST_CONSENSUS_MAX_SCORE_ADJUSTMENT=5
ROBOT_TECHNICAL_SCORE_ENABLED=true
ROBOT_TECHNICAL_MAX_SCORE_ADJUSTMENT=5
ROBOT_SOCIAL_COOKIE_UPDATE_SECRET=
ROBOT_MIN_PROFIT_PERCENT=0.5
ROBOT_STOP_LOSS_PERCENT=3
ROBOT_TRAILING_STOP_PERCENT=2
ROBOT_TRAILING_BASELINE=observed
ROBOT_SELL_HOLD_WINNER_MIN_PROFIT_PERCENT=2
ROBOT_SELL_HOLD_WINNER_MAX_DRAWDOWN_PERCENT=1
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
By default, orders are posted as market orders through `ROBOT_ORDER_TYPE=market`.
Set `ROBOT_ORDER_TYPE=limit` to post limit orders at the robot's current signal
price. Limit mode can reduce surprise execution prices, but an order may remain
unfilled and will be reconciled by the normal open-order safety loop.
`ROBOT_STALE_LIMIT_ORDER_MS` and `ROBOT_STALE_LIMIT_PRICE_DRIFT_PERCENT` control
read-only diagnostics for stale limit orders in `/api/order-safety`. They do not
cancel orders by themselves.

Set `ROBOT_TRADING_PAUSED=true` to keep the robot running in observe/analysis
mode while blocking real order placement. If repeated tick errors reach
`ROBOT_MAX_CONSECUTIVE_TICK_ERRORS`, the runtime opens a circuit breaker and
also blocks real order placement until the process is restarted.

`ROBOT_OBSERVE_ACCOUNT_IDS` is read-only from the robot's point of view. The
robot may write analysis into `trade_decisions`, but order execution is only
allowed for `ROBOT_ACCOUNT_IDS`, and only after live mode is explicitly enabled.

## Strategies

Enabled strategies are configured by `ROBOT_ENABLED_STRATEGIES`.

- `profit-take` sends a sell signal when current price is above average price by `ROBOT_MIN_PROFIT_PERCENT`.
- `stop-loss` sends a sell signal when current price is below average price by `ROBOT_STOP_LOSS_PERCENT`.
- `trailing-stop` tracks the highest observed price in `position_states` and sends a sell signal when current price falls by `ROBOT_TRAILING_STOP_PERCENT` from that high.
- `watchlist-buy` sends a buy signal for tickers listed in `ROBOT_BUY_TICKERS` when the instrument is not already in the portfolio and the estimated order fits risk limits.
- `trend-follow-buy` filters watchlist buys by daily candles: current price must be above the `ROBOT_BUY_TREND_DAYS` average by `ROBOT_BUY_MIN_TREND_PERCENT`, with at least `ROBOT_BUY_MIN_MOMENTUM_PERCENT` momentum from the previous daily close.
- `score-buy` scores watchlist buys using daily candles: trend, momentum, pullback from recent high, volatility, and volume. It sends a buy signal only when the score reaches `ROBOT_BUY_MIN_SCORE`.

`ROBOT_BUY_SCORE_PROFILES` can override the score window and threshold per ticker:

```env
ROBOT_BUY_SCORE_PROFILES=ROSN:10:75,VTBR:20:80,NVTK:30:80
```

The format is `TICKER:trendDays:minScore`. These profiles are used by live
buy evaluation, `/api/buy-scan`, and `/api/buy-backtest`. If a ticker has no
profile, the global `ROBOT_BUY_TREND_DAYS` and `ROBOT_BUY_MIN_SCORE` values are
used.

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
- `ROBOT_MAX_RUNTIME_*` caps how far the dashboard/API can raise the live runtime limits without editing `.env`;
- the robot refuses buy signals when there is not enough available RUB cash.

Decision logging is de-duplicated through `signal_states`. Repeated decisions
with the same account, instrument, source, status, and reason are suppressed
until `ROBOT_SIGNAL_COOLDOWN_MS` passes or price changes by at least
`ROBOT_SIGNAL_PRICE_CHANGE_PERCENT`.

Passed buy signals from `ROBOT_SCAN_TICKERS` are stored in `buy_signal_journal`.
If `ROBOT_SCAN_UNIVERSE=auto`, the journal scans an automatically filtered
universe of liquid RUB MOEX shares instead of the manual `ROBOT_SCAN_TICKERS`
list. The robot updates captured signals' 1/3/5/10 trading-day returns from
daily candles on the `ROBOT_BUY_SIGNAL_JOURNAL_INTERVAL_MS` interval. This is
paper analytics only: it does not post orders and it is available through
`/api/buy-signals`.

`ROBOT_PAPER_TRADING_ENABLED=true` runs a virtual portfolio over the same scan
targets. It opens paper positions from passed buy signals, updates current P/L,
and closes them by paper stop-loss, trailing-stop, or profit-take. Paper P/L is
net of `ROBOT_PAPER_COMMISSION_PERCENT` on entry and estimated exit, while
`ROBOT_PAPER_REENTRY_COOLDOWN_MS` prevents immediately reopening the same ticker
after a paper close. This does not post broker orders and is available through
`/api/paper-positions`.

`/api/strategy-evidence` and `npm run evidence` summarize whether the robot has
enough data to trust each strategy: buy-signal returns, paper P/L, win-rate,
commissions, confidence, and decision counts. `/api/sell-brain` and
`npm run sell:brain` show the current sell/hold/skip view across accounts. The
`hold-winner` strategy can suppress early profit-taking while a profitable
position is still close to its observed high. `/api/social-signals` is the read-only landing
zone for future Pulse/social-alpha parsing; those signals are stored separately
and should be treated as an extra decision factor, not as direct trade commands.
`npm run social:collect` performs one isolated social collector tick, while
`npm run social:collector` runs that collector as a separate long-running
process. It only writes social profile/signal data and is intentionally not part
of the main trading loop. In Docker it can be started separately with
`docker-compose up -d social_collector`; the normal robot deploy command starts
only the `robot` service.
The collector accepts either plain profile URLs or direct social API profile
descriptors in `uid|url|name|confidence|activity|description` format. The old
Pulse parser used the internal `invest-gw/social/v1/profile/{uid}` endpoints
with `sessionId=psid`, `limit=100` for instruments, `limit=1` for the latest
operation, and a random 5-10 second delay before requests; those controls are
kept as explicit environment settings.
`confidence` is the manual prior from the old profile JSON on a 0-10 scale. The
collector also reads public profile-page stats when a session is available:
followers, 30-day operations, portfolio range, and 12-month return. It turns
those facts plus recent social signals into `autoConfidence` on a 0-100 scale,
then combines manual and automatic scores into `effectiveConfidence` for future
social scoring.
`/api/social-consensus` and `npm run social:consensus` aggregate recent social
signals by ticker. The consensus weights each actor by `effectiveConfidence`,
classifies the ticker as bullish/bearish/mixed/quiet, and applies a bounded
`score-buy` adjustment controlled by `ROBOT_SOCIAL_CONSENSUS_MAX_SCORE_ADJUSTMENT`.
This is intentionally a small buy-score modifier, not a direct social-trading
order.
Analyst consensus and official technical indicators can also add bounded
modifiers through `ROBOT_ANALYST_CONSENSUS_MAX_SCORE_ADJUSTMENT` and
`ROBOT_TECHNICAL_MAX_SCORE_ADJUSTMENT`. They are additive diagnostics for
`score-buy`; they do not bypass daily limits, market regime checks, account
mode, dry-run mode, or order risk filters.
`/api/social-evidence` and `npm run social:evidence` backtest collected social
signals against future daily candles. For `buy`, a later price increase is good;
for `sell`, a later price decrease is good. This becomes the factual layer for
raising or lowering profile trust over time.
`POST /api/social-cookies` is the optional cookie refresh endpoint for a local
browser helper. It requires `ROBOT_SOCIAL_COOKIE_UPDATE_SECRET`, accepts only
`psid`, `investpublicPsid`, `sso_api_session`, and `navi_token`, then updates the
server `.env` without exposing cookie values in the response.

`ROBOT_MARKET_REGIME_ENABLED=true` blocks new buy signals when the market
backdrop is weak. It checks `ROBOT_MARKET_REGIME_TICKERS` against their
`ROBOT_MARKET_REGIME_DAYS` average and requires at least
`ROBOT_MARKET_REGIME_MIN_HEALTH_PERCENT` of them to pass. This only blocks new
buy entries; it does not force-close existing positions.
