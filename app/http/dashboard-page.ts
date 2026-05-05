export const dashboardPage = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>T-Invest Robot</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #191d21;
      --line: #2d3339;
      --text: #eef1f3;
      --muted: #9aa4ad;
      --good: #74c69d;
      --warn: #ffd166;
      --bad: #ef476f;
      --blue: #79addc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      background: #15181b;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    h2 { margin: 0 0 12px; font-size: 15px; font-weight: 650; color: var(--muted); }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 420px) 1fr;
      gap: 16px;
      padding: 16px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
    .stack { display: grid; gap: 16px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); border-radius: 6px; padding: 10px; min-height: 66px; }
    .label { color: var(--muted); font-size: 12px; }
    .value { margin-top: 4px; font-size: 18px; font-weight: 650; overflow-wrap: anywhere; }
    .pill { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 99px; font-weight: 650; font-size: 12px; border: 1px solid var(--line); }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .blue { color: var(--blue); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 600; }
    td { overflow-wrap: anywhere; }
    .small { color: var(--muted); font-size: 12px; }
    .right { text-align: right; }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    button {
      height: 32px;
      border: 1px solid var(--line);
      background: #22272d;
      color: var(--text);
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { background: #2a3037; }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>T-Invest Robot</h1>
    <div class="toolbar">
      <span id="updated" class="small">loading...</span>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <div class="stack">
      <section>
        <h2>Status</h2>
        <div class="grid">
          <div class="metric"><div class="label">Mode</div><div id="mode" class="value">-</div></div>
          <div class="metric"><div class="label">Tick</div><div id="tick" class="value">-</div></div>
          <div class="metric"><div class="label">Interval</div><div id="interval" class="value">-</div></div>
          <div class="metric"><div class="label">Last tick</div><div id="lastTick" class="value">-</div></div>
          <div class="metric"><div class="label">Safety</div><div id="safety" class="value">-</div></div>
          <div class="metric"><div class="label">Errors</div><div id="errors" class="value">-</div></div>
        </div>
      </section>
      <section>
        <h2>Accounts</h2>
        <div style="overflow:auto"><table id="accounts"></table></div>
      </section>
      <section>
        <h2>Daily Limits</h2>
        <div style="overflow:auto"><table id="limits"></table></div>
      </section>
      <section>
        <h2>Performance</h2>
        <div style="overflow:auto"><table id="performance"></table></div>
      </section>
      <section>
        <h2>Config</h2>
        <div id="config" class="small"></div>
      </section>
    </div>
    <div class="stack">
      <section>
        <h2>Action Preview</h2>
        <div style="overflow:auto"><table id="preview"></table></div>
      </section>
      <section>
        <h2>Buy Signal Journal</h2>
        <div style="overflow:auto"><table id="buySignals"></table></div>
      </section>
      <section>
        <h2>Latest Decisions</h2>
        <div style="overflow:auto"><table id="decisions"></table></div>
      </section>
      <section>
        <h2>Executed Trades</h2>
        <div style="overflow:auto"><table id="trades"></table></div>
      </section>
      <section>
        <h2>Portfolio History</h2>
        <div style="overflow:auto"><table id="snapshots"></table></div>
      </section>
      <section>
        <h2>Positions</h2>
        <div style="overflow:auto"><table id="positions"></table></div>
      </section>
    </div>
  </main>
  <script>
    const money = value => typeof value === 'number'
      ? value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
      : '-';
    const percent = value => typeof value === 'number'
      ? (value > 0 ? '+' : '') + value.toFixed(2) + '%'
      : '-';
    const time = value => value ? new Date(value).toLocaleString('ru-RU') : '-';
    const esc = value => String(value ?? '-').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const rows = (headers, items, render) => '<thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + items.map(render).join('') + '</tbody>';
    const tradeDirection = value => String(value) === '2' ? 'sell' : String(value) === '1' ? 'buy' : '-';
    const tradeAmount = trade => {
      const total = Number(trade.totalAmountUnits || 0) + Number(trade.totalAmountNano || 0) / 1e9;
      if (Number.isFinite(total) && total > 0) return total;

      const price = Number(trade.price_units || 0) + Number(trade.price_nano || 0) / 1e9;
      const lots = Math.max(1, Number(trade.lot || trade.quantity || 1));
      return Number.isFinite(price) && Number.isFinite(lots) ? price * lots : undefined;
    };
    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    async function load() {
      const [status, accounts, limits, performance, decisions, trades, snapshots, positions, preview, buySignals] = await Promise.all([
        api('/api/status'),
        api('/api/accounts'),
        api('/api/limits'),
        api('/api/performance'),
        api('/api/decisions?limit=80'),
        api('/api/trades?limit=20'),
        api('/api/snapshots?limit=20'),
        api('/api/positions'),
        api('/api/preview'),
        api('/api/buy-signals?limit=30')
      ]);
      document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString('ru-RU');
      document.getElementById('mode').innerHTML = status.config.dryRun ? '<span class="pill warn">DRY RUN</span>' : '<span class="pill bad">LIVE</span>';
      document.getElementById('tick').innerHTML = status.runtime.isTickRunning ? '<span class="blue">running</span>' : '<span class="good">idle</span>';
      document.getElementById('interval').textContent = Math.round(status.config.intervalMs / 1000) + ' sec';
      document.getElementById('lastTick').textContent = time(status.runtime.lastTickFinishedAt || status.runtime.lastTickStartedAt);
      document.getElementById('safety').innerHTML = status.config.tradingPaused
        ? '<span class="pill warn">PAUSED</span>'
        : status.runtime.circuitBreakerOpen
          ? '<span class="pill bad">BREAKER</span>'
          : '<span class="pill good">READY</span>';
      document.getElementById('errors').innerHTML = esc(status.runtime.consecutiveTickErrors || 0) + ' / ' + esc(status.config.maxConsecutiveTickErrors)
        + (status.runtime.circuitBreakerReason ? '<div class="small">' + esc(status.runtime.circuitBreakerReason) + '</div>' : '');
      document.getElementById('config').innerHTML = [
        'strategies: ' + esc(status.config.enabledStrategies.join(', ')),
        'trade accounts: ' + esc(status.config.accountIds.join(', ')),
        'observe accounts: ' + esc(status.config.observeAccountIds.join(', ')),
        'buy tickers: ' + esc(status.config.buyTickers.join(', ')),
        'buy score: min ' + esc(status.config.buyMinScore) + ', trend ' + esc(status.config.buyTrendDays) + 'd, +' + esc(status.config.buyMinTrendPercent) + '%, momentum +' + esc(status.config.buyMinMomentumPercent) + '%',
        'max order RUB: ' + esc(status.config.maxOrderRub),
        'max daily orders: ' + esc(status.config.maxDailyOrders),
        'max daily RUB: ' + esc(status.config.maxDailyRub),
        'live actions: ' + esc(status.config.liveAllowedActions.join(', ')),
        'trading paused: ' + esc(status.config.tradingPaused),
        'snapshot interval: ' + esc(Math.round(status.config.snapshotIntervalMs / 60000)) + ' min',
        'signal cooldown: ' + esc(Math.round(status.config.signalCooldownMs / 60000)) + ' min',
        'signal price change: ' + esc(status.config.signalPriceChangePercent) + '%'
      ].join('<br>');
      document.getElementById('preview').innerHTML = rows(['Ticker', 'Status', 'Price', 'Amount', 'Reason'], preview.previews, p =>
        '<tr><td>' + esc(p.ticker || p.figi) + '<div class="small">' + esc(p.name) + '</div></td><td>' + esc(p.status) + '</td><td class="right">' + money(p.currentPrice) + '</td><td class="right">' + money(p.estimatedOrderRub) + '</td><td>' + esc(p.reason) + '</td></tr>'
      );
      document.getElementById('buySignals').innerHTML = rows(['Time', 'Ticker', 'Profile', 'Score', 'Price', '1d', '3d', '5d', '10d'], buySignals.signals, s =>
        '<tr><td>' + time(s.signaledAt) + '</td><td>' + esc(s.ticker) + '<div class="small">' + esc(s.name) + '</div></td><td class="right">' + esc(s.profileTrendDays) + '/' + esc(s.profileMinScore) + '</td><td class="right">' + esc(s.signalScore) + '</td><td class="right">' + money(s.signalPrice) + '</td><td class="right">' + percent(s.return1dPercent) + '</td><td class="right">' + percent(s.return3dPercent) + '</td><td class="right">' + percent(s.return5dPercent) + '</td><td class="right">' + percent(s.return10dPercent) + '</td></tr>'
      );
      document.getElementById('accounts').innerHTML = rows(['Account', 'Mode', 'Cash RUB', 'Total', 'Positions'], accounts.accounts, a =>
        '<tr><td>' + esc(a.alias || a.accountId) + '<div class="small">' + esc(a.accountId) + '</div></td><td>' + esc(a.mode) + '</td><td class="right">' + money(a.cashRub) + '</td><td class="right">' + money(a.totalRub) + '</td><td class="right">' + esc(a.positionsCount) + '</td></tr>'
      );
      document.getElementById('limits').innerHTML = rows(['Account', 'Orders', 'Left', 'RUB used', 'RUB left'], limits.limits, l =>
        '<tr><td>' + esc(l.accountAlias || l.accountId) + '</td><td class="right">' + esc(l.ordersUsed) + ' / ' + esc(l.ordersLimit) + '</td><td class="right">' + esc(l.ordersLeft) + '</td><td class="right">' + money(l.rubUsed) + ' / ' + money(l.rubLimit) + '</td><td class="right">' + money(l.rubLeft) + '</td></tr>'
      );
      document.getElementById('performance').innerHTML = rows(['Account', 'Total', 'Change', 'Last', 'Drawdown'], performance.accounts, p =>
        '<tr><td>' + esc(p.accountAlias || p.accountId) + '<div class="small">' + esc(p.snapshotsCount) + ' snapshots</div></td><td class="right">' + money(p.latestTotalRub) + '</td><td class="right">' + money(p.totalChangeRub) + '<div class="small">' + percent(p.totalChangePercent) + '</div></td><td class="right">' + money(p.periodChangeRub) + '<div class="small">' + percent(p.periodChangePercent) + '</div></td><td class="right">' + money(p.maxDrawdownRub) + '<div class="small">-' + esc((p.maxDrawdownPercent || 0).toFixed(2)) + '%</div></td></tr>'
      );
      document.getElementById('decisions').innerHTML = rows(['Time', 'Account', 'Mode', 'Ticker', 'Signal', 'Status', 'P/L', 'Reason'], decisions.decisions, d =>
        '<tr><td>' + time(d.createdAt) + '</td><td>' + esc(d.accountAlias || d.accountId) + '</td><td>' + esc(d.accountMode) + '</td><td>' + esc(d.ticker || d.figi) + '</td><td>' + esc(d.signalSource) + '</td><td>' + esc(d.status) + '</td><td class="right">' + percent(d.profitPercent) + '</td><td>' + esc(d.reason) + '</td></tr>'
      );
      document.getElementById('trades').innerHTML = rows(['Time', 'Account', 'Ticker', 'Side', 'Lots', 'Done', 'Amount', 'Status', 'Order'], trades.trades, t =>
        '<tr><td>' + time(t.createdAt) + '</td><td>' + esc(t.accountId) + '</td><td>' + esc(t.ticker || t.figi) + '<div class="small">' + esc(t.name) + '</div></td><td>' + esc(tradeDirection(t.direction)) + '</td><td class="right">' + esc(t.lotsRequested || t.lot || t.quantity) + '</td><td class="right">' + esc(t.lotsExecuted) + '</td><td class="right">' + money(tradeAmount(t)) + '</td><td>' + esc(t.status) + '</td><td>' + esc(t.orderId) + '</td></tr>'
      );
      document.getElementById('snapshots').innerHTML = rows(['Time', 'Account', 'Mode', 'Cash', 'Total', 'Positions'], snapshots.snapshots, s =>
        '<tr><td>' + time(s.createdAt) + '</td><td>' + esc(s.accountAlias || s.accountId) + '</td><td>' + esc(s.accountMode) + '</td><td class="right">' + money(s.cashRub) + '</td><td class="right">' + money(s.totalRub) + '</td><td class="right">' + esc(s.positionsCount) + '</td></tr>'
      );
      document.getElementById('positions').innerHTML = rows(['Account', 'Ticker', 'Name', 'Lots', 'Average', 'Current', 'P/L'], positions.positions, p =>
        '<tr><td>' + esc(p.accountAlias || p.accountId) + '</td><td>' + esc(p.ticker || p.figi) + '</td><td>' + esc(p.name) + '</td><td class="right">' + esc(p.quantityLots) + '</td><td class="right">' + money(p.averagePrice) + '</td><td class="right">' + money(p.currentPrice) + '</td><td class="right">' + percent(p.profitPercent) + '</td></tr>'
      );
    }
    document.getElementById('refresh').addEventListener('click', () => load().catch(err => alert(err.message)));
    load().catch(err => {
      document.getElementById('updated').textContent = 'error';
      document.body.insertAdjacentHTML('afterbegin', '<div style="padding:12px;background:#4d1f2d;color:white">' + esc(err.message) + '</div>');
    });
    setInterval(() => load().catch(() => {}), 30000);
  </script>
</body>
</html>`;
