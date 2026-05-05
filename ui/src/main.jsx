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
  decisions: '/api/decisions?limit=60',
  positions: '/api/positions',
  paper: '/api/paper-positions?limit=60',
  market: '/api/market-regime',
  strategy: '/api/strategy-evidence',
  socialSignals: '/api/social-signals?limit=80',
  socialCollector: '/api/social-collector',
  socialConsensus: '/api/social-consensus',
  socialEvidence: '/api/social-evidence?limit=80',
  sellBrain: '/api/sell-brain',
  buyScan: '/api/buy-scan'
};

const endpointGroups = {
  core: ['status', 'limits', 'performance', 'paper', 'socialCollector'],
  overview: ['preview', 'market'],
  signals: ['buyScan', 'sellBrain'],
  social: ['socialConsensus', 'socialSignals', 'socialCollector'],
  evidence: ['strategy', 'socialEvidence'],
  accounts: ['accounts', 'positions'],
  logs: ['decisions']
};

const tabs = [
  { id: 'overview', label: 'Обзор', icon: Activity },
  { id: 'signals', label: 'Сигналы', icon: Signal },
  { id: 'social', label: 'Пульс', icon: Users },
  { id: 'evidence', label: 'Проверка', icon: BarChart3 },
  { id: 'accounts', label: 'Счета', icon: Database },
  { id: 'logs', label: 'Журнал', icon: Eye }
];

const money = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value));
};

const percent = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '-';
  const sign = Number(value) > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(2)}%`;
};

const time = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('ru-RU');
};

const cls = (...names) => names.filter(Boolean).join(' ');

const Pill = ({ tone = 'neutral', children }) => (
  <span className={cls('pill', tone)}>{children}</span>
);

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

const Table = ({ columns, rows, empty = 'No data' }) => (
  <div className="table-wrap">
    <table>
      <thead>
        <tr>{columns.map((column) => <th key={column.key} className={column.className}>{column.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows?.length ? rows.map((row, index) => (
          <tr key={row.id || `${row.ticker || row.accountId || 'row'}-${index}`}>
            {columns.map((column) => <td key={column.key} className={column.className}>{column.render ? column.render(row) : row[column.key]}</td>)}
          </tr>
        )) : (
          <tr><td colSpan={columns.length} className="empty">{empty}</td></tr>
        )}
      </tbody>
    </table>
  </div>
);

const useDashboardData = (activeTab) => {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const activeTabRef = useRef(activeTab);

  const load = async (keys) => {
    setError('');
    try {
      const uniqueKeys = [...new Set(keys)];
      const entries = await Promise.all(uniqueKeys.map(async (key) => {
        const url = endpoints[key];
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return [key, await response.json()];
      }));
      setData((current) => ({ ...current, ...Object.fromEntries(entries) }));
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
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

  return { data, loading, error, updatedAt, reload: loadActiveTab };
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
  if (socialCollector && !socialCollector.ok) blockers.push('social collector waiting');

  return blockers;
};

function Overview({ data }) {
  const blockers = getReadiness(data);
  const status = data.status;
  const social = data.socialCollector;
  const paper = data.paper?.summary;

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

      <Card title="Можно / нельзя" icon={ShieldCheck} help="Предпросмотр покупки по торговому счету. Здесь видно, что робот хотел бы купить, по какой цене и почему сделка разрешена или заблокирована.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
            { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'allowed' ? 'good' : 'warn'}>{row.status}</Pill> },
            { key: 'currentPrice', label: 'Price', className: 'right', render: (row) => money(row.currentPrice) },
            { key: 'estimatedOrderRub', label: 'Amount', className: 'right', render: (row) => money(row.estimatedOrderRub) },
            { key: 'reason', label: 'Reason', className: 'reason' }
          ]}
          rows={data.preview?.previews || []}
        />
      </Card>

      <Card title="Портфель" icon={LineChart} help="Бумажная торговля и социальный сборщик. Это не реальные заявки, а контроль качества идей и сигналов.">
        <div className="stats">
          <Stat label="Paper open" value={paper?.open ?? '-'} />
          <Stat label="Paper P/L" value={`${money(paper?.totalProfitRub)} RUB`} tone={(paper?.totalProfitRub || 0) >= 0 ? 'good' : 'bad'} />
          <Stat label="Social profiles" value={`${social?.health?.activeProfiles || 0} / ${social?.config?.configuredProfiles || 0}`} />
          <Stat label="Social signals" value={social?.signals?.signals ?? '-'} />
        </div>
      </Card>

      <Card title="Режим рынка" icon={Activity} help="Фильтр общего настроения рынка. Если базовые бумаги выглядят плохо, робот может не покупать даже хорошего кандидата.">
        <div className="readiness">
          <Pill tone={data.market?.passed ? 'good' : 'bad'}>{data.market?.passed ? 'PASSED' : 'BLOCKED'}</Pill>
          <span>{data.market?.reason}</span>
        </div>
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'trendPercent', label: 'Trend', className: 'right', render: (row) => percent(row.trendPercent) },
            { key: 'passed', label: 'Passed', render: (row) => <Pill tone={row.passed ? 'good' : 'warn'}>{String(row.passed)}</Pill> }
          ]}
          rows={data.market?.items || []}
        />
      </Card>
    </div>
  );
}

function Signals({ data }) {
  return (
    <div className="grid">
      <Card title="Кандидаты на покупку" icon={Signal} help="Оценка бумаг из текущего списка наблюдения. Score 70/100 и выше обычно считается проходным, но дальше все равно идут лимиты и риск-фильтры.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Score', className: 'right' },
            { key: 'lastPrice', label: 'Price', className: 'right', render: (row) => money(row.lastPrice) },
            { key: 'passed', label: 'Result', render: (row) => <Pill tone={row.passed ? 'good' : 'warn'}>{row.passed ? 'PASS' : 'WAIT'}</Pill> },
            { key: 'reason', label: 'Reason', className: 'reason' }
          ]}
          rows={data.buyScan?.items || []}
        />
      </Card>
      <Card title="Продажи" icon={AlertTriangle} help="Мозг продаж смотрит позиции на всех счетах. На наблюдаемых счетах он только пишет мнение, на торговом сможет продавать позже, когда мы это явно включим.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'accountAlias', label: 'Account' },
            { key: 'source', label: 'Signal' },
            { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'allowed' ? 'bad' : row.status === 'dry-run' ? 'warn' : 'neutral'}>{row.status}</Pill> },
            { key: 'profitPercent', label: 'P/L', className: 'right', render: (row) => percent(row.profitPercent) },
            { key: 'reason', label: 'Reason', className: 'reason' }
          ]}
          rows={data.sellBrain?.items || []}
        />
      </Card>
    </div>
  );
}

function Social({ data }) {
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
            { key: 'reason', label: 'Reason', className: 'reason' }
          ]}
          rows={data.socialConsensus?.items || []}
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
            { key: 'reason', label: 'Reason', className: 'reason' }
          ]}
          rows={data.socialSignals?.signals || []}
        />
      </Card>
    </div>
  );
}

function Evidence({ data }) {
  const socialSummary = data.socialEvidence?.summary || {};
  return (
    <div className="grid">
      <Card title="Доказательства стратегий" icon={BarChart3} help="Накопленная статистика: как часто стратегия давала сигнал, сколько было бумажных позиций и какой результат. Это нужно, чтобы не верить стратегии на слово.">
        <Table
          columns={[
            { key: 'strategy', label: 'Strategy' },
            { key: 'type', label: 'Type' },
            { key: 'confidence', label: 'Conf', className: 'right' },
            { key: 'winRatePercent', label: 'WR', className: 'right', render: (row) => percent(row.winRatePercent) },
            { key: 'averageProfitPercent', label: 'Avg', className: 'right', render: (row) => percent(row.averageProfitPercent) },
            { key: 'status', label: 'Status', render: (row) => row.status ? <Pill tone={row.status === 'enough-data' ? 'good' : 'warn'}>{row.status}</Pill> : '-' },
            { key: 'note', label: 'Note', className: 'reason' }
          ]}
          rows={data.strategy?.strategies || []}
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
        />
      </Card>
    </div>
  );
}

function Accounts({ data }) {
  return (
    <div className="grid">
      <Card title="Счета" icon={Database} help="Торговый счет - единственный, где робот может размещать заявки. Остальные счета только наблюдаются и помогают проверять логику продаж.">
        <Table
          columns={[
            { key: 'alias', label: 'Account', render: (row) => <><strong>{row.alias || row.accountId}</strong><div className="muted">{row.accountId}</div></> },
            { key: 'mode', label: 'Mode', render: (row) => <Pill tone={row.mode === 'trade' ? 'bad' : 'neutral'}>{row.mode}</Pill> },
            { key: 'cashRub', label: 'Cash', className: 'right', render: (row) => money(row.cashRub) },
            { key: 'totalRub', label: 'Total', className: 'right', render: (row) => money(row.totalRub) },
            { key: 'positionsCount', label: 'Positions', className: 'right' }
          ]}
          rows={data.accounts?.accounts || []}
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
        />
      </Card>
    </div>
  );
}

function Logs({ data }) {
  return (
    <div className="grid">
      <Card title="Последние решения" icon={Eye} help="Журнал решений робота: что он рассматривал, какой сигнал увидел, что разрешили/запретили фильтры и почему.">
        <Table
          columns={[
            { key: 'createdAt', label: 'Time', render: (row) => time(row.createdAt) },
            { key: 'accountAlias', label: 'Account' },
            { key: 'ticker', label: 'Ticker' },
            { key: 'signalSource', label: 'Signal' },
            { key: 'status', label: 'Status', render: (row) => <Pill tone={row.status === 'order-posted' ? 'good' : row.status === 'skip' ? 'neutral' : 'warn'}>{row.status}</Pill> },
            { key: 'profitPercent', label: 'P/L', className: 'right', render: (row) => percent(row.profitPercent) },
            { key: 'reason', label: 'Reason', className: 'reason' }
          ]}
          rows={data.decisions?.decisions || []}
        />
      </Card>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const { data, loading, error, updatedAt, reload } = useDashboardData(activeTab);
  const active = useMemo(() => tabs.find((tab) => tab.id === activeTab) || tabs[0], [activeTab]);

  const content = {
    overview: <Overview data={data} />,
    signals: <Signals data={data} />,
    social: <Social data={data} />,
    evidence: <Evidence data={data} />,
    accounts: <Accounts data={data} />,
    logs: <Logs data={data} />
  }[active.id];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Bot size={22} /></div>
          <div>
            <strong>T-Invest Robot</strong>
            <span>control room</span>
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
            <p>{loading ? 'Loading robot telemetry...' : error || `Updated ${updatedAt ? updatedAt.toLocaleTimeString('ru-RU') : '-'}`}</p>
          </div>
          <button className="icon-button" onClick={() => void reload()} title="Refresh">
            <RefreshCw size={18} />
            Refresh
          </button>
        </header>
        {error ? <div className="error-banner"><AlertTriangle size={18} />{error}</div> : null}
        {content}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
