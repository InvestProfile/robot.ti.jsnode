import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Database,
  Eye,
  LineChart,
  RefreshCw,
  ShieldCheck,
  Signal,
  Users
} from 'lucide-react';
import './styles.css';

const endpoints = {
  status: '/api/status',
  accounts: '/api/accounts',
  limits: '/api/limits',
  performance: '/api/performance',
  preview: '/api/preview',
  dailyBuyList: '/api/daily-buy-list',
  decisions: '/api/decisions?limit=60',
  positions: '/api/positions',
  paper: '/api/paper-positions?limit=60',
  market: '/api/market-regime',
  marketLab: '/api/market-lab?limit=8',
  strategy: '/api/strategy-evidence',
  socialSignals: '/api/social-signals?limit=80',
  socialCollector: '/api/social-collector',
  socialConsensus: '/api/social-consensus',
  socialEvidence: '/api/social-evidence?limit=80',
  sellBrain: '/api/sell-brain',
  buyScan: '/api/buy-scan',
  buyLab: '/api/buy-lab?hours=24&limit=30',
  buyRecommendations: '/api/buy-recommendations?limit=30',
  analystForecasts: '/api/analyst-forecasts',
  techAnalysis: '/api/tech-analysis',
  robotPositions: '/api/robot-positions',
  trades: '/api/trades?limit=80'
};

const endpointGroups = {
  core: ['status', 'limits', 'performance', 'paper', 'socialCollector'],
  overview: ['market'],
  buy: ['dailyBuyList', 'preview', 'buyRecommendations', 'buyScan'],
  social: ['socialConsensus', 'socialSignals', 'socialCollector'],
  evidence: ['market', 'marketLab', 'buyLab', 'analystForecasts', 'techAnalysis', 'strategy', 'socialEvidence'],
  accounts: ['accounts', 'positions'],
  sell: ['sellBrain', 'positions', 'robotPositions'],
  logs: ['decisions', 'trades', 'robotPositions']
};

const tabs = [
  { id: 'overview', label: 'Обзор', icon: Activity },
  { id: 'buy', label: 'Покупки', icon: Signal },
  { id: 'sell', label: 'Продажи', icon: AlertTriangle },
  { id: 'social', label: 'Пульс', icon: Users },
  { id: 'evidence', label: 'Лаборатория', icon: BarChart3 },
  { id: 'accounts', label: 'Счета', icon: Database },
  { id: 'logs', label: 'Журнал', icon: Eye }
];

const EMPTY = '—';

const isMissing = (value) => value === undefined || value === null || value === '';

const display = (value) => isMissing(value) ? EMPTY : value;

const money = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return EMPTY;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value));
};

const percent = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return EMPTY;
  const sign = Number(value) > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(2)}%`;
};

const moneyParts = (units, nano) => {
  const unitValue = Number(units ?? 0);
  const nanoValue = Number(nano ?? 0);
  if (!Number.isFinite(unitValue) || !Number.isFinite(nanoValue)) return null;
  return unitValue + nanoValue / 1_000_000_000;
};

const time = (value) => {
  if (!value) return EMPTY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return date.toLocaleString('ru-RU');
};

const recTone = (recommendation) => {
  if (recommendation === 'buy') return 'good';
  if (recommendation === 'sell') return 'bad';
  if (recommendation === 'hold') return 'warn';
  return 'neutral';
};

const signalTone = (value) => {
  if (['bullish', 'oversold', 'buy'].includes(value)) return 'good';
  if (['bearish', 'overbought', 'sell', 'error'].includes(value)) return 'bad';
  if (value === 'neutral' || value === 'hold') return 'warn';
  return 'neutral';
};

const cls = (...names) => names.filter(Boolean).join(' ');

const Pill = ({ tone = 'neutral', children }) => (
  <span className={cls('pill', tone)}>{children}</span>
);

const signedNumber = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return EMPTY;
  const number = Math.round(Number(value));
  return number > 0 ? `+${number}` : String(number);
};

const adjustmentTone = (value) => {
  if (Number(value) > 0) return 'good';
  if (Number(value) < 0) return 'bad';
  return 'neutral';
};

const ScoreBreakdown = ({ analysis }) => {
  const factors = analysis?.factors || {};
  const items = [
    { key: 'base', label: 'base', value: factors.baseScore, title: 'Базовый score: тренд, momentum, откат от хая, волатильность и объем.' },
    { key: 'social', label: 'pulse', value: factors.socialScoreAdjustment, title: 'Поправка от выбранных успешных авторов Пульса.' },
    { key: 'analyst', label: 'analyst', value: factors.analystScoreAdjustment, title: 'Поправка от консенсус-прогноза аналитиков T-Invest.' },
    { key: 'tech', label: 'tech', value: factors.technicalScoreAdjustment, title: 'Поправка от официальных индикаторов T-Invest: RSI, MACD и средние.' }
  ];

  if (!analysis) return EMPTY;

  return (
    <div className="score-breakdown" title={analysis.reason}>
      <strong>{analysis.score ?? '-'}</strong>
      {items.map((item) => (
        <span key={item.key} className={adjustmentTone(item.value)} title={item.title}>
          {item.label} {signedNumber(item.value)}
        </span>
      ))}
    </div>
  );
};

const shortReason = (value) => {
  const text = String(value || EMPTY);
  if (text.length <= 90) return text;

  const markers = [
    'score-buy blocked:',
    'market regime blocked:',
    'observe-only:',
    'instrument is already in portfolio',
    'instrument is not in normal trading status',
    'daily order limit reached'
  ];
  const marker = markers.find((item) => text.startsWith(item));
  if (marker) return marker.replace(/:$/, '');

  return `${text.slice(0, 86).trim()}...`;
};

const Reason = ({ children }) => {
  const text = String(children || EMPTY);
  if (text.length <= 90) return <span className="reason-short" title={text}>{text}</span>;

  return (
    <details className="reason-cell" title={text}>
      <summary>{shortReason(text)}</summary>
      <p>{text}</p>
    </details>
  );
};

const Card = ({ title, icon: Icon, help, children, className }) => (
  <section className={cls('panel', className)}>
    <div className="panel-head">
      <h2>{Icon ? <Icon size={17} /> : null}{title}</h2>
      {help ? <span className="help" title={help}>?</span> : null}
    </div>
    {children}
  </section>
);

const Stat = ({ label, value, tone, title }) => (
  <div className="stat" title={title}>
    <span>{label}</span>
    <strong className={tone || ''}>{value}</strong>
  </div>
);

const cellValue = (value) => isMissing(value) ? EMPTY : value;

const TextCell = ({ children, className }) => {
  const value = cellValue(children);
  return <span className={cls('text-cell', className)} title={String(value)}>{value}</span>;
};

const Table = ({ columns, rows, empty = 'Нет данных', loading = false, className, rowClassName }) => (
  <div className="table-wrap">
    {loading && rows?.length ? <div className="table-loading">Обновляю...</div> : null}
    <table className={className}>
      <colgroup>
        {columns.map((column) => <col key={column.key} style={column.width ? { width: column.width } : undefined} />)}
      </colgroup>
      <thead>
        <tr>{columns.map((column) => <th key={column.key} className={column.className}>{column.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows?.length ? rows.map((row, index) => (
          <tr key={row.id || `${row.ticker || row.accountId || 'row'}-${index}`} className={rowClassName ? rowClassName(row) : undefined}>
            {columns.map((column) => (
              <td key={column.key} className={column.className}>
                {column.render ? column.render(row) : cellValue(row[column.key])}
              </td>
            ))}
          </tr>
        )) : (
          <tr><td colSpan={columns.length} className="empty">{loading ? 'Загрузка...' : empty}</td></tr>
        )}
      </tbody>
    </table>
  </div>
);

const useDashboardData = (activeTab) => {
  const [data, setData] = useState({});
  const [loadingKeys, setLoadingKeys] = useState({});
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const activeTabRef = useRef(activeTab);

  const load = async (keys) => {
    const uniqueKeys = [...new Set(keys)];
    setError('');
    setLoadingKeys((current) => ({
      ...current,
      ...Object.fromEntries(uniqueKeys.map((key) => [key, true]))
    }));

    const results = await Promise.allSettled(uniqueKeys.map(async (key) => {
        const url = endpoints[key];
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const payload = await response.json();

        setData((current) => ({ ...current, [key]: payload }));
        setUpdatedAt(new Date());
        setLoadingKeys((current) => ({ ...current, [key]: false }));
        return [key, payload];
    }));

    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));

    if (failures.length) setError(failures.join('; '));
    setLoadingKeys((current) => ({
      ...current,
      ...Object.fromEntries(uniqueKeys.map((key) => [key, false]))
    }));
  };

  const loadActiveTab = () => load([...(endpointGroups.core || []), ...(endpointGroups[activeTabRef.current] || [])]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    void loadActiveTab();
  }, [activeTab]);

  useEffect(() => {
    const interval = window.setInterval(() => void load(['status']), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const loading = Object.values(loadingKeys).some(Boolean);

  return { data, loading, loadingKeys, error, updatedAt, reload: loadActiveTab };
};

const getReadiness = (data) => {
  const blockers = [];
  const status = data.status;
  const limits = data.limits;
  const market = data.market;
  const socialCollector = data.socialCollector;

  if (status?.config?.tradingPaused) blockers.push('trading paused');
  if (status?.runtime?.circuitBreakerOpen) blockers.push('circuit breaker');
  if (market && !market.passed) blockers.push('market blocked');
  if (limits?.limits?.some((limit) => limit.ordersLeft <= 0)) blockers.push('daily order limit');
  if (socialCollector?.health?.pendingAuth > 0) blockers.push('social collector auth');

  return blockers;
};

const socialCollectorText = (social) => {
  if (!social) return 'loading';
  if (social.health?.pendingAuth > 0) return 'needs auth';
  if (social.health?.staleProfiles > 0) return `idle, ${social.health.staleProfiles} stale`;
  return 'fresh';
};

function MarketControls({ data, onMarketRegimeChange }) {
  const config = data.status?.config || {};
  const market = data.market || {};
  const health = config.marketRegimeMinHealthPercent ?? 40;
  const trend = config.marketRegimeMinAvgTrendPercent ?? -1;

  return (
    <Card title="Настройка рынка" icon={ShieldCheck} help="Меняет фильтр рынка без перезапуска. Health - сколько бумаг из корзины должно быть здоровыми. Trend - насколько бумага может быть ниже своей 20-дневной средней и все еще считаться здоровой.">
      <div className="readiness">
        <Pill tone={market.passed ? 'good' : 'bad'}>{market.passed ? 'PASSED' : 'BLOCKED'}</Pill>
        <span>{market.reason}</span>
      </div>
      <div className="stats compact">
        <Stat label="Health" value={`${health}%`} />
        <Stat label="Trend floor" value={`${trend}%`} />
        <Stat label="Passed" value={`${market.passedCount ?? '-'} / ${market.measuredCount ?? '-'}`} />
        <Stat label="Avg trend" value={percent(market.avgTrendPercent)} />
      </div>
      <div className="control-row">
        {[40, 20, 0].map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === health && 'active')}
            onClick={() => onMarketRegimeChange(value, trend)}
            title={value === 40 ? 'Консервативно: минимум 2 из 5 бумаг должны пройти.' : value === 20 ? 'Мягко: достаточно 1 из 5, как сейчас.' : 'Лабораторный режим: рынок почти не блокирует покупки.'}
          >
            health {value}%
          </button>
        ))}
      </div>
      <div className="control-row">
        {[-1, -2, -5].map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === trend && 'active')}
            onClick={() => onMarketRegimeChange(health, value)}
            title="Минимальный тренд к 20-дневной средней для отдельной бумаги."
          >
            trend {value}%
          </button>
        ))}
      </div>
    </Card>
  );
}

function MarketLab({ data, loading }) {
  const scenarios = data.marketLab?.scenarios || [];

  return (
    <Card title="Лаборатория рынка" icon={BarChart3} help="Сравнение: какие покупки прошли бы при разных порогах health. Это не меняет настройки, только показывает последствия.">
      <Table
        columns={[
          { key: 'label', label: 'Mode', render: (row) => <><strong>{row.label}</strong><div className="muted">health {row.minHealthPercent}%</div></> },
          { key: 'marketPassed', label: 'Market', render: (row) => <Pill tone={row.marketPassed ? 'good' : 'bad'}>{row.marketPassed ? 'PASS' : 'BLOCK'}</Pill> },
          { key: 'passCount', label: 'Buy', className: 'right', render: (row) => row.passCount },
          { key: 'waitCount', label: 'Wait', className: 'right', render: (row) => row.waitCount },
          {
            key: 'items',
            label: 'Candidates',
            className: 'reason',
            render: (row) => (
              <div className="candidate-stack">
                {(row.items || []).slice(0, 5).map((item) => (
                  <span key={item.ticker} title={item.reason}>
                    <strong>{item.ticker}</strong> {item.score ?? '-'} {item.passed ? 'PASS' : 'WAIT'}
                  </span>
                ))}
              </div>
            )
          },
          { key: 'marketReason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.marketReason}</Reason> }
        ]}
        rows={scenarios}
        loading={loading}
      />
    </Card>
  );
}

function Overview({ data, loadingKeys, onMarketRegimeChange }) {
  const blockers = getReadiness(data);
  const status = data.status;
  const social = data.socialCollector;
  const paper = data.paper?.summary;
  const market = data.market || {};

  return (
    <div className="grid overview-grid">
      <Card title="Состояние" icon={Bot} help="Главный светофор. READY значит, что робот не видит технических блокировок. BLOCKED показывает, что сейчас мешает сделке: лимит, пауза, рынок или аварийная защита.">
        <div className="readiness">
          {blockers.length ? <Pill tone="bad">BLOCKED</Pill> : <Pill tone="good">READY</Pill>}
          <span>{blockers.length ? blockers.join(', ') : 'No active blockers'}</span>
        </div>
        <div className="stats">
          <Stat label="Mode" value={status?.config?.dryRun ? 'DRY RUN' : 'LIVE'} tone={status?.config?.dryRun ? 'warn' : 'bad'} />
          <Stat label="Tick" value={status?.runtime?.isTickRunning ? 'running' : 'idle'} tone={status?.runtime?.isTickRunning ? 'blue' : 'good'} />
          <Stat label="Interval" value={`${status?.config?.intervalMs ? status.config.intervalMs / 1000 : '-'} sec`} />
          <Stat label="Errors" value={`${status?.runtime?.consecutiveTickErrors || 0} / ${status?.config?.maxConsecutiveTickErrors || '-'}`} />
        </div>
      </Card>

      <Card title="Рынок" icon={Activity} help="Короткий светофор рынка. Подробная таблица и сценарии вынесены в Лабораторию, чтобы Обзор не превращался в простыню.">
        <div className="readiness">
          <Pill tone={market.passed ? 'good' : 'bad'}>{market.passed ? 'PASSED' : 'BLOCKED'}</Pill>
          <span>{market.reason}</span>
        </div>
        <div className="stats compact">
          <Stat label="Health" value={`${status?.config?.marketRegimeMinHealthPercent ?? '-'}%`} />
          <Stat label="Trend floor" value={`${status?.config?.marketRegimeMinAvgTrendPercent ?? '-'}%`} />
          <Stat label="Passed" value={`${market.passedCount ?? '-'} / ${market.measuredCount ?? '-'}`} />
          <Stat label="Avg trend" value={percent(market.avgTrendPercent)} />
        </div>
      </Card>

      <Card title="Портфель" icon={LineChart} help="Бумажная торговля и социальный сборщик. Это не реальные заявки, а контроль качества идей и сигналов.">
        <div className="stats">
          <Stat label="Paper open" value={paper?.open ?? '-'} />
          <Stat label="Paper P/L" value={`${money(paper?.totalProfitRub)} RUB`} tone={(paper?.totalProfitRub || 0) >= 0 ? 'good' : 'bad'} />
          <Stat label="Social profiles" value={`${social?.health?.activeProfiles || 0} / ${social?.config?.configuredProfiles || 0}`} />
          <Stat label="Social collector" value={socialCollectorText(social)} tone={social?.health?.pendingAuth > 0 ? 'bad' : social?.health?.staleProfiles > 0 ? 'warn' : 'good'} />
        </div>
      </Card>

      <MarketControls data={data} onMarketRegimeChange={onMarketRegimeChange} />
    </div>
  );
}

function Buy({ data, loadingKeys }) {
  const dailyBuyList = data.dailyBuyList || {};
  const dailyItems = dailyBuyList.items || [];
  const dailyExcluded = dailyBuyList.excluded || [];

  return (
    <div className="grid">
      <Card title="Кандидаты дня" icon={Bot} help="Автоматический buy-list из широкого рынка. Робот выбирает до 5 бумаг с лучшим score среди доступных рублевых акций, вместо старого ручного списка из случайных позиций.">
        <div className="stats compact">
          <Stat label="Source" value={dailyBuyList.source || '-'} />
          <Stat label="Tickers" value={(dailyBuyList.tickers || []).join(', ') || '-'} />
          <Stat label="Scanned" value={dailyBuyList.universe?.scanned ?? '-'} />
          <Stat label="Expires" value={dailyBuyList.expiresAt ? time(dailyBuyList.expiresAt) : '-'} />
        </div>
        <div className="insight-strip">
          <div>
            <span>Выбраны</span>
            <strong>{dailyItems.map((item) => item.ticker).join(', ') || '-'}</strong>
          </div>
          <div>
            <span>Не вошли</span>
            <strong>{dailyExcluded.length ? dailyExcluded.map((item) => item.ticker).join(', ') : '-'}</strong>
          </div>
        </div>
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Score', className: 'right', render: (row) => row.score ?? '-' },
            { key: 'gap', label: 'Gap', className: 'right', render: (row) => row.gap === undefined ? '-' : row.gap <= 0 ? <Pill tone="good">PASS</Pill> : row.gap },
            { key: 'lastPrice', label: 'Price', className: 'right', render: (row) => money(row.lastPrice) },
            { key: 'estimatedOrderRub', label: 'Lot RUB', className: 'right', render: (row) => money(row.estimatedOrderRub) },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={dailyItems}
          empty="No daily candidates yet"
          loading={loadingKeys.dailyBuyList}
        />
      </Card>

      <Card title="Не вошли в день" icon={Eye} help="Бумаги из широкого сканера, которые были близко к проходному score, но не попали в дневной buy-list. Чаще всего причина простая: один лот дороже текущего лимита заявки.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Score', className: 'right', render: (row) => row.score ?? '-' },
            { key: 'gap', label: 'Gap', className: 'right', render: (row) => row.gap === undefined ? '-' : row.gap <= 0 ? <Pill tone="good">PASS</Pill> : row.gap },
            { key: 'estimatedOrderRub', label: 'Lot RUB', className: 'right', render: (row) => money(row.estimatedOrderRub) },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={dailyExcluded}
          empty="No excluded candidates"
          loading={loadingKeys.dailyBuyList}
        />
      </Card>

      <Card title="Можно / нельзя" icon={ShieldCheck} help="Боевой предпросмотр покупки по торговому счету. Это самый практический блок: что робот хотел бы купить, по какой цене и почему разрешено или заблокировано.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
            { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'allowed' ? 'good' : 'warn'}>{row.status}</Pill> },
            { key: 'score', label: 'Score', render: (row) => <ScoreBreakdown analysis={row.scoreAnalysis} /> },
            { key: 'currentPrice', label: 'Price', className: 'right', render: (row) => money(row.currentPrice) },
            { key: 'estimatedOrderRub', label: 'Amount', className: 'right', render: (row) => money(row.estimatedOrderRub) },
            { key: 'brokerQuote', label: 'Broker', className: 'right', render: (row) => row.brokerQuote ? money(row.brokerQuote.totalOrderAmount) : '-' },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={data.preview?.previews || []}
          loading={loadingKeys.preview}
        />
      </Card>
      <Card title="Авторекомендации" icon={ShieldCheck} help="Сжатый список того, что робот предлагает делать с кандидатами: buy-candidate можно покупать при пройденных фильтрах, wait-market ждет рынок, watch близко к порогу, scan-only просто наблюдать.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'recommendation', label: 'Rec', render: (row) => <Pill tone={row.recommendation === 'buy-candidate' ? 'good' : row.recommendation === 'wait-market' || row.recommendation === 'watch' ? 'warn' : 'neutral'}>{row.recommendation}</Pill> },
            { key: 'score', label: 'Score', className: 'right', render: (row) => <strong>{row.score}</strong> },
            { key: 'scoreGap', label: 'Gap', className: 'right', render: (row) => row.scoreGap ? row.scoreGap : <Pill tone="good">PASS</Pill> },
            { key: 'lastPrice', label: 'Price', className: 'right', render: (row) => money(row.lastPrice) },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={data.buyRecommendations?.items || []}
          loading={loadingKeys.buyRecommendations}
        />
      </Card>
      <Card title="Кандидаты на покупку" icon={Signal} help="Оценка бумаг из текущего списка наблюдения. Score 70/100 и выше обычно считается проходным. Base - сама цена/объем, pulse - Пульс, analyst - прогнозы, tech - индикаторы.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Score', render: (row) => <ScoreBreakdown analysis={row.analysis} /> },
            { key: 'lastPrice', label: 'Price', className: 'right', render: (row) => money(row.lastPrice) },
            { key: 'passed', label: 'Result', render: (row) => <Pill tone={row.passed ? 'good' : 'warn'}>{row.passed ? 'PASS' : 'WAIT'}</Pill> },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={data.buyScan?.items || []}
          loading={loadingKeys.buyScan}
        />
      </Card>
    </div>
  );
}

function Sell({ data, loadingKeys }) {
  const liveActions = data.status?.config?.liveAllowedActions || [];
  const sellArmed = liveActions.includes('sell');
  const items = data.sellBrain?.items || [];
  const robotLedger = data.robotPositions || {};
  const robotPositions = robotLedger.items || [];
  const robotEvents = robotLedger.events || [];
  const liveCandidates = items.filter((row) => row.accountMode === 'trade' && row.action === 'sell');
  const executable = liveCandidates.filter((row) => row.status === 'allowed' && Number(row.orderLots || 0) > 0);
  const policyBlocked = liveCandidates.filter((row) => row.status !== 'allowed');
  const observeSignals = items.filter((row) => row.accountMode === 'observe' && row.action === 'sell');

  const sellColumns = [
    { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
    { key: 'source', label: 'Signal' },
    { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'allowed' ? 'bad' : row.status === 'hold' ? 'good' : 'neutral'}>{row.status}</Pill> },
    { key: 'robotOwnedLots', label: 'Robot', className: 'right', render: (row) => row.robotOwnedLots ?? '-' },
    { key: 'orderLots', label: 'Sell', className: 'right', render: (row) => row.orderLots ?? '-' },
    { key: 'quantityLots', label: 'Total', className: 'right', render: (row) => row.quantityLots ?? '-' },
    { key: 'profitPercent', label: 'P/L', className: 'right', render: (row) => percent(row.profitPercent) },
    { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
  ];

  return (
    <div className="grid">
      <Card title="Боевой sell-лист" icon={AlertTriangle} help="Это список позиций торгового счета, которые робот смог бы продать, если sell включен. Даже при включенном sell заявка пройдет только на robot-owned лоты.">
        <div className="readiness">
          <Pill tone={sellArmed ? 'bad' : 'good'}>{sellArmed ? 'SELL ARMED' : 'SELL OFF'}</Pill>
          <span>{sellArmed ? 'Реальные продажи разрешены политикой действий.' : 'Реальные продажи выключены. Список ниже только показывает готовность.'}</span>
        </div>
        <div className="stats compact">
          <Stat label="Executable" value={executable.length} tone={executable.length ? 'bad' : 'good'} />
          <Stat label="Policy blocked" value={policyBlocked.length} />
          <Stat label="Robot lots" value={money(executable.reduce((sum, row) => sum + Number(row.orderLots || 0), 0))} />
          <Stat label="Live actions" value={liveActions.join(', ') || '-'} tone={sellArmed ? 'bad' : 'good'} />
        </div>
        <Table
          columns={sellColumns}
          rows={liveCandidates}
          empty="No robot-owned sell candidates"
          loading={loadingKeys.sellBrain}
        />
      </Card>

      <Card title="Позиции робота" icon={Bot} help="Ledger строится только из реальных заявок робота. Если тут пусто, значит роботу еще нечего защищенно продавать. Несколько докупок одной бумаги сворачиваются в среднюю цену робота.">
        <div className="stats compact">
          <Stat label="Open" value={robotLedger.summary?.positions ?? 0} />
          <Stat label="Lots" value={money(robotLedger.summary?.lots)} />
          <Stat label="Value" value={`${money(robotLedger.summary?.marketValue)} RUB`} />
          <Stat label="P/L" value={`${money(robotLedger.summary?.unrealizedPnl)} RUB`} tone={Number(robotLedger.summary?.unrealizedPnl) >= 0 ? 'good' : 'bad'} />
        </div>
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
            { key: 'lots', label: 'Lots', className: 'right', render: (row) => money(row.lots) },
            { key: 'averagePrice', label: 'Avg', className: 'right', render: (row) => money(row.averagePrice) },
            { key: 'currentPrice', label: 'Now', className: 'right', render: (row) => money(row.currentPrice) },
            { key: 'unrealizedPnl', label: 'P/L', className: 'right', render: (row) => <span className={Number(row.unrealizedPnl) >= 0 ? 'good' : 'bad'}>{money(row.unrealizedPnl)}</span> },
            { key: 'unrealizedPnlPercent', label: 'P/L %', className: 'right', render: (row) => percent(row.unrealizedPnlPercent) },
            { key: 'buys', label: 'B/S', className: 'right', render: (row) => `${row.buys || 0}/${row.sells || 0}` },
            { key: 'lastTradeAt', label: 'Last', render: (row) => time(row.lastTradeAt) }
          ]}
          rows={robotPositions}
          empty="No robot-owned positions yet"
          loading={loadingKeys.robotPositions}
        />
      </Card>

      <Card title="Защита продаж" icon={ShieldCheck} help="Почему робот не должен случайно продать ручные позиции. Robot - сколько лотов доказано куплено роботом, Sell - сколько лотов можно выставить сейчас.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
            { key: 'accountAlias', label: 'Account' },
            { key: 'source', label: 'Signal' },
            { key: 'robotOwnedLots', label: 'Robot', className: 'right', render: (row) => row.robotOwnedLots ?? '-' },
            { key: 'orderLots', label: 'Sell', className: 'right', render: (row) => row.orderLots ?? '-' },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.sellPolicy || row.reason}</Reason> }
          ]}
          rows={liveCandidates}
          empty="No sell policy checks yet"
          loading={loadingKeys.sellBrain}
        />
      </Card>

      <Card title="Сделки робота" icon={Database} help="Последние buy/sell события из внутреннего журнала заявок. Они объясняют, из чего сложился robot-owned остаток.">
        <Table
          columns={[
            { key: 'at', label: 'Time', render: (row) => time(row.at) },
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker || '-'}</strong><div className="muted">{row.name}</div></> },
            { key: 'direction', label: 'Side', render: (row) => <Pill tone={row.direction === 'buy' ? 'good' : 'bad'}>{row.direction}</Pill> },
            { key: 'lots', label: 'Lots', className: 'right', render: (row) => money(row.lots) },
            { key: 'price', label: 'Price', className: 'right', render: (row) => money(row.price) },
            { key: 'status', label: 'Status', render: (row) => <Reason>{row.status || '-'}</Reason> }
          ]}
          rows={robotEvents}
          empty="No robot trades yet"
          loading={loadingKeys.robotPositions}
        />
      </Card>

      <Card title="Наблюдаемые sell-сигналы" icon={Eye} help="Это мнения по долгосрочному счету, ИИС и Инвесткопилке. Они не исполняются, а нужны, чтобы учить и проверять стратегию продаж.">
        <Table
          columns={sellColumns}
          rows={observeSignals}
          empty="No observe sell signals"
          loading={loadingKeys.sellBrain}
        />
      </Card>
    </div>
  );
}

function Social({ data, loadingKeys }) {
  return (
    <div className="grid">
      <Card title="Консенсус Пульса" icon={Users} help="Сводное мнение выбранных успешных авторов по тикеру. Чем больше вес и свежесть сигнала, тем сильнее поправка к buy-score.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'mood', label: 'Mood', render: (row) => <Pill tone={row.mood === 'bullish' ? 'good' : row.mood === 'bearish' ? 'bad' : 'warn'}>{row.mood}</Pill> },
            { key: 'score', label: 'Score', className: 'right' },
            { key: 'scoreAdjustment', label: 'Adj', className: 'right' },
            { key: 'actors', label: 'Actors', className: 'right' },
            { key: 'signals', label: 'Signals', className: 'right' },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={data.socialConsensus?.items || []}
          loading={loadingKeys.socialConsensus}
        />
      </Card>
      <Card title="Авторы" icon={ShieldCheck} help="Список профилей, которых собирает отдельный социальный механизм. Manual - твоя ручная оценка, Auto - автоматическая оценка по данным профиля, Effective - итоговый вес.">
        <Table
          columns={[
            { key: 'displayName', label: 'Profile', render: (row) => <><strong>{row.displayName || row.profileKey}</strong><div className="muted">followers {row.followersCount ?? '-'}, ops30d {row.monthOperationsCount ?? '-'}</div></> },
            { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'ready' ? 'good' : 'warn'}>{row.status}</Pill> },
            { key: 'confidence', label: 'Manual', className: 'right' },
            { key: 'autoConfidence', label: 'Auto', className: 'right' },
            { key: 'effectiveConfidence', label: 'Effective', className: 'right' },
            { key: 'lastReturnPercent', label: 'Return', className: 'right', render: (row) => percent(row.lastReturnPercent) },
            { key: 'recentSignalsCount', label: 'Signals', className: 'right' }
          ]}
          rows={data.socialCollector?.profiles || []}
          loading={loadingKeys.socialCollector}
        />
      </Card>
      <Card title="Сделки авторов" icon={Signal} help="Последние найденные сделки/публичные действия из Пульса. Этот блок ничего не покупает сам, только складывает сигналы для проверки и усиления алгоритма.">
        <Table
          columns={[
            { key: 'observedAt', label: 'Time', render: (row) => time(row.observedAt) },
            { key: 'actorName', label: 'Actor', render: (row) => row.actorName || row.actorKey },
            { key: 'ticker', label: 'Ticker' },
            { key: 'action', label: 'Action' },
            { key: 'price', label: 'Price', className: 'right', render: (row) => money(row.price) },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={data.socialSignals?.signals || []}
          loading={loadingKeys.socialSignals}
        />
      </Card>
    </div>
  );
}

function Evidence({ data, loadingKeys }) {
  const socialSummary = data.socialEvidence?.summary || {};
  return (
    <div className="grid">
      <MarketLab data={data} loading={loadingKeys.marketLab} />

      <Card title="Режим рынка" icon={Activity} help="Подробности рыночного фильтра: какие базовые бумаги считаются здоровыми и почему общий фильтр пропускает или блокирует покупки.">
        <div className="readiness">
          <Pill tone={data.market?.passed ? 'good' : 'bad'}>{data.market?.passed ? 'PASSED' : 'BLOCKED'}</Pill>
          <span>{data.market?.reason}</span>
        </div>
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'trendPercent', label: 'Trend', className: 'right', render: (row) => percent(row.trendPercent) },
            { key: 'passed', label: 'Passed', render: (row) => <Pill tone={row.passed ? 'good' : 'warn'}>{String(row.passed)}</Pill> },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={data.market?.items || []}
          loading={loadingKeys.market}
        />
      </Card>

      <Card title="Покупки 24ч" icon={BarChart3} help="Агрегация решений за последние 24 часа. Показывает, какие бумаги чаще всего подходили к порогу покупки, сколько баллов не хватило и что было главным стопором.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'latestScore', label: 'Score', render: (row) => <div className="score-breakdown"><strong>{row.latestScore ?? '-'}</strong><span>base {signedNumber(row.baseScore)}</span><span className={adjustmentTone(row.socialScoreAdjustment)}>pulse {signedNumber(row.socialScoreAdjustment)}</span><span className={adjustmentTone(row.analystScoreAdjustment)}>analyst {signedNumber(row.analystScoreAdjustment)}</span><span className={adjustmentTone(row.technicalScoreAdjustment)}>tech {signedNumber(row.technicalScoreAdjustment)}</span></div> },
            { key: 'scoreGap', label: 'Gap', className: 'right', render: (row) => row.scoreGap === undefined ? '-' : row.scoreGap <= 0 ? <Pill tone="good">PASS</Pill> : row.scoreGap <= 5 ? <Pill tone="warn">{row.scoreGap}</Pill> : row.scoreGap },
            { key: 'bestScore', label: 'Best', className: 'right' },
            { key: 'count', label: 'Seen', className: 'right' },
            { key: 'topReason', label: 'Top blocker', className: 'reason', render: (row) => <Reason>{row.topReason}</Reason> }
          ]}
          rows={data.buyLab?.items || []}
          loading={loadingKeys.buyLab}
        />
      </Card>

      <Card title="Консенсус аналитиков" icon={BarChart3} help="Официальный консенсус-прогноз T-Invest API: рекомендации инвестдомов, целевая цена и потенциальный апсайд. Сейчас дает небольшую ограниченную поправку к score-buy.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'recommendation', label: 'Rec', render: (row) => <Pill tone={recTone(row.recommendation)}>{row.recommendation}</Pill> },
            { key: 'currentPrice', label: 'Price', className: 'right', render: (row) => money(row.currentPrice) },
            { key: 'targetPrice', label: 'Target', className: 'right', render: (row) => money(row.targetPrice) },
            { key: 'priceChangePercent', label: 'Upside', className: 'right', render: (row) => percent(row.priceChangePercent) },
            { key: 'targetCount', label: 'Analysts', className: 'right' },
            { key: 'split', label: 'B/H/S', className: 'right', render: (row) => `${row.buyCount ?? 0}/${row.holdCount ?? 0}/${row.sellCount ?? 0}` }
          ]}
          rows={data.analystForecasts?.items || []}
          loading={loadingKeys.analystForecasts}
        />
      </Card>

      <Card title="Теханализ API" icon={LineChart} help="Официальные индикаторы T-Invest API: RSI, SMA/EMA, MACD и Bollinger Bands. Сейчас дает небольшую ограниченную поправку к score-buy.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'rsi14', label: 'RSI14', className: 'right', render: (row) => money(row.rsi14) },
            { key: 'rsiState', label: 'RSI', render: (row) => <Pill tone={signalTone(row.rsiState)}>{row.rsiState}</Pill> },
            { key: 'sma20', label: 'SMA20', className: 'right', render: (row) => money(row.sma20) },
            { key: 'ema20', label: 'EMA20', className: 'right', render: (row) => money(row.ema20) },
            { key: 'macdState', label: 'MACD', render: (row) => <Pill tone={signalTone(row.macdState)}>{row.macdState}</Pill> },
            { key: 'bb', label: 'BB', className: 'right', render: (row) => `${money(row.bbLower)} / ${money(row.bbUpper)}` }
          ]}
          rows={data.techAnalysis?.items || []}
          loading={loadingKeys.techAnalysis}
        />
      </Card>

      <Card title="Доказательства стратегий" icon={BarChart3} help="Накопленная статистика: как часто стратегия давала сигнал, сколько было бумажных позиций и какой результат. Это нужно, чтобы не верить стратегии на слово.">
        <Table
          columns={[
            { key: 'strategy', label: 'Strategy' },
            { key: 'type', label: 'Type' },
            { key: 'confidence', label: 'Conf', className: 'right' },
            { key: 'winRatePercent', label: 'WR', className: 'right', render: (row) => percent(row.winRatePercent) },
            { key: 'averageProfitPercent', label: 'Avg', className: 'right', render: (row) => percent(row.averageProfitPercent) },
            { key: 'status', label: 'Status', render: (row) => row.status ? <Pill tone={row.status === 'enough-data' ? 'good' : 'warn'}>{row.status}</Pill> : '-' },
            { key: 'note', label: 'Note', className: 'reason', render: (row) => <Reason>{row.note}</Reason> }
          ]}
          rows={data.strategy?.strategies || []}
          loading={loadingKeys.strategy}
        />
      </Card>
      <Card title="Проверка Пульса" icon={Users} help="Как вели себя бумаги после сигналов авторов через 1, 3, 5 и 10 дней. Пока данных мало, это скорее лаборатория, чем основание для автоторговли.">
        <div className="stats compact">
          {['1d', '3d', '5d', '10d'].map((key) => (
            <Stat
              key={key}
              label={key}
              value={`${percent(socialSummary[key]?.avgActionReturnPercent)} / ${socialSummary[key]?.count ?? 0}`}
              tone={(socialSummary[key]?.avgActionReturnPercent || 0) >= 0 ? 'good' : 'bad'}
            />
          ))}
        </div>
        <Table
          columns={[
            { key: 'observedAt', label: 'Time', render: (row) => time(row.observedAt) },
            { key: 'actorName', label: 'Actor', render: (row) => row.actorName || row.actorKey },
            { key: 'ticker', label: 'Ticker' },
            { key: 'action', label: 'Action' },
            { key: 'actionReturn1dPercent', label: '1d', className: 'right', render: (row) => percent(row.actionReturn1dPercent) },
            { key: 'status', label: 'Status' }
          ]}
          rows={data.socialEvidence?.rows || []}
          loading={loadingKeys.socialEvidence}
        />
      </Card>
    </div>
  );
}

function RiskControls({ data, onRiskSettingsChange }) {
  const config = data.status?.config || {};
  const limits = data.limits?.limits || [];
  const tradeLimit = limits.find((limit) => limit.mode === 'trade') || limits[0];
  const maxOrderRub = Number(config.maxOrderRub || 0);
  const maxDailyOrders = Number(config.maxDailyOrders || 0);
  const maxDailyRub = Number(config.maxDailyRub || 0);

  return (
    <Card title="Лимиты риска" icon={ShieldCheck} help="Меняет реальные лимиты робота без перезапуска. Max order - потолок одной заявки, daily orders - сколько заявок за день, daily RUB - общий дневной бюджет.">
      <div className="stats compact">
        <Stat label="Max order" value={`${money(maxOrderRub)} RUB`} />
        <Stat label="Daily orders" value={maxDailyOrders} />
        <Stat label="Daily RUB" value={`${money(maxDailyRub)} RUB`} />
        <Stat label="Left today" value={tradeLimit ? `${tradeLimit.ordersLeft} / ${money(tradeLimit.rubLeft)} RUB` : '-'} />
      </div>
      <div className="control-row">
        {[500, 1000, 1500, 2500].map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxOrderRub && 'active')}
            onClick={() => onRiskSettingsChange({ maxOrderRub: value, maxDailyOrders, maxDailyRub })}
            title="Поменять максимальный размер одной заявки."
          >
            order {value}
          </button>
        ))}
      </div>
      <div className="control-row">
        {[1, 3, 5, 10].map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxDailyOrders && 'active')}
            onClick={() => onRiskSettingsChange({ maxOrderRub, maxDailyOrders: value, maxDailyRub })}
            title="Поменять максимум заявок за день."
          >
            {value} orders
          </button>
        ))}
      </div>
      <div className="control-row">
        {[500, 1500, 3000, 5000].map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxDailyRub && 'active')}
            onClick={() => onRiskSettingsChange({ maxOrderRub, maxDailyOrders, maxDailyRub: value })}
            title="Поменять общий дневной бюджет."
          >
            day {value}
          </button>
        ))}
      </div>
    </Card>
  );
}

function Accounts({ data, loadingKeys, onModeChange, onLiveSellToggle, onRiskSettingsChange }) {
  const liveActions = data.status?.config?.liveAllowedActions || [];
  const sellArmed = liveActions.includes('sell');

  return (
    <div className="grid">
      <Card title="Live действия" icon={ShieldCheck} help="Боевые действия робота. Buy уже включен. Sell можно включить отдельно, но он все равно продаст только robot-owned лоты, которые сам ранее купил и записал в журнал.">
        <div className="readiness">
          <Pill tone={sellArmed ? 'bad' : 'good'}>{sellArmed ? 'SELL ARMED' : 'SELL OFF'}</Pill>
          <span>{liveActions.join(', ') || '-'}</span>
        </div>
        <div className="card-actions">
          <button
            className={cls('mini-button', sellArmed ? '' : 'danger')}
            onClick={() => onLiveSellToggle(!sellArmed)}
            title={sellArmed ? 'Выключить реальные продажи' : 'Включить реальные продажи только для robot-owned лотов'}
          >
            {sellArmed ? 'Disarm sell' : 'Arm sell'}
          </button>
        </div>
      </Card>
      <RiskControls data={data} onRiskSettingsChange={onRiskSettingsChange} />
      <Card title="Счета" icon={Database} help="Кнопка меняет режим счета без перезапуска робота. Protected-счет можно перевести в trade только после отдельного подтверждения номером счета.">
        <Table
          columns={[
            { key: 'alias', label: 'Account', render: (row) => <><strong>{row.alias || row.accountId}</strong><div className="muted">{row.accountId}</div></> },
            {
              key: 'mode',
              label: 'Mode',
              render: (row) => <>
                <Pill tone={row.mode === 'trade' ? 'bad' : 'neutral'}>{row.mode}</Pill>
                {row.overrideMode ? <div className="muted">override: {row.overrideMode}</div> : null}
              </>
            },
            { key: 'cashRub', label: 'Cash', className: 'right', render: (row) => money(row.cashRub) },
            { key: 'totalRub', label: 'Total', className: 'right', render: (row) => money(row.totalRub) },
            { key: 'positionsCount', label: 'Positions', className: 'right' },
            {
              key: 'actions',
              label: 'Action',
              render: (row) => row.protected && row.mode !== 'trade'
                ? <button
                    className="mini-button danger"
                    onClick={() => onModeChange(row.accountId, 'trade', { protected: true })}
                    title="Разрешить роботу торговать на защищенном счете после подтверждения"
                  >
                    Arm trade
                  </button>
                : <button
                    className="mini-button"
                    onClick={() => onModeChange(row.accountId, row.mode === 'trade' ? 'observe' : 'trade')}
                    title={row.mode === 'trade' ? 'Перевести счет в режим наблюдения' : 'Разрешить роботу торговать на этом счете'}
                  >
                    {row.mode === 'trade' ? 'To observe' : 'To trade'}
                  </button>
            }
          ]}
          rows={data.accounts?.accounts || []}
          loading={loadingKeys.accounts}
        />
      </Card>
      <Card title="Позиции" icon={LineChart} help="Текущие позиции по всем счетам. P/L здесь считается от средней цены позиции к текущей цене из брокерского API.">
        <Table
          columns={[
            { key: 'accountAlias', label: 'Account' },
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'quantityLots', label: 'Lots', className: 'right' },
            { key: 'averagePrice', label: 'Average', className: 'right', render: (row) => money(row.averagePrice) },
            { key: 'currentPrice', label: 'Current', className: 'right', render: (row) => money(row.currentPrice) },
            { key: 'profitPercent', label: 'P/L', className: 'right', render: (row) => percent(row.profitPercent) }
          ]}
          rows={data.positions?.positions || []}
          loading={loadingKeys.positions}
        />
      </Card>
    </div>
  );
}

const decisionStatusTone = (status) => {
  if (status === 'order-posted') return 'good';
  if (status === 'order-failed') return 'bad';
  if (status === 'skip') return 'neutral';
  return 'warn';
};

const isCriticalDecision = (row) => (
  row.status === 'skip' && ['stop-loss', 'profit-take', 'trailing-stop'].includes(row.signalSource)
);

const toDecisionView = (row) => ({
  ...row,
  // Missing ticker/signal/account values are already absent in /api/decisions.
  // TODO: trace whether they are lost at decision creation or DB mapping; UI must not infer them.
  accountAlias: display(row.accountAlias),
  ticker: display(row.ticker),
  signalSource: display(row.signalSource)
});

const sortDecisions = (rows, sort) => {
  const copy = [...rows];
  if (sort === 'oldest') return copy.reverse();
  if (sort === 'pnl-desc') return copy.sort((a, b) => Number(b.profitPercent ?? -Infinity) - Number(a.profitPercent ?? -Infinity));
  if (sort === 'pnl-asc') return copy.sort((a, b) => Number(a.profitPercent ?? Infinity) - Number(b.profitPercent ?? Infinity));
  return copy;
};

function LogFilters({ rows, filters, onChange }) {
  const statuses = [...new Set(rows.map((row) => row.status).filter(Boolean))].sort();
  const signals = [...new Set(rows.map((row) => row.signalSource).filter(Boolean))].sort();

  return (
    <div className="filters">
      <label>
        <span>Статус</span>
        <select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}>
          <option value="all">Все</option>
          {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label>
      <label>
        <span>Сигнал</span>
        <select value={filters.signal} onChange={(event) => onChange({ ...filters, signal: event.target.value })}>
          <option value="all">Все</option>
          {signals.map((signal) => <option key={signal} value={signal}>{signal}</option>)}
        </select>
      </label>
      <label>
        <span>Тикер</span>
        <input value={filters.ticker} onChange={(event) => onChange({ ...filters, ticker: event.target.value.toUpperCase() })} placeholder="SBER" />
      </label>
      <label>
        <span>P/L</span>
        <select value={filters.pnl} onChange={(event) => onChange({ ...filters, pnl: event.target.value })}>
          <option value="all">Любой</option>
          <option value="profit">Плюс</option>
          <option value="loss">Минус</option>
          <option value="empty">Нет</option>
        </select>
      </label>
      <label>
        <span>Сортировка</span>
        <select value={filters.sort} onChange={(event) => onChange({ ...filters, sort: event.target.value })}>
          <option value="newest">Новые</option>
          <option value="oldest">Старые</option>
          <option value="pnl-desc">P/L выше</option>
          <option value="pnl-asc">P/L ниже</option>
        </select>
      </label>
    </div>
  );
}

function TradeReview({ data, loading }) {
  const trades = data.trades?.trades || [];
  const events = data.robotPositions?.events || [];
  const decisions = data.decisions?.decisions || [];
  const lastOrderDecisionByTicker = new Map(
    decisions
      .filter((decision) => decision.ticker && decision.status === 'order-posted')
      .map((decision) => [decision.ticker, decision])
  );

  const rows = trades.slice(0, 20).map((trade) => {
    const event = events.find((item) => item.orderId && item.orderId === trade.orderId);
    const decision = lastOrderDecisionByTicker.get(trade.ticker);
    return {
      ...trade,
      ledgerStatus: event ? 'в ledger' : 'только broker',
      decisionReason: decision?.reason,
      signalSource: decision?.signalSource,
      tradePrice: moneyParts(trade.executedPriceUnits ?? trade.price_units, trade.executedPriceNano ?? trade.price_nano),
      tradeAmount: moneyParts(trade.totalAmountUnits, trade.totalAmountNano),
      createdAt: trade.tradeDateTime || trade.createdAt
    };
  });

  return (
    <Card title="Разбор сделок" icon={Database} help="Последние реальные сделки из брокера плюс связь с внутренним ledger. Если сделка есть у брокера, но не попала в ledger, это отдельный повод смотреть reconciliation.">
      <Table
        className="trade-review-table"
        columns={[
          { key: 'createdAt', label: 'Время', width: '150px', render: (row) => time(row.createdAt) },
          { key: 'ticker', label: 'Тикер', width: '90px', render: (row) => <TextCell>{row.ticker}</TextCell> },
          { key: 'side', label: 'Сторона', width: '90px', render: (row) => <Pill tone={row.direction === 'buy' ? 'good' : 'bad'}>{display(row.direction)}</Pill> },
          { key: 'quantityLots', label: 'Лоты', width: '70px', className: 'right', render: (row) => money(row.lotsExecuted ?? row.lotsRequested ?? row.lot) },
          { key: 'price', label: 'Цена', width: '90px', className: 'right', render: (row) => money(row.tradePrice) },
          { key: 'amount', label: 'Сумма', width: '95px', className: 'right', render: (row) => money(row.tradeAmount) },
          { key: 'ledgerStatus', label: 'Ledger', width: '115px', render: (row) => <Pill tone={row.ledgerStatus === 'в ledger' ? 'good' : 'warn'}>{row.ledgerStatus}</Pill> },
          { key: 'decisionReason', label: 'Решение', className: 'reason', render: (row) => <Reason>{row.decisionReason || row.status || EMPTY}</Reason> }
        ]}
        rows={rows}
        empty="Сделок пока нет"
        loading={loading}
      />
    </Card>
  );
}

function Logs({ data, loadingKeys }) {
  const [filters, setFilters] = useState({ status: 'all', signal: 'all', ticker: '', pnl: 'all', sort: 'newest' });
  const decisions = (data.decisions?.decisions || []).map(toDecisionView);
  const filteredDecisions = sortDecisions(decisions.filter((row) => {
    const pnl = Number(row.profitPercent);
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.signal !== 'all' && row.signalSource !== filters.signal) return false;
    if (filters.ticker && !String(row.ticker).includes(filters.ticker)) return false;
    if (filters.pnl === 'profit' && !(Number.isFinite(pnl) && pnl > 0)) return false;
    if (filters.pnl === 'loss' && !(Number.isFinite(pnl) && pnl < 0)) return false;
    if (filters.pnl === 'empty' && Number.isFinite(pnl)) return false;
    return true;
  }), filters.sort);

  return (
    <div className="grid">
      <Card title="Последние решения" icon={Eye} className="wide" help="Журнал решений робота: что он рассматривал, какой сигнал увидел, что разрешили/запретили фильтры и почему. Пустые значения показываются как —, фронт их не угадывает.">
        <LogFilters rows={decisions} filters={filters} onChange={setFilters} />
        <Table
          className="decision-table"
          rowClassName={(row) => cls(isCriticalDecision(row) && 'decision-critical')}
          columns={[
            { key: 'createdAt', label: 'Время', width: '155px', render: (row) => time(row.createdAt) },
            { key: 'accountAlias', label: 'Счет', width: '170px', render: (row) => <TextCell>{row.accountAlias}</TextCell> },
            { key: 'ticker', label: 'Тикер', width: '92px', render: (row) => <TextCell>{row.ticker}</TextCell> },
            { key: 'signalSource', label: 'Сигнал', width: '130px', render: (row) => <TextCell>{row.signalSource}</TextCell> },
            { key: 'status', label: 'Статус', width: '112px', render: (row) => <Pill tone={decisionStatusTone(row.status)}>{display(row.status)}</Pill> },
            { key: 'profitPercent', label: 'P/L', width: '84px', className: 'right', render: (row) => percent(row.profitPercent) },
            { key: 'reason', label: 'Причина', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={filteredDecisions}
          empty="Нет решений под выбранные фильтры"
          loading={loadingKeys.decisions}
        />
      </Card>
      <TradeReview data={data} loading={loadingKeys.trades || loadingKeys.robotPositions} />
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const { data, loading, loadingKeys, error, updatedAt, reload } = useDashboardData(activeTab);
  const [actionError, setActionError] = useState('');
  const active = useMemo(() => tabs.find((tab) => tab.id === activeTab) || tabs[0], [activeTab]);
  const updateAccountMode = async (accountId, mode, options = {}) => {
    setActionError('');
    let confirmation;

    if (options.protected && mode === 'trade') {
      confirmation = window.prompt(`Это protected-счет. Чтобы включить trade, введи номер счета: ${accountId}`);
      if (confirmation !== accountId) {
        setActionError('Protected trade was not confirmed');
        return;
      }
    }

    const response = await fetch('/api/admin/account-mode', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'account-mode'
      },
      body: JSON.stringify({
        accountId,
        mode,
        allowProtectedTrade: Boolean(options.protected),
        confirmation
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error || `HTTP ${response.status}`;
      setActionError(message);
      return;
    }

    await reload();
  };
  const updateLiveSell = async (enabled) => {
    setActionError('');
    let confirmation;
    const currentActions = data.status?.config?.liveAllowedActions || ['buy'];
    const actions = enabled
      ? [...new Set([...currentActions, 'buy', 'sell'])]
      : currentActions.filter((action) => action !== 'sell');

    if (enabled) {
      confirmation = window.prompt('Чтобы включить реальные продажи, введи SELL');
      if (confirmation !== 'SELL') {
        setActionError('Live sell was not armed');
        return;
      }
    }

    const response = await fetch('/api/admin/live-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'live-actions'
      },
      body: JSON.stringify({
        actions,
        confirmation
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setActionError(payload.error || `HTTP ${response.status}`);
      return;
    }

    await reload();
  };
  const updateMarketRegime = async (minHealthPercent, minAvgTrendPercent) => {
    setActionError('');
    const response = await fetch('/api/admin/market-regime', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'market-regime'
      },
      body: JSON.stringify({
        minHealthPercent,
        minAvgTrendPercent
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setActionError(payload.error || `HTTP ${response.status}`);
      return;
    }

    await reload();
  };
  const updateRiskSettings = async (settings) => {
    setActionError('');
    const response = await fetch('/api/admin/risk-settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'risk-settings'
      },
      body: JSON.stringify(settings)
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setActionError(payload.error || `HTTP ${response.status}`);
      return;
    }

    await reload();
  };

  const content = {
    overview: <Overview data={data} loadingKeys={loadingKeys} onMarketRegimeChange={updateMarketRegime} />,
    buy: <Buy data={data} loadingKeys={loadingKeys} />,
    social: <Social data={data} loadingKeys={loadingKeys} />,
    evidence: <Evidence data={data} loadingKeys={loadingKeys} />,
    accounts: <Accounts data={data} loadingKeys={loadingKeys} onModeChange={updateAccountMode} onLiveSellToggle={updateLiveSell} onRiskSettingsChange={updateRiskSettings} />,
    sell: <Sell data={data} loadingKeys={loadingKeys} />,
    logs: <Logs data={data} loadingKeys={loadingKeys} />
  }[active.id];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Bot size={22} /></div>
          <div>
            <strong>T-Invest Robot</strong>
            <span>панель управления</span>
          </div>
        </div>
        <nav>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} className={cls('nav-btn', activeTab === tab.id && 'active')} onClick={() => setActiveTab(tab.id)}>
                <Icon size={18} />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <h1>{active.label}</h1>
            <p>{loading ? `Загрузка API: ${Object.values(loadingKeys).filter(Boolean).length}` : error || `Обновлено ${updatedAt ? updatedAt.toLocaleTimeString('ru-RU') : EMPTY}`}</p>
          </div>
          <button className="icon-button" onClick={() => void reload()} title="Обновить">
            <RefreshCw size={18} />
            Обновить
          </button>
        </header>
        {error ? <div className="error-banner"><AlertTriangle size={18} />{error}</div> : null}
        {actionError ? <div className="error-banner"><AlertTriangle size={18} />{actionError}</div> : null}
        {content}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
