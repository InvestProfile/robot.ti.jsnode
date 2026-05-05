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
        </div>
      </section>
      <section>
        <h2>Accounts</h2>
        <div style="overflow:auto"><table id="accounts"></table></div>
      </section>
      <section>
        <h2>Config</h2>
        <div id="config" class="small"></div>
      </section>
    </div>
    <div class="stack">
      <section>
        <h2>Latest Decisions</h2>
        <div style="overflow:auto"><table id="decisions"></table></div>
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
    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    async function load() {
      const [status, accounts, decisions, positions] = await Promise.all([
        api('/api/status'),
        api('/api/accounts'),
        api('/api/decisions?limit=80'),
        api('/api/positions')
      ]);
      document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString('ru-RU');
      document.getElementById('mode').innerHTML = status.config.dryRun ? '<span class="pill warn">DRY RUN</span>' : '<span class="pill bad">LIVE</span>';
      document.getElementById('tick').innerHTML = status.runtime.isTickRunning ? '<span class="blue">running</span>' : '<span class="good">idle</span>';
      document.getElementById('interval').textContent = Math.round(status.config.intervalMs / 1000) + ' sec';
      document.getElementById('lastTick').textContent = time(status.runtime.lastTickFinishedAt || status.runtime.lastTickStartedAt);
      document.getElementById('config').innerHTML = [
        'strategies: ' + esc(status.config.enabledStrategies.join(', ')),
        'trade accounts: ' + esc(status.config.accountIds.join(', ')),
        'observe accounts: ' + esc(status.config.observeAccountIds.join(', ')),
        'buy tickers: ' + esc(status.config.buyTickers.join(', ')),
        'max order RUB: ' + esc(status.config.maxOrderRub),
        'max daily orders: ' + esc(status.config.maxDailyOrders),
        'max daily RUB: ' + esc(status.config.maxDailyRub),
        'signal cooldown: ' + esc(Math.round(status.config.signalCooldownMs / 60000)) + ' min',
        'signal price change: ' + esc(status.config.signalPriceChangePercent) + '%'
      ].join('<br>');
      document.getElementById('accounts').innerHTML = rows(['Account', 'Mode', 'Cash RUB', 'Total', 'Positions'], accounts.accounts, a =>
        '<tr><td>' + esc(a.alias || a.accountId) + '<div class="small">' + esc(a.accountId) + '</div></td><td>' + esc(a.mode) + '</td><td class="right">' + money(a.cashRub) + '</td><td class="right">' + money(a.totalRub) + '</td><td class="right">' + esc(a.positionsCount) + '</td></tr>'
      );
      document.getElementById('decisions').innerHTML = rows(['Time', 'Account', 'Mode', 'Ticker', 'Signal', 'Status', 'P/L', 'Reason'], decisions.decisions, d =>
        '<tr><td>' + time(d.createdAt) + '</td><td>' + esc(d.accountAlias || d.accountId) + '</td><td>' + esc(d.accountMode) + '</td><td>' + esc(d.ticker || d.figi) + '</td><td>' + esc(d.signalSource) + '</td><td>' + esc(d.status) + '</td><td class="right">' + percent(d.profitPercent) + '</td><td>' + esc(d.reason) + '</td></tr>'
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
