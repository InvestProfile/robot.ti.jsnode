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
      --panel: #181c20;
      --panel-2: #20252a;
      --line: #303740;
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
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--line);
      background: #15181b;
      position: sticky;
      top: 0;
      z-index: 5;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 700; }
    h2 { margin: 0; font-size: 15px; font-weight: 700; color: var(--text); }
    h3 { margin: 0 0 8px; color: var(--muted); font-size: 13px; font-weight: 700; }
    main { padding: 16px; }
    section, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
    .topbar { display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; }
    .tabs {
      display: flex;
      gap: 6px;
      padding: 10px 20px;
      border-bottom: 1px solid var(--line);
      background: #15181b;
      position: sticky;
      top: 65px;
      z-index: 4;
      overflow-x: auto;
    }
    .tab {
      height: 34px;
      border: 1px solid var(--line);
      background: #1d2227;
      color: var(--muted);
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .tab.active { color: var(--text); background: #273039; border-color: #46515c; }
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
    .view { display: none; }
    .view.active { display: block; }
    .layout { display: grid; grid-template-columns: minmax(300px, 420px) 1fr; gap: 14px; align-items: start; }
    .stack { display: grid; gap: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .wide-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); background: #171b1f; border-radius: 6px; padding: 10px; min-height: 64px; }
    .label { color: var(--muted); font-size: 12px; display:flex; gap:6px; align-items:center; }
    .value { margin-top: 4px; font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
    .small { color: var(--muted); font-size: 12px; }
    .help {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      cursor: help;
    }
    .pill { display: inline-flex; align-items: center; gap: 7px; min-height: 24px; padding: 2px 9px; border-radius: 999px; font-weight: 700; font-size: 12px; border: 1px solid var(--line); }
    .dot { width: 8px; height: 8px; border-radius: 50%; display:inline-block; background: var(--muted); box-shadow: 0 0 12px currentColor; }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .blue { color: var(--blue); }
    .pill.good .dot { background: var(--good); }
    .pill.warn .dot { background: var(--warn); }
    .pill.bad .dot { background: var(--bad); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 700; }
    td { overflow-wrap: anywhere; }
    .right { text-align: right; }
    .nowrap { white-space: nowrap; }
    .reason { max-width: 680px; }
    .table-wrap { overflow: auto; max-height: 64vh; }
    .compact .table-wrap { max-height: 360px; }
    details {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    summary {
      cursor: pointer;
      padding: 12px 14px;
      font-weight: 700;
      color: var(--text);
      background: #171b1f;
    }
    details > div { padding: 10px 14px 14px; }
    .readiness {
      display: grid;
      grid-template-columns: minmax(260px, 420px) 1fr;
      gap: 12px;
      margin-bottom: 14px;
    }
    .readiness-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .blockers { display: flex; gap: 8px; flex-wrap: wrap; }
    @media (max-width: 1100px) {
      .layout, .readiness { grid-template-columns: 1fr; }
      .wide-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tabs { top: 61px; }
    }
    @media (max-width: 680px) {
      header { grid-template-columns: 1fr; }
      .topbar { justify-content: flex-start; }
      .grid, .wide-grid { grid-template-columns: 1fr; }
      main { padding: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>T-Invest Robot</h1>
    <div class="topbar">
      <span id="updated" class="small">loading...</span>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <nav class="tabs" aria-label="Dashboard tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="signals">Signals</button>
    <button class="tab" data-tab="paper">Paper</button>
    <button class="tab" data-tab="sell">Sell Brain</button>
    <button class="tab" data-tab="evidence">Evidence</button>
    <button class="tab" data-tab="social">Social</button>
    <button class="tab" data-tab="market">Market</button>
    <button class="tab" data-tab="accounts">Accounts</button>
    <button class="tab" data-tab="logs">Logs</button>
  </nav>
  <main>
    <div id="overview" class="view active">
      <div class="readiness">
        <section>
          <div class="readiness-title">
            <h2>Live Readiness <span class="help" title="Индикатор показывает, можно ли думать о live-покупках. Он учитывает dry-run, дневные лимиты, рынок, paper-статистику, ошибки и buy-preview.">?</span></h2>
            <span id="readinessPill" class="pill warn"><span class="dot"></span>CHECKING</span>
          </div>
          <div id="readinessText" class="small" style="margin-top:10px">-</div>
        </section>
        <section>
          <h2>Blockers <span class="help" title="Причины, почему робот сейчас не должен или не может покупать реальными деньгами.">?</span></h2>
          <div id="blockers" class="blockers"></div>
        </section>
      </div>
      <div class="wide-grid">
        <div class="metric"><div class="label">Mode <span class="help" title="DRY RUN означает, что робот считает решения, но не отправляет реальные заявки. LIVE означает реальные деньги.">?</span></div><div id="mode" class="value">-</div></div>
        <div class="metric"><div class="label">Market <span class="help" title="Общий фильтр рынка. Если рынок слабый, новые покупки блокируются.">?</span></div><div id="marketMini" class="value">-</div></div>
        <div class="metric"><div class="label">Paper P/L <span class="help" title="Виртуальная прибыль/убыток paper-портфеля с учетом комиссии.">?</span></div><div id="paperMini" class="value">-</div></div>
        <div class="metric"><div class="label">Daily Limit <span class="help" title="Сколько заявок уже использовано сегодня и сколько еще можно.">?</span></div><div id="limitMini" class="value">-</div></div>
      </div>
      <div class="layout" style="margin-top:14px">
        <div class="stack">
          <section>
            <h2>Status</h2>
            <div class="grid">
              <div class="metric"><div class="label">Tick</div><div id="tick" class="value">-</div></div>
              <div class="metric"><div class="label">Errors</div><div id="errors" class="value">-</div></div>
              <div class="metric"><div class="label">Last tick</div><div id="lastTick" class="value">-</div></div>
              <div class="metric"><div class="label">Safety</div><div id="safety" class="value">-</div></div>
            </div>
          </section>
          <section>
            <h2>Config Summary <span class="help" title="Короткая выжимка настроек, которые чаще всего объясняют поведение робота.">?</span></h2>
            <div id="config" class="small"></div>
          </section>
        </div>
        <section>
          <h2>Action Preview <span class="help" title="Что робот сделал бы по разрешенному списку buy tickers прямо сейчас. В dry-run это только расчет.">?</span></h2>
          <div class="table-wrap"><table id="preview"></table></div>
        </section>
      </div>
    </div>

    <div id="signals" class="view">
      <div class="layout">
        <section>
          <h2>Buy Signal Journal <span class="help" title="История бумажных buy-сигналов по auto-universe. Доходности 1/3/5/10 дней появятся позже, когда пройдет время.">?</span></h2>
          <div class="table-wrap"><table id="buySignals"></table></div>
        </section>
        <section>
          <h2>Action Preview</h2>
          <div class="table-wrap"><table id="previewSignals"></table></div>
        </section>
      </div>
    </div>

    <div id="paper" class="view">
      <section>
        <h2>Paper Portfolio <span class="help" title="Виртуальный портфель: робот как будто покупает/продает, считает P/L с учетом комиссии, но не трогает деньги.">?</span></h2>
        <div id="paperSummary" class="small" style="margin:8px 0 12px"></div>
        <div class="table-wrap"><table id="paperPositions"></table></div>
      </section>
    </div>

    <div id="sell" class="view">
      <section>
        <h2>Sell Brain <span class="help" title="Предпросмотр продажной логики по всем счетам. Hold означает: робот видит прибыль, но не хочет резать растущую позицию слишком рано.">?</span></h2>
        <div id="sellSummary" class="small" style="margin:8px 0 12px"></div>
        <div class="table-wrap"><table id="sellBrain"></table></div>
      </section>
    </div>

    <div id="evidence" class="view">
      <div class="layout">
        <section>
          <h2>Strategy Evidence <span class="help" title="Зачетка стратегий: сколько данных собрано, какой paper P/L, win-rate и можно ли уже доверять выводам.">?</span></h2>
          <div class="table-wrap"><table id="strategyEvidence"></table></div>
        </section>
        <section>
          <h2>Buy Signal Returns <span class="help" title="Проверка buy-сигналов из журнала: что происходило через 1/3/5/10 торговых дней после сигнала.">?</span></h2>
          <div id="buyReturnEvidence" class="small" style="margin-bottom:12px"></div>
          <h2>Social Alpha Summary <span class="help" title="Будущий слой Pulse/успешных людей. Сейчас это журнал и статистика, парсер подключим отдельным шагом.">?</span></h2>
          <div id="socialEvidence" class="small"></div>
        </section>
      </div>
    </div>

    <div id="social" class="view">
      <div class="layout">
        <section>
          <h2>Social Signals <span class="help" title="Сигналы от наблюдаемых успешных участников. Они не торгуют сами по себе, а дают дополнительный вес нашему алгоритму.">?</span></h2>
          <div id="socialSummary" class="small" style="margin:8px 0 12px"></div>
          <div class="table-wrap"><table id="socialSignals"></table></div>
        </section>
        <section>
          <h2>Collector Health <span class="help" title="Отдельный read-only процесс для Pulse/социальных профилей. Если он упадет, основной робот продолжит работать.">?</span></h2>
          <div id="socialCollectorSummary" class="small" style="margin:8px 0 12px"></div>
          <div class="table-wrap" style="margin-bottom:14px"><table id="socialProfiles"></table></div>
          <h2>Top Social Tickers</h2>
          <div class="table-wrap"><table id="socialTickers"></table></div>
        </section>
      </div>
    </div>

    <div id="market" class="view">
      <div class="layout">
        <section>
          <h2>Market Regime <span class="help" title="Рыночный стоп-кран. Если базовые бумаги слабые, новые покупки блокируются.">?</span></h2>
          <div id="marketRegimeSummary" class="small" style="margin-bottom:10px"></div>
          <div class="table-wrap"><table id="marketRegime"></table></div>
        </section>
        <section>
          <h2>Scan Universe <span class="help" title="Список ликвидных RUB MOEX бумаг, которые робот анализирует как рынок. Это не список реальных покупок.">?</span></h2>
          <div class="table-wrap"><table id="scanUniverse"></table></div>
        </section>
      </div>
    </div>

    <div id="accounts" class="view">
      <div class="layout">
        <div class="stack">
          <section><h2>Accounts</h2><div class="table-wrap"><table id="accountsTable"></table></div></section>
          <section><h2>Daily Limits</h2><div class="table-wrap"><table id="limits"></table></div></section>
          <section><h2>Performance</h2><div class="table-wrap"><table id="performance"></table></div></section>
        </div>
        <section><h2>Positions</h2><div class="table-wrap"><table id="positions"></table></div></section>
      </div>
    </div>

    <div id="logs" class="view">
      <div class="stack">
        <details open><summary>Latest Decisions</summary><div class="table-wrap"><table id="decisions"></table></div></details>
        <details><summary>Executed Trades</summary><div class="table-wrap"><table id="trades"></table></div></details>
        <details><summary>Portfolio History</summary><div class="table-wrap"><table id="snapshots"></table></div></details>
      </div>
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
    const rows = (headers, items, render) => '<thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + (items || []).map(render).join('') + '</tbody>';
    const pill = (kind, text) => '<span class="pill ' + kind + '"><span class="dot"></span>' + esc(text) + '</span>';
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
    function setActiveTab(id) {
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === id));
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === id));
      localStorage.setItem('robot-tab', id);
    }
    function getReadiness(status, limits, marketRegime, paperPositions, preview) {
      const blockers = [];
      if (status.config.dryRun) blockers.push({ kind: 'warn', text: 'dry-run включен' });
      if (status.config.tradingPaused) blockers.push({ kind: 'bad', text: 'торговля на паузе' });
      if (status.runtime.circuitBreakerOpen) blockers.push({ kind: 'bad', text: 'circuit breaker' });
      if (!marketRegime.passed) blockers.push({ kind: 'bad', text: 'слабый рынок' });
      if ((paperPositions.summary.closed || 0) < 3) blockers.push({ kind: 'warn', text: 'мало закрытых paper-сделок' });
      if (!preview.previews.some(p => p.status === 'allowed')) blockers.push({ kind: 'warn', text: 'нет allowed buy-preview' });
      if (limits.limits.some(l => l.ordersLeft <= 0)) blockers.push({ kind: 'warn', text: 'дневной лимит заявок исчерпан' });
      if ((status.runtime.consecutiveTickErrors || 0) > 0) blockers.push({ kind: 'warn', text: 'есть ошибки тика' });
      const hard = blockers.some(item => item.kind === 'bad');
      if (blockers.length === 0) return { kind: 'good', text: 'READY', details: 'По текущим проверкам live-buy выглядит допустимо.', blockers };
      if (hard) return { kind: 'bad', text: 'BLOCKED', details: 'Есть жесткие блокировки. Live включать нельзя.', blockers };
      return { kind: 'warn', text: 'WAIT', details: 'Деньги в безопасности. Live пока лучше не включать: нужны данные/снятие мягких блокировок.', blockers };
    }
    function renderPreview(tableId, preview) {
      document.getElementById(tableId).innerHTML = rows(['Ticker', 'Status', 'Price', 'Amount', 'Reason'], preview.previews, p =>
        '<tr><td>' + esc(p.ticker || p.figi) + '<div class="small">' + esc(p.name) + '</div></td><td>' + (p.status === 'allowed' ? pill('good', 'allowed') : pill('warn', 'blocked')) + '</td><td class="right nowrap">' + money(p.currentPrice) + '</td><td class="right nowrap">' + money(p.estimatedOrderRub) + '</td><td class="reason">' + esc(p.reason) + '</td></tr>'
      );
    }
    async function load() {
      const [status, accounts, limits, performance, decisions, trades, snapshots, positions, preview, buySignals, scanUniverse, paperPositions, marketRegime, strategyEvidence, socialSignals, socialCollector, sellBrain] = await Promise.all([
        api('/api/status'),
        api('/api/accounts'),
        api('/api/limits'),
        api('/api/performance'),
        api('/api/decisions?limit=80'),
        api('/api/trades?limit=20'),
        api('/api/snapshots?limit=20'),
        api('/api/positions'),
        api('/api/preview'),
        api('/api/buy-signals?limit=30'),
        api('/api/scan-universe'),
        api('/api/paper-positions?limit=50'),
        api('/api/market-regime'),
        api('/api/strategy-evidence'),
        api('/api/social-signals?limit=100'),
        api('/api/social-collector'),
        api('/api/sell-brain')
      ]);
      const readiness = getReadiness(status, limits, marketRegime, paperPositions, preview);
      document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString('ru-RU');
      document.getElementById('readinessPill').className = 'pill ' + readiness.kind;
      document.getElementById('readinessPill').innerHTML = '<span class="dot"></span>' + esc(readiness.text);
      document.getElementById('readinessText').textContent = readiness.details;
      document.getElementById('blockers').innerHTML = readiness.blockers.length
        ? readiness.blockers.map(item => pill(item.kind, item.text)).join('')
        : pill('good', 'нет блокировок');
      document.getElementById('mode').innerHTML = status.config.dryRun ? pill('warn', 'DRY RUN') : pill('bad', 'LIVE');
      document.getElementById('marketMini').innerHTML = marketRegime.passed ? pill('good', 'PASSED') : pill('bad', 'BLOCKED');
      document.getElementById('paperMini').textContent = money(paperPositions.summary.totalProfitRub) + ' RUB';
      document.getElementById('limitMini').textContent = limits.limits.map(l => l.ordersUsed + ' / ' + l.ordersLimit).join(', ');
      document.getElementById('tick').innerHTML = status.runtime.isTickRunning ? '<span class="blue">running</span>' : '<span class="good">idle</span>';
      document.getElementById('errors').innerHTML = esc(status.runtime.consecutiveTickErrors || 0) + ' / ' + esc(status.config.maxConsecutiveTickErrors);
      document.getElementById('lastTick').textContent = time(status.runtime.lastTickFinishedAt || status.runtime.lastTickStartedAt);
      document.getElementById('safety').innerHTML = status.config.tradingPaused ? pill('warn', 'PAUSED') : status.runtime.circuitBreakerOpen ? pill('bad', 'BREAKER') : pill('good', 'READY');
      document.getElementById('config').innerHTML = [
        'strategies: ' + esc(status.config.enabledStrategies.join(', ')),
        'buy tickers: ' + esc(status.config.buyTickers.join(', ')),
        'scan universe: ' + esc(status.config.scanUniverse) + ', ' + esc(status.config.scanUniverseLimit) + ' tickers',
        'market tickers: ' + esc(status.config.marketRegimeTickers.join(', ')),
        'paper: ' + esc(status.config.paperTradingEnabled) + ', fee ' + esc(status.config.paperCommissionPercent) + '%, cooldown ' + Math.round((status.config.paperReentryCooldownMs || 0) / 60000) + ' min',
        'sell brain: hold winners until ' + esc(status.config.sellHoldWinnerMinProfitPercent) + '%, unless drawdown > ' + esc(status.config.sellHoldWinnerMaxDrawdownPercent) + '%',
        'max order: ' + esc(status.config.maxOrderRub) + ' RUB, daily ' + esc(status.config.maxDailyOrders) + ' orders / ' + esc(status.config.maxDailyRub) + ' RUB',
        'live actions: ' + esc(status.config.liveAllowedActions.join(', '))
      ].join('<br>');
      renderPreview('preview', preview);
      renderPreview('previewSignals', preview);
      document.getElementById('buySignals').innerHTML = rows(['Time', 'Ticker', 'Profile', 'Score', 'Price', '1d', '3d', '5d', '10d'], buySignals.signals, s =>
        '<tr><td class="nowrap">' + time(s.signaledAt) + '</td><td>' + esc(s.ticker) + '<div class="small">' + esc(s.name) + '</div></td><td class="right">' + esc(s.profileTrendDays) + '/' + esc(s.profileMinScore) + '</td><td class="right">' + esc(s.signalScore) + '</td><td class="right">' + money(s.signalPrice) + '</td><td class="right">' + percent(s.return1dPercent) + '</td><td class="right">' + percent(s.return3dPercent) + '</td><td class="right">' + percent(s.return5dPercent) + '</td><td class="right">' + percent(s.return10dPercent) + '</td></tr>'
      );
      document.getElementById('paperSummary').innerHTML = [
        'open: ' + esc(paperPositions.summary.open),
        'closed: ' + esc(paperPositions.summary.closed),
        'net P/L: ' + money(paperPositions.summary.totalProfitRub) + ' RUB',
        'gross P/L: ' + money(paperPositions.summary.grossProfitRub) + ' RUB',
        'commission: ' + money(paperPositions.summary.totalCommissionRub) + ' RUB',
        'closed win-rate: ' + percent(paperPositions.summary.closedWinRatePercent),
        'avg open: ' + percent(paperPositions.summary.averageOpenProfitPercent)
      ].join('<br>');
      document.getElementById('paperPositions').innerHTML = rows(['Status', 'Ticker', 'Score', 'Entry', 'Current', 'Gross', 'Fee', 'Net', 'Reason'], paperPositions.positions, p =>
        '<tr><td>' + esc(p.status) + '</td><td>' + esc(p.ticker) + '<div class="small">' + esc(p.name) + '</div></td><td class="right">' + esc(p.entryScore) + '</td><td class="right">' + money(p.entryPrice) + '</td><td class="right">' + money(p.currentPrice || p.exitPrice) + '</td><td class="right">' + money(p.grossProfitRub) + '</td><td class="right">' + money(p.totalCommissionRub) + '</td><td class="right">' + money(p.profitRub) + '<div class="small">' + percent(p.profitPercent) + '</div></td><td class="reason">' + esc(p.exitReason || p.entryReason) + '</td></tr>'
      );
      document.getElementById('sellSummary').innerHTML = [
        'positions: ' + esc(sellBrain.summary.positions),
        'sell: ' + esc(sellBrain.summary.sell),
        'hold: ' + esc(sellBrain.summary.hold),
        'blocked/skip: ' + esc(sellBrain.summary.blocked)
      ].join('<br>');
      document.getElementById('sellBrain').innerHTML = rows(['Account', 'Ticker', 'Action', 'Source', 'P/L', 'Lots', 'Reason'], sellBrain.items, s =>
        '<tr><td>' + esc(s.accountAlias || s.accountId) + '<div class="small">' + esc(s.accountMode) + '</div></td><td>' + esc(s.ticker || s.figi) + '<div class="small">' + esc(s.name) + '</div></td><td>' + (s.status === 'allowed' ? pill('bad', s.action) : s.status === 'hold' ? pill('good', 'hold') : pill('warn', s.action)) + '</td><td>' + esc(s.source) + '</td><td class="right">' + percent(s.profitPercent) + '</td><td class="right">' + esc(s.orderLots || s.signalLots || s.quantityLots) + '</td><td class="reason">' + esc(s.reason) + '</td></tr>'
      );
      document.getElementById('strategyEvidence').innerHTML = rows(['Strategy', 'Type', 'Data', 'Confidence', 'Win-rate', 'Avg', 'P/L', 'Fee', 'Status', 'Note'], strategyEvidence.strategies, s =>
        '<tr><td>' + esc(s.strategy) + '</td><td>' + esc(s.type) + '</td><td>signals ' + esc(s.signals) + '<div class="small">paper ' + esc(s.paperPositions) + ', closed ' + esc(s.closed) + ', decisions ' + esc(s.decisions) + '</div></td><td class="right">' + esc(s.confidence) + '</td><td class="right">' + percent(s.winRatePercent) + '</td><td class="right">' + percent(s.averageProfitPercent) + '</td><td class="right">' + money(s.profitRub) + '</td><td class="right">' + money(s.commissionRub) + '</td><td>' + (s.status === 'enough-data' ? pill('good', s.status) : pill('warn', s.status || 'log')) + '</td><td class="reason">' + esc(s.note || ('dry-run ' + (s.dryRun || 0) + ', skip ' + (s.skipped || 0) + ', orders ' + (s.orders || 0))) + '</td></tr>'
      );
      const returns = strategyEvidence.buySignalJournal;
      document.getElementById('buyReturnEvidence').innerHTML = [
        'signals: ' + esc(returns.signals),
        '1d: n=' + esc(returns.return1d.count) + ', avg ' + percent(returns.return1d.avg) + ', WR ' + percent(returns.return1d.winRatePercent),
        '3d: n=' + esc(returns.return3d.count) + ', avg ' + percent(returns.return3d.avg) + ', WR ' + percent(returns.return3d.winRatePercent),
        '5d: n=' + esc(returns.return5d.count) + ', avg ' + percent(returns.return5d.avg) + ', WR ' + percent(returns.return5d.winRatePercent),
        '10d: n=' + esc(returns.return10d.count) + ', avg ' + percent(returns.return10d.avg) + ', WR ' + percent(returns.return10d.winRatePercent)
      ].join('<br>');
      document.getElementById('socialEvidence').innerHTML = [
        'signals 30d: ' + esc(strategyEvidence.socialAlpha.signals),
        'actors: ' + esc(strategyEvidence.socialAlpha.actors),
        'tickers: ' + esc(strategyEvidence.socialAlpha.tickers),
        'avg actor return: ' + percent(strategyEvidence.socialAlpha.averageActorReturnPercent)
      ].join('<br>');
      document.getElementById('socialSummary').innerHTML = [
        'signals 30d: ' + esc(socialSignals.summary.signals),
        'actors: ' + esc(socialSignals.summary.actors),
        'tickers: ' + esc(socialSignals.summary.tickers),
        'avg confidence: ' + percent(socialSignals.summary.averageConfidence),
        'avg actor return: ' + percent(socialSignals.summary.averageActorReturnPercent)
      ].join('<br>');
      document.getElementById('socialSignals').innerHTML = rows(['Time', 'Actor', 'Return', 'Ticker', 'Action', 'Confidence', 'Reason'], socialSignals.signals, s =>
        '<tr><td class="nowrap">' + time(s.observedAt) + '</td><td>' + esc(s.actorName || s.actorKey) + '<div class="small">' + esc(s.source) + '</div></td><td class="right">' + percent(s.actorReturnPercent) + '</td><td>' + esc(s.ticker) + '<div class="small">' + esc(s.name) + '</div></td><td>' + esc(s.action) + '</td><td class="right">' + percent(s.confidence) + '</td><td class="reason">' + esc(s.reason) + '</td></tr>'
      );
      document.getElementById('socialCollectorSummary').innerHTML = [
        socialCollector.ok ? pill('good', 'OK') : pill('warn', 'WAITING'),
        'profiles: ' + esc(socialCollector.health.activeProfiles) + ' / configured ' + esc(socialCollector.config.configuredProfiles),
        'pending auth: ' + esc(socialCollector.health.pendingAuth),
        'stale: ' + esc(socialCollector.health.staleProfiles),
        'auth cookie: ' + esc(socialCollector.config.hasAuthCookie),
        'session id: ' + esc(socialCollector.config.hasSessionId),
        'delay: ' + esc(socialCollector.config.requestMinDelayMs) + '-' + esc(socialCollector.config.requestMaxDelayMs) + ' ms'
      ].join('<br>');
      document.getElementById('socialProfiles').innerHTML = rows(['Status', 'Profile', 'UID', 'Activity', 'Return', 'Checked', 'Error'], socialCollector.profiles, p =>
        '<tr><td>' + (p.status === 'ready' ? pill('good', p.status) : pill('warn', p.status)) + '</td><td>' + esc(p.displayName || p.profileKey) + '<div class="small">' + esc(p.profileUrl) + '</div></td><td>' + esc(p.profileUid) + '</td><td class="right">' + esc(p.activity) + '</td><td class="right">' + percent(p.lastReturnPercent) + '</td><td class="nowrap">' + time(p.lastCheckedAt) + '</td><td class="reason">' + esc(p.lastError) + '</td></tr>'
      );
      document.getElementById('socialTickers').innerHTML = rows(['Ticker', 'Signals', 'Buy', 'Sell', 'Watch', 'Hold'], socialSignals.summary.topTickers, s =>
        '<tr><td>' + esc(s.ticker) + '</td><td class="right">' + esc(s.count) + '</td><td class="right">' + esc(s.buy) + '</td><td class="right">' + esc(s.sell) + '</td><td class="right">' + esc(s.watch) + '</td><td class="right">' + esc(s.hold) + '</td></tr>'
      );
      document.getElementById('marketRegimeSummary').innerHTML = [
        marketRegime.passed ? pill('good', 'PASSED') : pill('bad', 'BLOCKED'),
        esc(marketRegime.reason),
        'health: ' + percent(marketRegime.healthPercent),
        'avg trend: ' + percent(marketRegime.avgTrendPercent)
      ].join('<br>');
      document.getElementById('marketRegime').innerHTML = rows(['Ticker', 'Trend', 'Passed', 'Reason'], marketRegime.items, i =>
        '<tr><td>' + esc(i.ticker) + '<div class="small">' + esc(i.name) + '</div></td><td class="right">' + percent(i.trendPercent) + '</td><td>' + (i.passed ? pill('good', 'true') : pill('warn', 'false')) + '</td><td class="reason">' + esc(i.reason) + '</td></tr>'
      );
      document.getElementById('scanUniverse').innerHTML = rows(['Ticker', 'Lot RUB', 'Sector', 'Name'], scanUniverse.items.slice(0, 80), i =>
        '<tr><td>' + esc(i.ticker) + '</td><td class="right">' + money(i.estimatedLotRub) + '</td><td>' + esc(i.sector) + '</td><td>' + esc(i.name) + '</td></tr>'
      );
      document.getElementById('accountsTable').innerHTML = rows(['Account', 'Mode', 'Cash RUB', 'Total', 'Positions'], accounts.accounts, a =>
        '<tr><td>' + esc(a.alias || a.accountId) + '<div class="small">' + esc(a.accountId) + '</div></td><td>' + esc(a.mode) + '</td><td class="right">' + money(a.cashRub) + '</td><td class="right">' + money(a.totalRub) + '</td><td class="right">' + esc(a.positionsCount) + '</td></tr>'
      );
      document.getElementById('limits').innerHTML = rows(['Account', 'Orders', 'Left', 'RUB used', 'RUB left'], limits.limits, l =>
        '<tr><td>' + esc(l.accountAlias || l.accountId) + '</td><td class="right">' + esc(l.ordersUsed) + ' / ' + esc(l.ordersLimit) + '</td><td class="right">' + esc(l.ordersLeft) + '</td><td class="right">' + money(l.rubUsed) + ' / ' + money(l.rubLimit) + '</td><td class="right">' + money(l.rubLeft) + '</td></tr>'
      );
      document.getElementById('performance').innerHTML = rows(['Account', 'Total', 'Change', 'Last', 'Drawdown'], performance.accounts, p =>
        '<tr><td>' + esc(p.accountAlias || p.accountId) + '<div class="small">' + esc(p.snapshotsCount) + ' snapshots</div></td><td class="right">' + money(p.latestTotalRub) + '</td><td class="right">' + money(p.totalChangeRub) + '<div class="small">' + percent(p.totalChangePercent) + '</div></td><td class="right">' + money(p.periodChangeRub) + '<div class="small">' + percent(p.periodChangePercent) + '</div></td><td class="right">' + money(p.maxDrawdownRub) + '<div class="small">-' + esc((p.maxDrawdownPercent || 0).toFixed(2)) + '%</div></td></tr>'
      );
      document.getElementById('positions').innerHTML = rows(['Account', 'Ticker', 'Name', 'Lots', 'Average', 'Current', 'P/L'], positions.positions, p =>
        '<tr><td>' + esc(p.accountAlias || p.accountId) + '</td><td>' + esc(p.ticker || p.figi) + '</td><td>' + esc(p.name) + '</td><td class="right">' + esc(p.quantityLots) + '</td><td class="right">' + money(p.averagePrice) + '</td><td class="right">' + money(p.currentPrice) + '</td><td class="right">' + percent(p.profitPercent) + '</td></tr>'
      );
      document.getElementById('decisions').innerHTML = rows(['Time', 'Account', 'Mode', 'Ticker', 'Signal', 'Status', 'P/L', 'Reason'], decisions.decisions, d =>
        '<tr><td class="nowrap">' + time(d.createdAt) + '</td><td>' + esc(d.accountAlias || d.accountId) + '</td><td>' + esc(d.accountMode) + '</td><td>' + esc(d.ticker || d.figi) + '</td><td>' + esc(d.signalSource) + '</td><td>' + esc(d.status) + '</td><td class="right">' + percent(d.profitPercent) + '</td><td class="reason">' + esc(d.reason) + '</td></tr>'
      );
      document.getElementById('trades').innerHTML = rows(['Time', 'Account', 'Ticker', 'Side', 'Lots', 'Done', 'Amount', 'Status', 'Order'], trades.trades, t =>
        '<tr><td class="nowrap">' + time(t.createdAt) + '</td><td>' + esc(t.accountId) + '</td><td>' + esc(t.ticker || t.figi) + '<div class="small">' + esc(t.name) + '</div></td><td>' + esc(tradeDirection(t.direction)) + '</td><td class="right">' + esc(t.lotsRequested || t.lot || t.quantity) + '</td><td class="right">' + esc(t.lotsExecuted) + '</td><td class="right">' + money(tradeAmount(t)) + '</td><td>' + esc(t.status) + '</td><td>' + esc(t.orderId) + '</td></tr>'
      );
      document.getElementById('snapshots').innerHTML = rows(['Time', 'Account', 'Mode', 'Cash', 'Total', 'Positions'], snapshots.snapshots, s =>
        '<tr><td class="nowrap">' + time(s.createdAt) + '</td><td>' + esc(s.accountAlias || s.accountId) + '</td><td>' + esc(s.accountMode) + '</td><td class="right">' + money(s.cashRub) + '</td><td class="right">' + money(s.totalRub) + '</td><td class="right">' + esc(s.positionsCount) + '</td></tr>'
      );
    }
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));
    setActiveTab(localStorage.getItem('robot-tab') || 'overview');
    document.getElementById('refresh').addEventListener('click', () => load().catch(err => alert(err.message)));
    load().catch(err => {
      document.getElementById('updated').textContent = 'error';
      document.body.insertAdjacentHTML('afterbegin', '<div style="padding:12px;background:#4d1f2d;color:white">' + esc(err.message) + '</div>');
    });
    setInterval(() => load().catch(() => {}), 30000);
  </script>
</body>
</html>`;
