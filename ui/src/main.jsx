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
  trades: '/api/trades?limit=80',
  orderSafety: '/api/order-safety?limit=80'
};

const endpointGroups = {
  core: ['status', 'limits', 'performance', 'paper', 'socialCollector'],
  overview: ['market', 'orderSafety'],
  buy: ['dailyBuyList', 'preview', 'buyRecommendations', 'buyScan'],
  social: ['socialConsensus', 'socialSignals', 'socialCollector'],
  evidence: ['market', 'marketLab', 'buyLab', 'analystForecasts', 'techAnalysis', 'strategy', 'socialEvidence'],
  accounts: ['accounts', 'positions'],
  sell: ['sellBrain', 'positions', 'robotPositions'],
  logs: ['decisions', 'trades', 'robotPositions', 'orderSafety']
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

const tabExists = (id) => tabs.some((tab) => tab.id === id);

const getInitialTab = () => {
  const hashTab = window.location.hash.replace('#', '');
  return tabExists(hashTab) ? hashTab : 'overview';
};

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

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const ScoreBreakdown = ({ analysis }) => {
  const factors = analysis?.factors || {};
  const items = [
    { key: 'base', label: 'База', value: factors.baseScore, title: 'Базовый score: тренд, momentum, откат от хая, волатильность и объем.', base: true },
    { key: 'social', label: 'Пульс', value: factors.socialScoreAdjustment, title: 'Поправка от выбранных успешных авторов Пульса.' },
    { key: 'analyst', label: 'Аналит.', value: factors.analystScoreAdjustment, title: 'Поправка от консенсус-прогноза аналитиков T-Invest.' },
    { key: 'tech', label: 'Тех.', value: factors.technicalScoreAdjustment, title: 'Поправка от официальных индикаторов T-Invest: RSI, MACD и средние.' }
  ];

  if (!analysis) return EMPTY;
  const score = Number(analysis.score ?? 0);

  return (
    <div className="score-card" title={analysis.reason}>
      <div className="score-main">
        <strong>{analysis.score ?? '-'}</strong>
        <span>итоговый score</span>
        <div className="score-bar"><i style={{ width: `${clamp(score, 0, 100)}%` }} /></div>
      </div>
      <div className="score-components">
        {items.map((item) => (
          <span key={item.key} className={adjustmentTone(item.value)} title={item.title}>
            <b>{item.label}</b>
            <em>{item.base ? (item.value ?? '-') : signedNumber(item.value)}</em>
          </span>
        ))}
      </div>
    </div>
  );
};

const ExecutionDecision = ({ status, reason }) => {
  const allowed = status === 'allowed';
  return (
    <div className="decision-stack" title={reason || status || EMPTY}>
      <Pill tone={allowed ? 'good' : 'warn'}>{allowed ? 'READY' : 'BLOCKED'}</Pill>
      <span>{allowed ? 'заявка разрешена' : 'блок до заявки'}</span>
    </div>
  );
};

const ScoreSummary = ({ score, base, social, analyst, technical }) => {
  const normalizedScore = Number(score ?? 0);
  const items = [
    { key: 'base', label: 'База', value: base, base: true },
    { key: 'social', label: 'Пульс', value: social },
    { key: 'analyst', label: 'Аналит.', value: analyst },
    { key: 'tech', label: 'Тех.', value: technical }
  ];

  return (
    <div className="score-card compact-score">
      <div className="score-main">
        <strong>{score ?? '-'}</strong>
        <span>score</span>
        <div className="score-bar"><i style={{ width: `${clamp(normalizedScore, 0, 100)}%` }} /></div>
      </div>
      <div className="score-components">
        {items.map((item) => (
          <span key={item.key} className={adjustmentTone(item.value)}>
            <b>{item.label}</b>
            <em>{item.base ? (item.value ?? '-') : signedNumber(item.value)}</em>
          </span>
        ))}
      </div>
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

const classifyBlocker = (reason) => {
  const text = String(reason || '').toLowerCase();
  if (text.includes('already in portfolio')) return 'уже в портфеле';
  if (text.includes('daily order limit')) return 'дневной лимит';
  if (text.includes('market regime')) return 'рыночный фильтр';
  if (text.includes('normal trading status')) return 'статус торгов';
  if (text.includes('score-buy blocked')) return 'score ниже порога';
  if (text.includes('cash')) return 'денег не хватает';
  if (text.includes('open buy order')) return 'есть открытая заявка';
  return reason || EMPTY;
};

const summarizeBlockers = (rows) => {
  if (!rows.length) return EMPTY;

  const counts = rows.reduce((acc, row) => {
    const key = classifyBlocker(row.reason);
    acc.set(key, (acc.get(key) || 0) + 1);
    return acc;
  }, new Map());

  return [...counts.entries()]
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
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

const getTradeLimit = (data) => {
  const limits = data.limits?.limits || [];
  return limits.find((limit) => limit.mode === 'trade') || limits[0];
};

const socialCollectorText = (social) => {
  if (!social) return 'loading';
  if (social.health?.pendingAuth > 0) return 'needs auth';
  if (social.health?.staleProfiles > 0) return `idle, ${social.health.staleProfiles} stale`;
  return 'fresh';
};

const stageTone = (blocked, warning = false) => {
  if (blocked) return 'bad';
  if (warning) return 'warn';
  return 'good';
};

const Pipeline = ({ steps }) => (
  <div className="pipeline">
    {steps.map((step, index) => (
      <div className="pipeline-step" key={step.label}>
        <div className="pipeline-node">
          <Pill tone={step.tone}>{step.status}</Pill>
          {index < steps.length - 1 ? <span className="pipeline-arrow">↓</span> : null}
        </div>
        <div className="pipeline-copy">
          <strong>{step.label}</strong>
          <span>{step.detail}</span>
        </div>
      </div>
    ))}
  </div>
);

const Checklist = ({ items }) => (
  <div className="checklist">
    {items.map((item) => (
      <div className="check-row" key={item.label}>
        <CheckCircle2 size={16} className={item.tone || 'neutral'} />
        <div>
          <strong>{item.label}</strong>
          <span>{item.detail}</span>
        </div>
        <Pill tone={item.tone}>{item.status}</Pill>
      </div>
    ))}
  </div>
);

const StageStrip = ({ items }) => (
  <div className="stage-strip">
    {items.map((item) => (
      <div className="stage-tile" key={item.label}>
        <span>{item.label}</span>
        <strong className={item.tone || ''}>{item.value}</strong>
        <small>{item.detail}</small>
      </div>
    ))}
  </div>
);

function MarketControls({ data, onMarketRegimeChange }) {
  const config = data.status?.config || {};
  const health = config.marketRegimeMinHealthPercent ?? 40;
  const trend = config.marketRegimeMinAvgTrendPercent ?? -1;

  return (
    <Card title="Пороги рыночного фильтра" icon={ShieldCheck} help="Это настройки допуска рынка, а не текущий результат. Required score - сколько базовых бумаг должно пройти фильтр. Required trend - насколько бумага может быть ниже своей 20-дневной средней.">
      <div className="settings-summary">
        <div>
          <span>Нужный score</span>
          <strong>{health}%</strong>
        </div>
        <div>
          <span>Мин. тренд</span>
          <strong>{trend}%</strong>
        </div>
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
    <Card title="Лаборатория рынка" icon={BarChart3} className="wide" help="Сравнение: какие покупки прошли бы при разных порогах health. Это не меняет настройки, только показывает последствия.">
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

function Overview({ data, onMarketRegimeChange }) {
  const blockers = getReadiness(data);
  const status = data.status;
  const social = data.socialCollector;
  const paper = data.paper?.summary;
  const market = data.market || {};
  const tradeLimit = getTradeLimit(data);
  const orderSafety = data.orderSafety?.summary || {};
  const liveActions = status?.config?.liveAllowedActions || [];
  const statusKnown = Boolean(status);
  const marketKnown = Boolean(data.market);
  const orderSafetyKnown = Boolean(data.orderSafety);
  const dryRun = statusKnown ? Boolean(status?.config?.dryRun) : false;
  const marketBlocked = Boolean(marketKnown && !market.passed);
  const dailyKnown = Boolean(tradeLimit);
  const dailyBlocked = Boolean(dailyKnown && (Number(tradeLimit.ordersLeft) <= 0 || Number(tradeLimit.rubLeft) <= 0));
  const unknownOrders = Number(orderSafety.unknown || 0);
  const openOrders = Number(orderSafety.open || 0);
  const socialNeedsAuth = Number(social?.health?.pendingAuth || 0) > 0;
  const socialStale = Number(social?.health?.staleProfiles || 0) > 0;
  const pipelineSteps = [
    {
      label: 'Сигналы',
      status: social ? socialNeedsAuth ? 'AUTH' : 'READY' : 'WAIT',
      tone: social ? stageTone(socialNeedsAuth, socialStale) : 'warn',
      detail: `${social?.health?.activeProfiles || 0}/${social?.config?.configuredProfiles || 0} Pulse profiles, ${social?.health?.staleProfiles || 0} stale`
    },
    {
      label: 'Рыночный фильтр',
      status: marketKnown ? market.passed ? 'PASS' : 'BLOCK' : 'WAIT',
      tone: marketKnown ? stageTone(marketBlocked) : 'warn',
      detail: `current ${market.measuredCount ? Math.round((Number(market.passedCount || 0) / Number(market.measuredCount || 1)) * 100) : EMPTY}%, required ${status?.config?.marketRegimeMinHealthPercent ?? EMPTY}%`
    },
    {
      label: 'Риск и лимиты',
      status: dailyKnown ? dailyBlocked ? 'BLOCK' : 'PASS' : 'WAIT',
      tone: dailyKnown ? stageTone(dailyBlocked) : 'warn',
      detail: tradeLimit ? `${tradeLimit.ordersLeft} orders left, ${money(tradeLimit.rubLeft)} RUB left` : 'limits loading'
    },
    {
      label: 'Исполнение',
      status: orderSafetyKnown ? unknownOrders ? 'UNKNOWN' : openOrders ? 'OPEN' : dryRun ? 'DRY' : 'LIVE' : 'WAIT',
      tone: orderSafetyKnown ? stageTone(unknownOrders, openOrders || dryRun) : 'warn',
      detail: `${openOrders} open orders, ${unknownOrders} unknown, actions: ${liveActions.join(', ') || EMPTY}`
    },
    {
      label: 'Результат',
      status: Number(paper?.totalProfitRub || 0) >= 0 ? 'PLUS' : 'MINUS',
      tone: Number(paper?.totalProfitRub || 0) >= 0 ? 'good' : 'bad',
      detail: `paper ${paper?.open ?? EMPTY} open, P/L ${money(paper?.totalProfitRub)} RUB`
    }
  ];
  const safetyItems = [
    {
      label: 'HTTP/API доступ',
      status: status ? 'OK' : 'WAIT',
      tone: status ? 'good' : 'warn',
      detail: status ? 'Dashboard получил runtime status через защищенный API.' : 'Ждем ответ /api/status.'
    },
    {
      label: 'Режим робота',
      status: statusKnown ? dryRun ? 'DRY RUN' : 'LIVE' : 'WAIT',
      tone: statusKnown ? dryRun ? 'warn' : 'good' : 'warn',
      detail: statusKnown ? dryRun ? 'Реальные заявки выключены.' : `Live actions: ${liveActions.join(', ') || EMPTY}.` : 'Ждем runtime config.'
    },
    {
      label: 'Рыночный фильтр',
      status: marketKnown ? market.passed ? 'PASSED' : 'BLOCKED' : 'WAIT',
      tone: marketKnown ? stageTone(marketBlocked) : 'warn',
      detail: market.reason || 'Рынок еще не рассчитан.'
    },
    {
      label: 'Дневные лимиты',
      status: dailyKnown ? dailyBlocked ? 'BLOCKED' : 'OK' : 'WAIT',
      tone: dailyKnown ? stageTone(dailyBlocked) : 'warn',
      detail: tradeLimit ? `${tradeLimit.ordersLeft} заявок, ${money(tradeLimit.rubLeft)} RUB осталось.` : 'Лимиты загружаются.'
    },
    {
      label: 'Unknown orders',
      status: orderSafetyKnown ? unknownOrders ? String(unknownOrders) : '0' : 'WAIT',
      tone: orderSafetyKnown ? stageTone(unknownOrders) : 'warn',
      detail: orderSafetyKnown ? unknownOrders ? 'Есть заявки с неизвестным статусом, повторять их нельзя.' : 'Неизвестных заявок нет.' : 'Ждем order safety API.'
    },
    {
      label: 'Social collector',
      status: socialCollectorText(social),
      tone: stageTone(socialNeedsAuth, socialStale),
      detail: socialNeedsAuth ? 'Нужны свежие cookie из расширения.' : 'Социальный сборщик не блокирует исполнение.'
    }
  ];

  return (
    <div className="grid overview-grid">
      <Card title="Движок Runtime" icon={Bot} help="Техническое состояние цикла робота: режим, тик, интервал и аварийные ошибки. Это не рыночный сигнал и не результат стратегии.">
        <div className="readiness">
          {!statusKnown ? <Pill tone="warn">LOADING</Pill> : blockers.length ? <Pill tone="bad">EXECUTION BLOCKED</Pill> : <Pill tone="good">READY</Pill>}
          <span>{!statusKnown ? 'waiting for runtime status' : blockers.length ? blockers.join(', ') : 'runtime ready, no active blockers'}</span>
        </div>
        <div className="stats">
          <Stat label="Mode" value={statusKnown ? status?.config?.dryRun ? 'DRY RUN' : 'LIVE' : EMPTY} tone={statusKnown ? status?.config?.dryRun ? 'warn' : 'good' : ''} />
          <Stat label="Tick" value={statusKnown ? status?.runtime?.isTickRunning ? 'running' : 'idle' : EMPTY} tone={statusKnown ? status?.runtime?.isTickRunning ? 'blue' : 'good' : ''} />
          <Stat label="Interval" value={`${status?.config?.intervalMs ? status.config.intervalMs / 1000 : '-'} sec`} />
          <Stat label="Errors" value={`${status?.runtime?.consecutiveTickErrors || 0} / ${status?.config?.maxConsecutiveTickErrors || '-'}`} />
        </div>
      </Card>

      <Card title="Цепочка решения" icon={Activity} className="control-card" help="Причинно-следственная цепочка: сигнал появился, рынок пропустил или заблокировал, риск-лимиты разрешили или нет, потом исполнение и результат.">
        <Pipeline steps={pipelineSteps} />
      </Card>

      <Card title="Рыночный фильтр" icon={Activity} help="Текущий расчет рынка. Current score - фактическая доля здоровых базовых бумаг. Required score - порог, который можно менять отдельно в блоке настроек.">
        <div className="readiness">
          <Pill tone={marketKnown ? market.passed ? 'good' : 'bad' : 'warn'}>{marketKnown ? market.passed ? 'PASSED' : 'BLOCKED' : 'WAIT'}</Pill>
          <span>{market.reason}</span>
        </div>
        <div className="stats compact">
          <Stat label="Current score" value={market.measuredCount ? `${Math.round((Number(market.passedCount || 0) / Number(market.measuredCount || 1)) * 100)}%` : EMPTY} />
          <Stat label="Required score" value={`${status?.config?.marketRegimeMinHealthPercent ?? '-'}%`} />
          <Stat label="Assets passed" value={`${market.passedCount ?? '-'} / ${market.measuredCount ?? '-'}`} />
          <Stat label="Avg trend" value={percent(market.avgTrendPercent)} />
        </div>
      </Card>

      <Card title="Безопасность live" icon={ShieldCheck} help="Короткий чеклист перед доверием денег роботу: доступ, режим, рынок, дневные лимиты, неизвестные заявки и cookie-сборщик.">
        <Checklist items={safetyItems} />
      </Card>

      <Card title="Портфель / P&L" icon={LineChart} help="Результаты и наблюдаемая часть системы. Paper P/L - лаборатория идей, Social - отдельный сборщик сигналов, не исполняющий заявки сам.">
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
  const previews = data.preview?.previews || [];
  const allowedPreviews = previews.filter((row) => row.status === 'allowed');
  const blockedPreviews = previews.filter((row) => row.status !== 'allowed');
  const buyRecommendations = data.buyRecommendations?.items || [];
  const buyScan = data.buyScan?.items || [];
  const tradeLimit = getTradeLimit(data);
  const blockerSummary = summarizeBlockers(blockedPreviews) || buyRecommendations[0]?.reason || EMPTY;

  return (
    <div className="grid">
      <Card title="Цепочка покупки" icon={Signal} className="wide" help="Слева направо: широкий рынок попадает в дневной список, затем score и внешние сигналы выбирают кандидатов, после этого market/risk gate решает, можно ли реально отправлять заявку.">
        <StageStrip
          items={[
            { label: 'Сканер рынка', value: dailyBuyList.universe?.scanned ?? EMPTY, detail: 'бумаг просмотрено' },
            { label: 'Кандидаты дня', value: dailyItems.length, detail: dailyItems.map((item) => item.ticker).join(', ') || 'список пуст' },
            { label: 'Предпросмотр', value: allowedPreviews.length, tone: allowedPreviews.length ? 'good' : 'warn', detail: `${blockedPreviews.length} заблокировано до заявки` },
            { label: 'Лимиты', value: tradeLimit ? `${tradeLimit.ordersLeft} / ${money(tradeLimit.rubLeft)} RUB` : EMPTY, tone: tradeLimit && Number(tradeLimit.ordersLeft) <= 0 ? 'bad' : 'good', detail: 'заявки / бюджет сегодня' },
            { label: 'Исполнение', value: blockedPreviews.length ? 'BLOCKED' : allowedPreviews.length ? 'READY' : 'WAIT', tone: blockedPreviews.length ? 'bad' : allowedPreviews.length ? 'good' : 'warn', detail: blockerSummary }
          ]}
        />
      </Card>

      <Card title="Боевой предпросмотр" icon={ShieldCheck} className="wide" help="Самый практический блок покупок: качество кандидата отдельно, решение исполнения отдельно. Высокий score не означает покупку, если бумага уже есть в портфеле, рынок закрыт или лимит исчерпан.">
        <Table
          className="buy-preview-table"
          columns={[
            { key: 'ticker', label: 'Кандидат', width: '190px', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Качество кандидата', width: '430px', render: (row) => <ScoreBreakdown analysis={row.scoreAnalysis} /> },
            { key: 'status', label: 'Исполнение', width: '150px', render: (row) => <ExecutionDecision status={row.status} reason={row.reason} /> },
            { key: 'estimatedOrderRub', label: 'Сумма', width: '105px', className: 'right', render: (row) => money(row.estimatedOrderRub) },
            { key: 'brokerQuote', label: 'Брокер', width: '105px', className: 'right', render: (row) => row.brokerQuote ? money(row.brokerQuote.totalOrderAmount) : '-' },
            { key: 'reason', label: 'Причина', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={previews}
          loading={loadingKeys.preview}
        />
      </Card>

      <Card title="Кандидаты дня" icon={Bot} className="wide" help="Автоматический buy-list из широкого рынка. Робот выбирает до 5 бумаг с лучшим score среди доступных рублевых акций, вместо старого ручного списка из случайных позиций.">
        <div className="stats compact">
          <Stat label="Источник" value={dailyBuyList.source || '-'} />
          <Stat label="Tickers" value={(dailyBuyList.tickers || []).join(', ') || '-'} />
          <Stat label="Просмотрено" value={dailyBuyList.universe?.scanned ?? '-'} />
          <Stat label="Истекает" value={dailyBuyList.expiresAt ? time(dailyBuyList.expiresAt) : '-'} />
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

      <Card title="Рядом с проходом" icon={Eye} help="Бумаги из широкого сканера, которые были близко к проходному score, но не попали в дневной buy-list. Это очередь на наблюдение, а не заявка.">
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
      <Card title="Рекомендации робота" icon={ShieldCheck} help="Сжатый список действий по кандидатам: buy-candidate можно покупать при пройденных фильтрах, wait-market ждет рынок, watch близко к порогу, scan-only просто наблюдать.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'recommendation', label: 'Rec', render: (row) => <Pill tone={row.recommendation === 'buy-candidate' ? 'good' : row.recommendation === 'wait-market' || row.recommendation === 'watch' ? 'warn' : 'neutral'}>{row.recommendation}</Pill> },
            { key: 'score', label: 'Score', className: 'right', render: (row) => <strong>{row.score}</strong> },
            { key: 'scoreGap', label: 'Gap', className: 'right', render: (row) => row.scoreGap ? row.scoreGap : <Pill tone="good">PASS</Pill> },
            { key: 'lastPrice', label: 'Price', className: 'right', render: (row) => money(row.lastPrice) },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={buyRecommendations}
          loading={loadingKeys.buyRecommendations}
        />
      </Card>
      <Card title="Score-разбор" icon={Signal} help="Оценка бумаг из текущего списка наблюдения. Score 70/100 и выше обычно считается проходным. Base - сама цена/объем, pulse - Пульс, analyst - прогнозы, tech - индикаторы.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Качество кандидата', render: (row) => <ScoreBreakdown analysis={row.analysis} /> },
            { key: 'lastPrice', label: 'Price', className: 'right', render: (row) => money(row.lastPrice) },
            { key: 'passed', label: 'Result', render: (row) => <Pill tone={row.passed ? 'good' : 'warn'}>{row.passed ? 'PASS' : 'WAIT'}</Pill> },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={buyScan}
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
  const sellEvents = robotEvents.filter((row) => row.direction === 'sell');
  const lastSell = sellEvents[0];

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
      <Card title="Цепочка продажи" icon={AlertTriangle} className="wide" help="Цепочка продажи: стратегия видит сигнал, sell-policy проверяет robot-owned лоты, live-action разрешает или блокирует продажу, затем ledger фиксирует исполнение.">
        <StageStrip
          items={[
            { label: 'Сигналы', value: liveCandidates.length, detail: `${observeSignals.length} observe-сигналов отдельно` },
            { label: 'Robot-owned', value: robotLedger.summary?.positions ?? 0, tone: Number(robotLedger.summary?.positions || 0) ? 'good' : 'warn', detail: 'позиций в ledger робота' },
            { label: 'Можно продать', value: executable.length, tone: executable.length ? 'bad' : 'good', detail: `${policyBlocked.length} заблокировано политикой` },
            { label: 'Live-продажа', value: sellArmed ? 'ON' : 'OFF', tone: sellArmed ? 'bad' : 'good', detail: liveActions.join(', ') || EMPTY },
            { label: 'Последняя продажа', value: lastSell?.ticker || EMPTY, tone: lastSell ? 'warn' : 'neutral', detail: lastSell ? `${time(lastSell.at)} · ${money(lastSell.price)} RUB` : 'продаж в ledger пока нет' }
          ]}
        />
      </Card>

      <Card title="Боевой sell-лист" icon={AlertTriangle} help="Позиции торгового счета, которые стратегия хочет продать сейчас. Даже при включенном sell заявка пройдет только на robot-owned лоты.">
        <div className="readiness">
          <Pill tone={sellArmed ? 'bad' : 'good'}>{sellArmed ? 'SELL ARMED' : 'SELL OFF'}</Pill>
          <span>{sellArmed ? 'Реальные продажи разрешены политикой действий.' : 'Реальные продажи выключены. Список ниже только показывает готовность.'}</span>
        </div>
        <div className="stats compact">
          <Stat label="Можно исполнить" value={executable.length} tone={executable.length ? 'bad' : 'good'} />
          <Stat label="Блок политикой" value={policyBlocked.length} />
          <Stat label="Лоты робота" value={money(executable.reduce((sum, row) => sum + Number(row.orderLots || 0), 0))} />
          <Stat label="Live-действия" value={liveActions.join(', ') || '-'} tone={sellArmed ? 'bad' : 'good'} />
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
  const collector = data.socialCollector || {};
  const profiles = collector.profiles || [];
  const consensus = data.socialConsensus?.items || [];
  const signals = data.socialSignals?.signals || [];
  const readyProfiles = profiles.filter((row) => row.status === 'ready').length;
  const topConsensus = consensus[0];
  const bearishCount = consensus.filter((row) => row.mood === 'bearish').length;
  const bullishCount = consensus.filter((row) => row.mood === 'bullish').length;

  return (
    <div className="grid">
      <Card title="Цепочка Пульса" icon={Users} className="wide" help="Социальный контур работает отдельно от торгового цикла: расширение обновляет cookie, collector собирает авторов, затем сигналы агрегируются в поправку к score.">
        <StageStrip
          items={[
            { label: 'Cookie / auth', value: socialCollectorText(collector), tone: collector.health?.pendingAuth > 0 ? 'bad' : collector.health?.staleProfiles > 0 ? 'warn' : 'good', detail: `${collector.health?.pendingAuth || 0} профилей ждут auth` },
            { label: 'Авторы', value: `${readyProfiles} / ${collector.config?.configuredProfiles ?? profiles.length}`, tone: readyProfiles ? 'good' : 'warn', detail: 'готово / настроено' },
            { label: 'Сигналы', value: signals.length, detail: 'последние найденные действия' },
            { label: 'Консенсус', value: consensus.length, detail: `${bullishCount} bullish, ${bearishCount} bearish` },
            { label: 'Топ мнение', value: topConsensus?.ticker || EMPTY, tone: topConsensus?.mood === 'bullish' ? 'good' : topConsensus?.mood === 'bearish' ? 'bad' : 'neutral', detail: topConsensus?.reason || 'пока нет агрегированного сигнала' }
          ]}
        />
      </Card>

      <Card title="Консенсус Пульса" icon={Users} className="wide" help="Сводное мнение выбранных успешных авторов по тикеру. Чем больше вес и свежесть сигнала, тем сильнее поправка к buy-score.">
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
      <Card title="Авторы" icon={ShieldCheck} className="wide" help="Список профилей, которых собирает отдельный социальный механизм. Manual - твоя ручная оценка, Auto - автоматическая оценка по данным профиля, Effective - итоговый вес.">
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
      <Card title="Сделки авторов" icon={Signal} className="wide" help="Последние найденные сделки/публичные действия из Пульса. Этот блок ничего не покупает сам, только складывает сигналы для проверки и усиления алгоритма.">
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
  const scenarios = data.marketLab?.scenarios || [];
  const strategyRows = data.strategy?.strategies || [];
  const enoughStrategies = strategyRows.filter((row) => row.status === 'enough-data').length;

  return (
    <div className="grid">
      <Card title="Цепочка лаборатории" icon={BarChart3} className="wide" help="Эта вкладка не торгует. Она показывает доказательства: сценарии рынка, 24ч кандидатов, внешние источники и статистику стратегий.">
        <StageStrip
          items={[
            { label: 'Сценарии рынка', value: scenarios.length, detail: 'вариантов порогов проверено' },
            { label: '24ч покупки', value: data.buyLab?.items?.length || 0, detail: 'бумаг рядом с проходом' },
            { label: 'Аналитики', value: data.analystForecasts?.items?.length || 0, detail: 'консенсус-прогнозы API' },
            { label: 'Теханализ', value: data.techAnalysis?.items?.length || 0, detail: 'RSI/MACD/MA записи' },
            { label: 'Доказательства', value: `${enoughStrategies} / ${strategyRows.length}`, tone: enoughStrategies ? 'good' : 'warn', detail: 'стратегий с достаточными данными' }
          ]}
        />
      </Card>

      <MarketLab data={data} loading={loadingKeys.marketLab} />

      <Card title="Режим рынка" icon={Activity} className="wide" help="Подробности рыночного фильтра: какие базовые бумаги считаются здоровыми и почему общий фильтр пропускает или блокирует покупки.">
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

      <Card title="Покупки 24ч" icon={BarChart3} className="wide" help="Агрегация решений за последние 24 часа. Показывает, какие бумаги чаще всего подходили к порогу покупки, сколько баллов не хватило и что было главным стопором.">
        <Table
          columns={[
            { key: 'ticker', label: 'Ticker', render: (row) => <><strong>{row.ticker}</strong><div className="muted">{row.name}</div></> },
            { key: 'latestScore', label: 'Score', render: (row) => <ScoreSummary score={row.latestScore} base={row.baseScore} social={row.socialScoreAdjustment} analyst={row.analystScoreAdjustment} technical={row.technicalScoreAdjustment} /> },
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
  const orderButtons = [500, 1000, 1500, 2500].filter((value) => value <= Number(config.maxRuntimeOrderRub || value));
  const orderCountButtons = [1, 3, 5, 10].filter((value) => value <= Number(config.maxRuntimeDailyOrders || value));
  const dailyRubButtons = [500, 1500, 3000, 5000].filter((value) => value <= Number(config.maxRuntimeDailyRub || value));

  return (
    <Card title="Лимиты риска" icon={ShieldCheck} help="Меняет реальные лимиты робота без перезапуска. Лимит заявки - потолок одной заявки, заявки в день - сколько заявок за день, бюджет дня - общий дневной бюджет.">
      <div className="stats compact">
        <Stat label="Лимит заявки" value={`${money(maxOrderRub)} RUB`} title={`Hard cap: ${money(config.maxRuntimeOrderRub)} RUB`} />
        <Stat label="Заявок в день" value={maxDailyOrders} title={`Hard cap: ${config.maxRuntimeDailyOrders}`} />
        <Stat label="Бюджет дня" value={`${money(maxDailyRub)} RUB`} title={`Hard cap: ${money(config.maxRuntimeDailyRub)} RUB`} />
        <Stat label="Осталось сегодня" value={tradeLimit ? `${tradeLimit.ordersLeft} / ${money(tradeLimit.rubLeft)} RUB` : '-'} />
      </div>
      <div className="control-row">
        {orderButtons.map((value) => (
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
        {orderCountButtons.map((value) => (
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
        {dailyRubButtons.map((value) => (
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
  const accounts = data.accounts?.accounts || [];
  const tradeAccounts = accounts.filter((row) => row.mode === 'trade');
  const observeAccounts = accounts.filter((row) => row.mode !== 'trade');
  const protectedAccounts = accounts.filter((row) => row.protected);
  const positions = data.positions?.positions || [];

  return (
    <div className="grid">
      <Card title="Контур счетов" icon={Database} className="wide" help="Управление счетами отделено от стратегии. Счет в trade может получать реальные заявки, observe только наблюдается. Protected требует явного подтверждения номером счета.">
        <StageStrip
          items={[
            { label: 'Боевые счета', value: tradeAccounts.length, tone: tradeAccounts.length ? 'bad' : 'warn', detail: tradeAccounts.map((row) => row.alias || row.accountId).join(', ') || 'нет боевых счетов' },
            { label: 'Наблюдение', value: observeAccounts.length, detail: observeAccounts.map((row) => row.alias || row.accountId).join(', ') || 'нет наблюдаемых' },
            { label: 'Защищены', value: protectedAccounts.length, tone: protectedAccounts.length ? 'warn' : 'good', detail: 'требуют подтверждения перед trade' },
            { label: 'Live-действия', value: liveActions.join(', ') || EMPTY, tone: sellArmed ? 'bad' : 'good', detail: sellArmed ? 'sell включен только для robot-owned лотов' : 'sell выключен' },
            { label: 'Позиции', value: positions.length, detail: 'позиций во всех счетах' }
          ]}
        />
      </Card>

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
      <Card title="Счета" icon={Database} className="wide" help="Кнопка меняет режим счета без перезапуска робота. Protected-счет можно перевести в trade только после отдельного подтверждения номером счета.">
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
      <Card title="Позиции" icon={LineChart} className="wide" help="Текущие позиции по всем счетам. P/L здесь считается от средней цены позиции к текущей цене из брокерского API.">
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
  if (status === 'order-rejected' || status === 'order-failed' || status === 'order-failed-before-submit' || status === 'order-unknown') return 'bad';
  if (status === 'skip') return 'neutral';
  return 'warn';
};

const orderStatusTone = (status) => {
  if (status === 'EXECUTION_REPORT_STATUS_FILL') return 'good';
  if (status === 'EXECUTION_REPORT_STATUS_REJECTED' || status === 'EXECUTION_REPORT_STATUS_CANCELLED' || status === 'LOCAL_POST_REJECTED' || status === 'LOCAL_VALIDATION_FAILED') return 'bad';
  if (status === 'LOCAL_SUBMIT_UNKNOWN') return 'bad';
  if (status === 'LOCAL_PENDING_SUBMIT' || status === 'EXECUTION_REPORT_STATUS_NEW' || status === 'EXECUTION_REPORT_STATUS_PARTIALLYFILL') return 'warn';
  return 'neutral';
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

function OrderSafety({ data, loading }) {
  const summary = data.orderSafety?.summary || {};
  const orders = data.orderSafety?.orders || [];

  return (
    <Card title="Заявки / Order Safety" icon={ShieldCheck} help="Контроль неизвестных и открытых заявок. UNKNOWN значит: запрос мог уйти брокеру, но ответ потерялся; робот не будет повторять такую заявку, пока reconciliation не выяснит статус.">
      <div className="stats compact">
        <Stat label="Open" value={summary.open ?? 0} tone={summary.open ? 'warn' : 'good'} />
        <Stat label="Pending" value={summary.pending ?? 0} tone={summary.pending ? 'warn' : 'good'} />
        <Stat label="Unknown" value={summary.unknown ?? 0} tone={summary.unknown ? 'bad' : 'good'} />
        <Stat label="Partial" value={summary.partial ?? 0} tone={summary.partial ? 'warn' : 'good'} />
      </div>
      <Table
        className="order-safety-table"
        columns={[
          { key: 'createdAt', label: 'Время', width: '150px', render: (row) => time(row.tradeDateTime || row.createdAt) },
          { key: 'ticker', label: 'Тикер', width: '100px', render: (row) => <><strong>{row.ticker || row.figi || EMPTY}</strong><div className="muted">{row.name}</div></> },
          { key: 'direction', label: 'Side', width: '80px', render: (row) => <Pill tone={String(row.direction) === '1' ? 'good' : 'bad'}>{String(row.direction) === '1' ? 'buy' : String(row.direction) === '2' ? 'sell' : display(row.direction)}</Pill> },
          { key: 'status', label: 'Status', width: '175px', render: (row) => <Pill tone={orderStatusTone(row.status)}>{display(row.status)}</Pill> },
          { key: 'lotsRequested', label: 'Req', width: '70px', className: 'right', render: (row) => money(row.lotsRequested) },
          { key: 'lotsExecuted', label: 'Exec', width: '70px', className: 'right', render: (row) => money(row.lotsExecuted) },
          { key: 'clientOrderId', label: 'Client id', width: '190px', render: (row) => <TextCell>{row.clientOrderId || row.orderId}</TextCell> },
          { key: 'orderError', label: 'Ошибка / broker', className: 'reason', render: (row) => <Reason>{row.orderError || row.orderId || EMPTY}</Reason> }
        ]}
        rows={orders}
        empty="Заявок пока нет"
        loading={loading}
      />
    </Card>
  );
}

function Logs({ data, loadingKeys }) {
  const [filters, setFilters] = useState({ status: 'all', signal: 'all', ticker: '', pnl: 'all', sort: 'newest' });
  const decisions = (data.decisions?.decisions || []).map(toDecisionView);
  const trades = data.trades?.trades || [];
  const safetySummary = data.orderSafety?.summary || {};
  const postedDecisions = decisions.filter((row) => row.status === 'order-posted').length;
  const skippedDecisions = decisions.filter((row) => row.status === 'skip').length;
  const criticalDecisions = decisions.filter(isCriticalDecision).length;
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
      <Card title="Аудит исполнения" icon={Eye} className="wide" help="Журнал отвечает на вопрос: что решил робот, что реально ушло брокеру, и нет ли заявок в неизвестном состоянии.">
        <StageStrip
          items={[
            { label: 'Решения', value: decisions.length, detail: `${postedDecisions} order-posted, ${skippedDecisions} skip` },
            { label: 'Critical skips', value: criticalDecisions, tone: criticalDecisions ? 'warn' : 'good', detail: 'stop/profit/trailing сигналы без исполнения' },
            { label: 'Сделки брокера', value: trades.length, detail: 'последние реальные trade records' },
            { label: 'Open orders', value: safetySummary.open ?? 0, tone: safetySummary.open ? 'warn' : 'good', detail: `${safetySummary.pending || 0} pending` },
            { label: 'Unknown orders', value: safetySummary.unknown ?? 0, tone: safetySummary.unknown ? 'bad' : 'good', detail: 'повтор таких заявок запрещен' }
          ]}
        />
      </Card>

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
      <OrderSafety data={data} loading={loadingKeys.orderSafety} />
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState(getInitialTab);
  const { data, loading, loadingKeys, error, updatedAt, reload } = useDashboardData(activeTab);
  const [actionError, setActionError] = useState('');
  const active = useMemo(() => tabs.find((tab) => tab.id === activeTab) || tabs[0], [activeTab]);
  const selectTab = (id) => {
    setActiveTab(id);
    if (window.location.hash !== `#${id}`) window.history.replaceState(null, '', `#${id}`);
  };

  useEffect(() => {
    const onHashChange = () => setActiveTab(getInitialTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

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
              <button key={tab.id} className={cls('nav-btn', activeTab === tab.id && 'active')} onClick={() => selectTab(tab.id)}>
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
