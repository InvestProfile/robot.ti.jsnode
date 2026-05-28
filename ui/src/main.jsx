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
  ArrowLeftRight,
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
  socialProfiles: '/api/social-profiles',
  socialEvidence: '/api/social-evidence?limit=80',
  sellBrain: '/api/sell-brain',
  buyScan: '/api/buy-scan',
  buyLab: '/api/buy-lab?hours=24&limit=30',
  buyRecommendations: '/api/buy-recommendations?limit=30',
  analystForecasts: '/api/analyst-forecasts',
  techAnalysis: '/api/tech-analysis',
  robotPositions: '/api/robot-positions',
  trades: '/api/trades?limit=80',
  tradePnl: '/api/trade-pnl?limit=500',
  accountingAudit: '/api/accounting-audit',
  orderSafety: '/api/order-safety?limit=80',
  protectiveStops: '/api/protective-stops'
};

const endpointGroups = {
  core: ['status', 'limits', 'performance', 'paper', 'socialCollector', 'market', 'orderSafety'],
  overview: ['market', 'orderSafety'],
  buy: ['dailyBuyList', 'preview', 'buyRecommendations', 'buyScan'],
  social: ['socialConsensus', 'socialSignals', 'socialCollector'],
  socialProfiles: ['socialProfiles'],
  evidence: ['market', 'marketLab', 'buyLab', 'analystForecasts', 'techAnalysis', 'strategy', 'socialEvidence'],
  accounts: ['accounts', 'positions'],
  sell: ['sellBrain', 'positions', 'robotPositions'],
  trades: ['trades', 'tradePnl', 'robotPositions', 'accountingAudit', 'decisions', 'orderSafety', 'protectiveStops'],
  logs: ['decisions', 'trades', 'robotPositions', 'orderSafety', 'protectiveStops']
};

const tabs = [
  { id: 'overview', label: 'Обзор', icon: Activity },
  { id: 'buy', label: 'Покупки', icon: Signal },
  { id: 'sell', label: 'Продажи', icon: AlertTriangle },
  { id: 'trades', label: 'Сделки', icon: ArrowLeftRight },
  { id: 'social', label: 'Пульс', icon: Users },
  { id: 'socialProfiles', label: 'Профили', icon: ShieldCheck },
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

const duration = (milliseconds) => {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return EMPTY;
  const minutes = Math.floor(value / 60000);
  if (minutes < 1) return '<1 мин';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
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

const Pill = ({ tone = 'neutral', children, className, title }) => (
  <span className={cls('pill', tone, className)} title={title}>{children}</span>
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

const cacheTone = (value) => {
  if (value === 'fresh' || value === 'cached') return 'good';
  if (value === 'stale' || value === 'skipped') return 'warn';
  if (value === 'error') return 'bad';
  return 'neutral';
};

const analystSourceFromReason = (reason) => {
  const text = String(reason || '').toLowerCase();
  if (text.includes('analyst skipped')) return { state: 'skipped', label: 'analyst skipped', title: 'Прогноз аналитиков не дергали: сработал лимит пачки, score не завышается.' };
  if (text.includes('analyst stale cache ignored')) return { state: 'stale', label: 'analyst stale', title: 'Есть только устаревший кеш аналитиков; положительный boost проигнорирован.' };
  if (text.includes('analyst') && text.includes('stale cache')) return { state: 'stale', label: 'analyst stale', title: 'Использован устаревший кеш аналитиков после лимита API.' };
  if (text.includes('analyst') && text.includes('cached')) return { state: 'cached', label: 'analyst cached', title: 'Использован свежий кеш аналитиков в пределах TTL.' };
  if (text.includes('analyst')) return { state: 'fresh', label: 'analyst fresh', title: 'Прогноз аналитиков получен свежим запросом или обычным свежим источником.' };
  return undefined;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const uniqueValues = (rows, getter) => [...new Set(rows.map(getter).filter(Boolean))].sort();

const sortByNumber = (rows, getter, direction = 'desc') => {
  const missing = direction === 'desc' ? -Infinity : Infinity;
  return [...rows].sort((a, b) => {
    const left = Number(getter(a));
    const right = Number(getter(b));
    const normalizedLeft = Number.isFinite(left) ? left : missing;
    const normalizedRight = Number.isFinite(right) ? right : missing;
    return direction === 'desc' ? normalizedRight - normalizedLeft : normalizedLeft - normalizedRight;
  });
};

const normalizeSearch = (value) => String(value || '').trim().toUpperCase();

const splitErrors = (value) => String(value || '').split('; ').filter(Boolean);

const compactError = (value) => {
  const items = splitErrors(value);
  if (!items.length) return '';
  if (items.length <= 2) return items.join('; ');
  return `${items.slice(0, 2).join('; ')}; +${items.length - 2} еще`;
};

const ScoreBreakdown = ({ analysis }) => {
  const factors = analysis?.factors || {};
  const analystSource = analystSourceFromReason(analysis?.reason);
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
      {analystSource ? (
        <div className="score-meta" title={analystSource.title}>
          <Pill tone={cacheTone(analystSource.state)}>{analystSource.label}</Pill>
        </div>
      ) : null}
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
    'position concentration limit reached',
    'diversification first',
    'observe-only: spread',
    'observe-only: ask liquidity',
    'observe-only: avg daily turnover',
    'observe-only: sector',
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
  if (text.includes('concentration')) return 'лимит позиции';
  if (text.includes('diversification')) return 'сначала диверсификация';
  if (text.includes('spread')) return 'широкий спред';
  if (text.includes('liquidity')) return 'низкая ликвидность';
  if (text.includes('turnover')) return 'низкий оборот';
  if (text.includes('sector')) return 'лимит сектора';
  if (text.includes('daily order limit')) return 'дневной лимит';
  if (text.includes('market regime')) return 'рыночный фильтр';
  if (text.includes('normal trading status')) return 'статус торгов';
  if (text.includes('score-buy blocked')) return 'score ниже порога';
  if (text.includes('cash')) return 'денег не хватает';
  if (text.includes('open buy order')) return 'есть открытая заявка';
  return reason || EMPTY;
};

const PreBuyRisk = ({ risk }) => {
  if (!risk) return <span className="muted">-</span>;

  const failed = risk.checks?.filter((check) => check.status === 'block' || check.status === 'warn' || check.status === 'unknown') || [];
  const tone = risk.blockingReasons?.length ? 'bad' : failed.length ? 'warn' : 'good';
  const label = risk.blockingReasons?.length ? 'BLOCK' : failed.length ? 'WATCH' : 'OK';
  const title = [...(risk.blockingReasons || []), ...(risk.warnings || [])].join('\n') || 'Проверки ликвидности и сектора пройдены';
  const detail = failed.length
    ? failed.slice(0, 2).map((check) => classifyBlocker(check.reason)).join(', ')
    : `${percent(risk.spreadPercent)} спред`;

  return (
    <div className="execution-cell" title={title}>
      <Pill tone={tone}>{label}</Pill>
      <span>{detail}</span>
    </div>
  );
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
  const label = classifyBlocker(text);
  if (text.length <= 90) {
    return (
      <span className="reason-short" title={text}>
        {label !== text && label !== EMPTY ? <b>{label}</b> : null}
        <span>{text}</span>
      </span>
    );
  }

  return (
    <details className="reason-cell" title={text}>
      <summary>{label !== text && label !== EMPTY ? label : shortReason(text)}</summary>
      <p>{text}</p>
    </details>
  );
};

const CompactReason = ({ children }) => {
  const text = String(children || EMPTY);
  const label = classifyBlocker(text);
  const displayLabel = label !== text && label !== EMPTY ? label : shortReason(text);

  if (!text || text === EMPTY) return <span className="muted">-</span>;

  return (
    <details className="compact-reason" title={text}>
      <summary>{displayLabel}</summary>
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

const Table = ({ columns, rows, empty = 'Нет данных', loading = false, className, rowClassName }) => {
  const hasRows = Boolean(rows?.length);

  return (
    <div className="table-wrap">
      {loading && hasRows ? <div className="table-loading">Обновляю...</div> : null}
      {hasRows ? (
        <table className={className}>
          <colgroup>
            {columns.map((column) => <col key={column.key} style={column.width ? { width: column.width } : undefined} />)}
          </colgroup>
          <thead>
            <tr>{columns.map((column) => <th key={column.key} className={column.className}>{column.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id || `${row.ticker || row.accountId || 'row'}-${index}`} className={rowClassName ? rowClassName(row) : undefined}>
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render ? column.render(row) : cellValue(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {!hasRows ? <div className="empty-table-state">{loading ? 'Загрузка...' : empty}</div> : null}
    </div>
  );
};

const FilterSummary = ({ visible, total, label = 'строк' }) => (
  <div className="filter-summary">
    <span>{visible} / {total} {label}</span>
  </div>
);

const ControlGroup = ({ label, value, children }) => (
  <div className="control-group">
    <div className="control-group-label">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
    <div className="control-group-options">{children}</div>
  </div>
);

const OperatorTile = ({ label, value, detail, tone = 'neutral' }) => (
  <div className={cls('operator-tile', tone)}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
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

const getBuyReadiness = ({ tradeLimit, previews, dailyItems }) => {
  const cashRub = Number(tradeLimit?.cashRub ?? 0);
  const allowedCount = previews.filter((row) => row.status === 'allowed').length;
  const candidatesByTicker = new Map();

  [...previews, ...dailyItems].forEach((row) => {
    const ticker = row.ticker;
    const amount = Number(row.estimatedOrderRub ?? row.currentPrice ?? row.lastPrice);
    if (!ticker || !Number.isFinite(amount) || amount <= 0) return;
    const existing = candidatesByTicker.get(ticker);
    if (!existing || amount < existing.amount) {
      candidatesByTicker.set(ticker, { ticker, name: row.name, amount, reason: row.reason });
    }
  });

  const candidates = Array.from(candidatesByTicker.values()).sort((a, b) => a.amount - b.amount);
  const cheapest = candidates[0];
  const missingRub = cheapest ? Math.max(0, cheapest.amount - cashRub) : undefined;
  const cashBlocked = Boolean(cheapest && missingRub > 0);
  const brokerBlocked = previews.some((row) => String(row.reason || '').includes('normal trading status'));
  const limitBlocked = tradeLimit && (Number(tradeLimit.ordersLeft) <= 0 || Number(tradeLimit.rubLeft) <= 0);

  let headline = 'Ждем подходящий сигнал';
  let detail = 'Кандидаты есть, но пока ни один не прошел весь путь до заявки.';
  let tone = 'warn';

  if (allowedCount) {
    headline = 'Есть кандидат к заявке';
    detail = `${allowedCount} кандидатов прошли фильтры; робот отправит заявку, если live-режим и брокерский статус позволяют.`;
    tone = 'good';
  } else if (limitBlocked) {
    headline = 'Уперлись в дневные лимиты';
    detail = `${tradeLimit.ordersLeft} заявок и ${money(tradeLimit.rubLeft)} RUB осталось по дневному бюджету.`;
    tone = 'bad';
  } else if (cashBlocked) {
    headline = 'Не хватает свободных рублей';
    detail = `Ближайший минимальный лот: ${cheapest.ticker} примерно ${money(cheapest.amount)} RUB; на счете ${money(cashRub)} RUB, не хватает ${money(missingRub)} RUB.`;
    tone = 'bad';
  } else if (brokerBlocked) {
    headline = 'Инструменты не торгуются сейчас';
    detail = 'Брокерский статус по последним кандидатам не normal trading. Робот ждет открытую сессию или доступный инструмент.';
  }

  return { tone, headline, detail, cashRub, cheapest, missingRub, allowedCount, candidateCount: candidates.length };
};

const socialCollectorText = (social) => {
  if (!social) return 'loading';
  if (social.health?.pendingAuth > 0) return 'needs auth';
  if (social.health?.staleProfiles > 0) return `idle, ${social.health.staleProfiles} stale`;
  return 'fresh';
};

function OperatorBar({ data, loading, error }) {
  const status = data.status;
  const config = status?.config || {};
  const blockers = getReadiness(data);
  const tradeLimit = getTradeLimit(data);
  const orderSafety = data.orderSafety?.summary || {};
  const market = data.market;
  const social = data.socialCollector;
  const dryRun = status ? Boolean(config.dryRun) : true;
  const liveActions = config.liveAllowedActions || [];
  const unknownOrders = Number(orderSafety.unknown || 0);
  const staleLimit = Number(orderSafety.staleLimit || 0);
  const openOrders = Number(orderSafety.open || 0);
  const limitBlocked = tradeLimit && (Number(tradeLimit.ordersLeft) <= 0 || Number(tradeLimit.rubLeft) <= 0);
  const socialNeedsAuth = Number(social?.health?.pendingAuth || 0) > 0;
  const marketBlocked = market && !market.passed;
  const apiErrors = splitErrors(error).length;
  const mainBlocker = apiErrors
    ? 'API error'
    : unknownOrders
    ? 'unknown orders'
    : staleLimit
      ? 'stale limits'
      : blockers[0] || (limitBlocked ? 'daily limit' : marketBlocked ? 'market' : EMPTY);

  return (
    <section className="operator-bar" aria-label="Операционный статус">
      <OperatorTile
        label="Режим"
        value={status ? dryRun ? 'DRY RUN' : 'LIVE' : 'WAIT'}
        detail={status ? `actions: ${liveActions.join(', ') || EMPTY}` : 'ждем /api/status'}
        tone={status ? dryRun ? 'warn' : 'good' : 'neutral'}
      />
      <OperatorTile
        label="Главный блокер"
        value={loading && !status && !apiErrors ? 'loading' : mainBlocker}
        detail={apiErrors ? `${apiErrors} API endpoints failed` : blockers.length ? blockers.join(', ') : 'критичных стопоров не видно'}
        tone={apiErrors || mainBlocker === 'unknown orders' || mainBlocker === 'stale limits' ? 'bad' : mainBlocker === EMPTY ? 'good' : 'warn'}
      />
      <OperatorTile
        label="Заявки"
        value={`${openOrders} open / ${unknownOrders} unknown`}
        detail={staleLimit ? `${staleLimit} stale limit` : `${orderSafety.pending || 0} pending`}
        tone={unknownOrders || staleLimit ? 'bad' : openOrders ? 'warn' : 'good'}
      />
      <OperatorTile
        label="Дневной лимит"
        value={tradeLimit ? `${tradeLimit.ordersLeft} / ${money(tradeLimit.rubLeft)}` : EMPTY}
        detail={tradeLimit ? `${money(tradeLimit.cashRub)} RUB cash` : 'лимиты загружаются'}
        tone={limitBlocked ? 'bad' : tradeLimit ? 'good' : 'neutral'}
      />
      <OperatorTile
        label="Рынок"
        value={market ? market.passed ? 'PASS' : 'BLOCK' : 'WAIT'}
        detail={market?.reason || 'market regime loading'}
        tone={market ? market.passed ? 'good' : 'bad' : 'neutral'}
      />
      <OperatorTile
        label="Пульс"
        value={socialCollectorText(social)}
        detail={`${social?.health?.activeProfiles || 0}/${social?.config?.configuredProfiles || 0} profiles`}
        tone={socialNeedsAuth ? 'bad' : social?.health?.staleProfiles ? 'warn' : social ? 'good' : 'neutral'}
      />
    </section>
  );
}

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

function BuyPreviewFilters({ rows, filters, onChange }) {
  const blockers = uniqueValues(rows, (row) => row.status === 'allowed' ? null : classifyBlocker(row.reason));

  return (
    <div className="filters buy-preview-filters">
      <label>
        <span>Исполнение</span>
        <select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}>
          <option value="all">Все</option>
          <option value="allowed">READY</option>
          <option value="blocked">BLOCKED</option>
        </select>
      </label>
      <label>
        <span>Стопор</span>
        <select value={filters.blocker} onChange={(event) => onChange({ ...filters, blocker: event.target.value })}>
          <option value="all">Любой</option>
          {blockers.map((blocker) => <option key={blocker} value={blocker}>{blocker}</option>)}
        </select>
      </label>
      <label>
        <span>Тикер</span>
        <input value={filters.ticker} onChange={(event) => onChange({ ...filters, ticker: normalizeSearch(event.target.value) })} placeholder="SBER" />
      </label>
      <label>
        <span>Score</span>
        <select value={filters.score} onChange={(event) => onChange({ ...filters, score: event.target.value })}>
          <option value="all">Любой</option>
          <option value="pass">70+</option>
          <option value="near">60-69</option>
          <option value="low">&lt;60</option>
        </select>
      </label>
      <label>
        <span>Сортировка</span>
        <select value={filters.sort} onChange={(event) => onChange({ ...filters, sort: event.target.value })}>
          <option value="score-desc">Score выше</option>
          <option value="score-asc">Score ниже</option>
          <option value="amount-desc">Сумма выше</option>
          <option value="amount-asc">Сумма ниже</option>
        </select>
      </label>
    </div>
  );
}

const filterBuyPreviews = (rows, filters) => {
  const filtered = rows.filter((row) => {
    const score = Number(row.scoreAnalysis?.score ?? row.score);
    if (filters.status === 'allowed' && row.status !== 'allowed') return false;
    if (filters.status === 'blocked' && row.status === 'allowed') return false;
    if (filters.blocker !== 'all' && classifyBlocker(row.reason) !== filters.blocker) return false;
    if (filters.ticker && !normalizeSearch(`${row.ticker || ''} ${row.name || ''} ${row.figi || ''}`).includes(filters.ticker)) return false;
    if (filters.score === 'pass' && !(Number.isFinite(score) && score >= 70)) return false;
    if (filters.score === 'near' && !(Number.isFinite(score) && score >= 60 && score < 70)) return false;
    if (filters.score === 'low' && !(Number.isFinite(score) && score < 60)) return false;
    return true;
  });

  if (filters.sort === 'score-asc') return sortByNumber(filtered, (row) => row.scoreAnalysis?.score ?? row.score, 'asc');
  if (filters.sort === 'amount-desc') return sortByNumber(filtered, (row) => row.estimatedOrderRub, 'desc');
  if (filters.sort === 'amount-asc') return sortByNumber(filtered, (row) => row.estimatedOrderRub, 'asc');
  return sortByNumber(filtered, (row) => row.scoreAnalysis?.score ?? row.score, 'desc');
};

function Overview({ data, onMarketRegimeChange }) {
  const blockers = getReadiness(data);
  const status = data.status;
  const social = data.socialCollector;
  const paper = data.paper?.summary;
  const market = data.market || {};
  const tradeLimit = getTradeLimit(data);
  const orderSafety = data.orderSafety?.summary || {};
  const liveActions = status?.config?.liveAllowedActions || [];
  const orderType = status?.config?.orderType || EMPTY;
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
      detail: `${orderType} orders, ${openOrders} open, ${unknownOrders} unknown, actions: ${liveActions.join(', ') || EMPTY}`
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

      <ExecutionOverview data={data} className="wide" />

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
  const [filters, setFilters] = useState({ status: 'all', blocker: 'all', ticker: '', score: 'all', sort: 'score-desc' });
  const dailyBuyList = data.dailyBuyList || {};
  const dailyItems = dailyBuyList.items || [];
  const dailyExcluded = dailyBuyList.excluded || [];
  const previews = data.preview?.previews || [];
  const filteredPreviews = filterBuyPreviews(previews, filters);
  const allowedPreviews = previews.filter((row) => row.status === 'allowed');
  const blockedPreviews = previews.filter((row) => row.status !== 'allowed');
  const filteredAllowed = filteredPreviews.filter((row) => row.status === 'allowed');
  const filteredBlocked = filteredPreviews.filter((row) => row.status !== 'allowed');
  const buyRecommendations = data.buyRecommendations?.items || [];
  const buyScan = data.buyScan?.items || [];
  const tradeLimit = getTradeLimit(data);
  const blockerSummary = summarizeBlockers(filteredBlocked) || summarizeBlockers(blockedPreviews) || buyRecommendations[0]?.reason || EMPTY;
  const readiness = getBuyReadiness({ tradeLimit, previews, dailyItems });

  return (
    <div className="grid">
      <Card title="Цепочка покупки" icon={Signal} className="wide" help="Слева направо: широкий рынок попадает в дневной список, затем score и внешние сигналы выбирают кандидатов, после этого market/risk gate решает, можно ли реально отправлять заявку.">
        <StageStrip
          items={[
            { label: 'Сканер рынка', value: dailyBuyList.universe?.scanned ?? EMPTY, detail: 'бумаг просмотрено' },
            { label: 'Кандидаты дня', value: dailyItems.length, detail: dailyItems.map((item) => item.ticker).join(', ') || 'список пуст' },
            { label: 'Предпросмотр', value: allowedPreviews.length, tone: allowedPreviews.length ? 'good' : 'warn', detail: `${blockedPreviews.length} заблокировано до заявки` },
            { label: 'В фильтре', value: `${filteredAllowed.length} / ${filteredPreviews.length}`, tone: filteredAllowed.length ? 'good' : filteredPreviews.length ? 'warn' : 'neutral', detail: 'READY / всего показано' },
            { label: 'Лимиты', value: tradeLimit ? `${tradeLimit.ordersLeft} / ${money(tradeLimit.rubLeft)} RUB` : EMPTY, tone: tradeLimit && Number(tradeLimit.ordersLeft) <= 0 ? 'bad' : 'good', detail: 'заявки / бюджет сегодня' },
            { label: 'Исполнение', value: blockedPreviews.length ? 'BLOCKED' : allowedPreviews.length ? 'READY' : 'WAIT', tone: blockedPreviews.length ? 'bad' : allowedPreviews.length ? 'good' : 'warn', detail: blockerSummary }
          ]}
        />
      </Card>

      <Card title="Почему не покупаем сейчас" icon={ShieldCheck} className="wide" help="Короткая диагностика текущего buy-контура: хватает ли свободных рублей на минимальный лот, есть ли прошедшие кандидаты и какой стопор сейчас главный.">
        <div className="stats compact">
          <Stat label="Статус" value={readiness.headline} tone={readiness.tone} title={readiness.detail} />
          <Stat label="Свободно" value={`${money(readiness.cashRub)} RUB`} title="Свободные рубли на торговом счете по данным брокера." />
          <Stat label="Мин. лот рядом" value={readiness.cheapest ? `${readiness.cheapest.ticker} ${money(readiness.cheapest.amount)} RUB` : EMPTY} title="Самый дешевый минимальный лот среди текущих buy-кандидатов и дневного списка." />
          <Stat label="Не хватает" value={readiness.missingRub === undefined ? EMPTY : `${money(readiness.missingRub)} RUB`} tone={readiness.missingRub > 0 ? 'bad' : 'good'} />
        </div>
        <div className="insight-strip">
          <div>
            <span>Главная причина</span>
            <strong>{readiness.detail}</strong>
          </div>
          <div>
            <span>Кандидаты</span>
            <strong>{readiness.allowedCount} ready из {readiness.candidateCount || previews.length || dailyItems.length}</strong>
          </div>
        </div>
      </Card>

      <Card title="Боевой предпросмотр" icon={ShieldCheck} className="wide" help="Самый практический блок покупок: качество кандидата отдельно, решение исполнения отдельно. Высокий score не означает покупку, если рынок закрыт, лимит исчерпан или позиция стала бы слишком большой.">
        <BuyPreviewFilters rows={previews} filters={filters} onChange={setFilters} />
        <FilterSummary visible={filteredPreviews.length} total={previews.length} label="кандидатов" />
        <Table
          className="buy-preview-table"
          columns={[
            { key: 'ticker', label: 'Кандидат', width: '190px', render: (row) => <><strong>{row.ticker || row.figi}</strong><div className="muted">{row.name}</div></> },
            { key: 'score', label: 'Качество кандидата', width: '430px', render: (row) => <ScoreBreakdown analysis={row.scoreAnalysis} /> },
            { key: 'status', label: 'Исполнение', width: '150px', render: (row) => <ExecutionDecision status={row.status} reason={row.reason} /> },
            { key: 'estimatedOrderRub', label: 'Сумма', width: '105px', className: 'right', render: (row) => money(row.estimatedOrderRub) },
            { key: 'projectedPositionSharePercent', label: 'Доля', width: '92px', className: 'right', render: (row) => percent(row.projectedPositionSharePercent) },
            { key: 'preBuyRisk', label: 'Ликвидн./сектор', width: '180px', render: (row) => <PreBuyRisk risk={row.preBuyRisk} /> },
            { key: 'brokerQuote', label: 'Брокер', width: '105px', className: 'right', render: (row) => row.brokerQuote ? money(row.brokerQuote.totalOrderAmount) : '-' },
            { key: 'reason', label: 'Причина', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
          ]}
          rows={filteredPreviews}
          empty="Нет кандидатов под выбранные фильтры"
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

function SellCandidateFilters({ rows, filters, onChange }) {
  const sources = uniqueValues(rows, (row) => row.source);

  return (
    <div className="filters sell-filters">
      <label>
        <span>Статус</span>
        <select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}>
          <option value="all">Все</option>
          <option value="allowed">Можно продать</option>
          <option value="blocked">Блок/hold</option>
        </select>
      </label>
      <label>
        <span>Сигнал</span>
        <select value={filters.source} onChange={(event) => onChange({ ...filters, source: event.target.value })}>
          <option value="all">Все</option>
          {sources.map((source) => <option key={source} value={source}>{source}</option>)}
        </select>
      </label>
      <label>
        <span>Тикер</span>
        <input value={filters.ticker} onChange={(event) => onChange({ ...filters, ticker: normalizeSearch(event.target.value) })} placeholder="SBER" />
      </label>
      <label>
        <span>Robot P/L</span>
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
          <option value="pnl-asc">P/L ниже</option>
          <option value="pnl-desc">P/L выше</option>
          <option value="lots-desc">Лотов больше</option>
          <option value="ticker-asc">Тикер A-Z</option>
        </select>
      </label>
    </div>
  );
}

const filterSellCandidates = (rows, filters) => {
  const filtered = rows.filter((row) => {
    const pnl = Number(row.robotProfitPercent ?? row.profitPercent);
    if (filters.status === 'allowed' && row.status !== 'allowed') return false;
    if (filters.status === 'blocked' && row.status === 'allowed') return false;
    if (filters.source !== 'all' && row.source !== filters.source) return false;
    if (filters.ticker && !normalizeSearch(`${row.ticker || ''} ${row.name || ''} ${row.figi || ''}`).includes(filters.ticker)) return false;
    if (filters.pnl === 'profit' && !(Number.isFinite(pnl) && pnl > 0)) return false;
    if (filters.pnl === 'loss' && !(Number.isFinite(pnl) && pnl < 0)) return false;
    if (filters.pnl === 'empty' && Number.isFinite(pnl)) return false;
    return true;
  });

  if (filters.sort === 'pnl-desc') return sortByNumber(filtered, (row) => row.robotProfitPercent ?? row.profitPercent, 'desc');
  if (filters.sort === 'lots-desc') return sortByNumber(filtered, (row) => row.orderLots ?? row.robotOwnedLots, 'desc');
  if (filters.sort === 'ticker-asc') return [...filtered].sort((a, b) => String(a.ticker || '').localeCompare(String(b.ticker || '')));
  return sortByNumber(filtered, (row) => row.robotProfitPercent ?? row.profitPercent, 'asc');
};

function Sell({ data, loadingKeys }) {
  const [filters, setFilters] = useState({ status: 'all', source: 'all', ticker: '', pnl: 'all', sort: 'pnl-asc' });
  const liveActions = data.status?.config?.liveAllowedActions || [];
  const sellArmed = liveActions.includes('sell');
  const items = data.sellBrain?.items || [];
  const robotLedger = data.robotPositions || {};
  const robotPositions = robotLedger.items || [];
  const robotEvents = robotLedger.events || [];
  const liveCandidates = items.filter((row) => row.accountMode === 'trade' && row.action === 'sell');
  const filteredLiveCandidates = filterSellCandidates(liveCandidates, filters);
  const executable = liveCandidates.filter((row) => row.status === 'allowed' && Number(row.orderLots || 0) > 0);
  const filteredExecutable = filteredLiveCandidates.filter((row) => row.status === 'allowed' && Number(row.orderLots || 0) > 0);
  const policyBlocked = liveCandidates.filter((row) => row.status !== 'allowed');
  const filteredPolicyBlocked = filteredLiveCandidates.filter((row) => row.status !== 'allowed');
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
    { key: 'robotProfitPercent', label: 'Robot P/L', className: 'right', render: (row) => percent(row.robotProfitPercent) },
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
            { label: 'В фильтре', value: `${filteredExecutable.length} / ${filteredLiveCandidates.length}`, tone: filteredExecutable.length ? 'bad' : 'good', detail: `${filteredPolicyBlocked.length} блок/hold сейчас` },
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
        <SellCandidateFilters rows={liveCandidates} filters={filters} onChange={setFilters} />
        <FilterSummary visible={filteredLiveCandidates.length} total={liveCandidates.length} label="sell-сигналов" />
        <Table
          columns={sellColumns}
          rows={filteredLiveCandidates}
          empty="Нет sell-сигналов под выбранные фильтры"
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
            { key: 'robotProfitPercent', label: 'Robot P/L', className: 'right', render: (row) => percent(row.robotProfitPercent) },
            { key: 'reason', label: 'Reason', className: 'reason', render: (row) => <Reason>{row.sellPolicy || row.reason}</Reason> }
          ]}
          rows={liveCandidates}
          empty="No sell policy checks yet"
          loading={loadingKeys.sellBrain}
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

const profileStatusTone = (status) => {
  if (status === 'ready') return 'good';
  if (status === 'disabled') return 'neutral';
  if (status === 'error') return 'bad';
  return 'warn';
};

const profileRuntimeState = (profile) => {
  const status = String(profile?.status || '');
  const error = String(profile?.lastError || '');

  if (status === 'disabled') {
    return {
      label: 'disabled',
      tone: 'neutral',
      detail: 'Выключен вручную, collector его не обходит.'
    };
  }

  if (/duplicate/i.test(error)) {
    return {
      label: 'duplicate',
      tone: 'neutral',
      detail: error
    };
  }

  if (status === 'error') {
    return {
      label: 'error',
      tone: 'bad',
      detail: error || 'Collector упал на этом профиле.'
    };
  }

  if (!profile?.profileUid) {
    return {
      label: profile?.lastCheckedAt ? 'uid waiting' : 'new url',
      tone: 'warn',
      detail: profile?.lastCheckedAt
        ? 'URL сохранен, collector еще не смог найти внутренний UID профиля.'
        : 'URL сохранен. На ближайшем цикле collector попробует найти UID сам.'
    };
  }

  if (status === 'pending-auth') {
    return {
      label: 'auth needed',
      tone: 'warn',
      detail: error || 'UID найден, но нужны свежие cookie/psid для чтения API Пульса.'
    };
  }

  if (status === 'ready' && Number(profile?.recentSignalsCount || 0) <= 0) {
    return {
      label: 'ready, quiet',
      tone: 'good',
      detail: 'UID найден и профиль читается, но свежих сделок по нашим фильтрам пока нет.'
    };
  }

  if (status === 'ready') {
    return {
      label: 'ready',
      tone: 'good',
      detail: `Профиль читается, сигналов: ${profile?.recentSignalsCount ?? 0}.`
    };
  }

  return {
    label: status || 'configured',
    tone: profileStatusTone(status),
    detail: error || 'Профиль настроен и ждет ближайшего цикла collector-а.'
  };
};

const ProfileState = ({ profile }) => {
  const state = profileRuntimeState(profile);

  return (
    <div className="profile-state" title={state.detail}>
      <Pill tone={state.tone}>{state.label}</Pill>
      <span>{state.detail}</span>
    </div>
  );
};

const profilePayloadFromForm = (form) => ({
  profileUrl: form.profileUrl?.trim(),
  profileUid: form.profileUid?.trim() || undefined,
  displayName: form.displayName?.trim() || undefined,
  confidence: form.confidence === '' ? undefined : Number(form.confidence),
  activity: form.activity === '' ? undefined : Number(form.activity),
  description: form.description?.trim() || undefined
});

const validateProfileForm = (form) => {
  const errors = [];
  if (!form.profileUrl?.trim()) errors.push('URL профиля обязателен');
  if (form.confidence !== '' && (!Number.isFinite(Number(form.confidence)) || Number(form.confidence) < 0 || Number(form.confidence) > 100)) {
    errors.push('Confidence должен быть от 0 до 100');
  }
  if (form.activity !== '' && (!Number.isFinite(Number(form.activity)) || Number(form.activity) < 1 || Number(form.activity) !== Math.trunc(Number(form.activity)))) {
    errors.push('Activity должен быть целым числом от 1');
  }
  return errors;
};

function AddProfileForm({ onSaved }) {
  const [form, setForm] = useState({ profileUrl: '', profileUid: '', displayName: '', confidence: '', activity: '1', description: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errors = validateProfileForm(form);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (errors.length) {
      setError(errors.join('; '));
      return;
    }

    setBusy(true);
    setError('');
    const response = await fetch('/api/social-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profilePayloadFromForm(form))
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(payload.error || `HTTP ${response.status}`);
      return;
    }

    setForm({ profileUrl: '', profileUid: '', displayName: '', confidence: '', activity: '1', description: '' });
    await onSaved();
  };

  return (
    <form className="profile-form" onSubmit={submit}>
      <div className="filters">
        <label><span>URL профиля</span><input value={form.profileUrl} onChange={(event) => update('profileUrl', event.target.value)} placeholder="https://www.tbank.ru/invest/social/profile/..." /></label>
        <label><span>UID</span><input value={form.profileUid} onChange={(event) => update('profileUid', event.target.value)} placeholder="если известен" /></label>
        <label><span>Имя</span><input value={form.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="как показывать" /></label>
        <label><span>Confidence</span><input type="number" min="0" max="100" value={form.confidence} onChange={(event) => update('confidence', event.target.value)} placeholder="0-100" /></label>
        <label><span>Activity</span><input type="number" min="1" step="1" value={form.activity} onChange={(event) => update('activity', event.target.value)} /></label>
      </div>
      <div className="profile-form-row">
        <input value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="Комментарий: почему следим за автором" />
        <button className="mini-button" disabled={busy || errors.length > 0}>{busy ? 'Добавляю...' : 'Добавить профиль'}</button>
      </div>
      {error || errors.length ? <p className="form-error">{error || errors.join('; ')}</p> : null}
    </form>
  );
}

function SocialProfiles({ data, loadingKeys, reload }) {
  const [actionError, setActionError] = useState('');
  const profiles = data.socialProfiles?.profiles || [];
  const summary = data.socialProfiles?.summary || {};
  const profileStates = profiles.map(profileRuntimeState);
  const uidWaiting = profiles.filter((row) => !row.profileUid && row.status !== 'disabled').length;
  const quietReady = profiles.filter((row) => {
    const state = profileRuntimeState(row);
    return state.label === 'ready, quiet';
  }).length;
  const duplicates = profileStates.filter((state) => state.label === 'duplicate').length;

  const mutateProfile = async (profile, action) => {
    setActionError('');

    if (action === 'delete' && !window.confirm(`Удалить профиль ${profile.displayName || profile.profileKey}? Сигналы останутся в истории.`)) {
      return;
    }

    const url = action === 'toggle'
      ? `/api/social-profiles/${encodeURIComponent(profile.profileKey)}/toggle`
      : `/api/social-profiles/${encodeURIComponent(profile.profileKey)}`;
    const method = action === 'delete' ? 'DELETE' : 'POST';
    const response = await fetch(url, { method });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setActionError(payload.error || `HTTP ${response.status}`);
      return;
    }

    await reload();
  };

  return (
    <div className="grid">
      <Card title="Управление профилями Пульса" icon={Users} className="wide" help="Профили хранятся в базе. Изменения не требуют рестарта: social collector подхватит активные профили на следующем цикле. Disabled профили не собираются.">
        <StageStrip
          items={[
            { label: 'Всего', value: summary.total ?? profiles.length, detail: 'профилей в базе' },
            { label: 'Активные', value: summary.active ?? profiles.filter((row) => row.status !== 'disabled').length, tone: summary.active ? 'good' : 'warn', detail: 'collector будет смотреть' },
            { label: 'UID wait', value: uidWaiting, tone: uidWaiting ? 'warn' : 'good', detail: 'URL есть, внутренний UID еще не найден' },
            { label: 'Ready quiet', value: quietReady, tone: quietReady ? 'warn' : 'good', detail: 'профиль читается, свежих сигналов нет' },
            { label: 'Дубли', value: duplicates, tone: duplicates ? 'warn' : 'good', detail: 'автоматически отключенные повторы' },
            { label: 'Ошибки', value: summary.error ?? profiles.filter((row) => row.status === 'error').length, tone: summary.error ? 'bad' : 'good', detail: 'нужна проверка cookie/UID' }
          ]}
        />
        {actionError ? <p className="form-error">{actionError}</p> : null}
      </Card>

      <Card title="Добавить автора" icon={Signal} className="wide" help="Достаточно URL. Если UID не указан, collector попробует открыть страницу автора, найти внутренний UID и только потом читать сделки через API Пульса.">
        <AddProfileForm onSaved={reload} />
      </Card>

      <Card title="Профили" icon={ShieldCheck} className="wide" help="State показывает не только сырой status, а реальное состояние профиля: найден ли UID, читается ли API, есть ли свежие сигналы или это дубль.">
        <Table
          className="profile-table"
          rowClassName={(row) => row.status === 'disabled' ? 'row-muted' : undefined}
          columns={[
            { key: 'displayName', label: 'Профиль', width: '220px', render: (row) => <><strong>{row.displayName || row.profileKey}</strong><div className="muted">{row.profileKey}</div></> },
            { key: 'status', label: 'State', width: '190px', render: (row) => <ProfileState profile={row} /> },
            { key: 'confidence', label: 'Manual', width: '90px', className: 'right', render: (row) => money(row.confidence) },
            { key: 'autoConfidence', label: 'Auto', width: '90px', className: 'right', render: (row) => money(row.autoConfidence) },
            { key: 'effectiveConfidence', label: 'Effective', width: '100px', className: 'right', render: (row) => money(row.effectiveConfidence) },
            { key: 'activity', label: 'Activity', width: '85px', className: 'right', render: (row) => money(row.activity) },
            { key: 'lastReturnPercent', label: 'Return', width: '100px', className: 'right', render: (row) => percent(row.lastReturnPercent) },
            { key: 'recentSignalsCount', label: 'Signals', width: '90px', className: 'right', render: (row) => money(row.recentSignalsCount) },
            { key: 'lastCheckedAt', label: 'Checked', width: '145px', render: (row) => time(row.lastCheckedAt) },
            { key: 'lastError', label: 'Комментарий', className: 'reason', render: (row) => <Reason>{profileRuntimeState(row).detail || row.description || row.profileUrl}</Reason> },
            { key: 'actions', label: 'Action', width: '180px', render: (row) => (
              <div className="action-buttons">
                <button className="mini-button" onClick={() => mutateProfile(row, 'toggle')}>{row.status === 'disabled' ? 'Enable' : 'Disable'}</button>
                <button className="mini-button danger" onClick={() => mutateProfile(row, 'delete')}>Delete</button>
              </div>
            ) }
          ]}
          rows={profiles}
          empty="Профилей пока нет"
          loading={loadingKeys.socialProfiles}
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
            { key: 'cacheState', label: 'Data', render: (row) => <Pill tone={cacheTone(row.cacheState)}>{row.cacheState || 'fresh'}</Pill> },
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
  const maxPositionSharePercent = Number(config.maxPositionSharePercent || 0);
  const minDiversificationPositions = Number(config.minDiversificationPositions || 0);
  const diversificationFirst = config.diversificationFirst !== false;
  const riskPayload = (patch) => ({
    maxOrderRub,
    maxDailyOrders,
    maxDailyRub,
    maxPositionSharePercent,
    minDiversificationPositions,
    diversificationFirst,
    ...patch
  });
  const orderButtons = [500, 1000, 1500, 2500, 5000, 10000, 25000, 50000, 100000]
    .filter((value) => value <= Number(config.maxRuntimeOrderRub || value));
  const orderCountButtons = [1, 3, 5, 10, 20, 50, 100]
    .filter((value) => value <= Number(config.maxRuntimeDailyOrders || value));
  const dailyRubButtons = [500, 1500, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
    .filter((value) => value <= Number(config.maxRuntimeDailyRub || value));
  const positionShareButtons = [5, 10, 15, 20, 25, 33, 50];
  const diversificationButtons = [0, 3, 5, 8, 12, 20];

  return (
    <Card title="Лимиты покупок и оборота" icon={ShieldCheck} help="Это лимиты входа в новые позиции: размер одной buy-заявки, дневной оборот покупок, число заявок и концентрация в одной бумаге. Продажи управляются отдельными порогами выхода ниже.">
      <div className="stats compact">
        <Stat label="Лимит заявки" value={`${money(maxOrderRub)} RUB`} title={`Hard cap: ${money(config.maxRuntimeOrderRub)} RUB`} />
        <Stat label="Заявок в день" value={maxDailyOrders} title={`Hard cap: ${config.maxRuntimeDailyOrders}`} />
        <Stat label="Бюджет дня" value={`${money(maxDailyRub)} RUB`} title={`Hard cap: ${money(config.maxRuntimeDailyRub)} RUB`} />
        <Stat label="Лимит позиции" value={`${money(maxPositionSharePercent)}%`} title="Максимальная доля одной бумаги после новой покупки." />
        <Stat label="Мин. бумаг" value={minDiversificationPositions} title="Пока бумаг меньше этого числа, робот старается не докупать уже имеющиеся тикеры." />
        <Stat label="Осталось сегодня" value={tradeLimit ? `${tradeLimit.ordersLeft} / ${money(tradeLimit.rubLeft)} RUB` : '-'} />
      </div>
      <ControlGroup label="Заявка" value={`${money(maxOrderRub)} RUB`}>
        {orderButtons.map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxOrderRub && 'active')}
            onClick={() => onRiskSettingsChange(riskPayload({ maxOrderRub: value }))}
            title="Поменять максимальный размер одной заявки."
          >
            buy до {value}
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Частота" value={`${maxDailyOrders} заявок`}>
        {orderCountButtons.map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxDailyOrders && 'active')}
            onClick={() => onRiskSettingsChange(riskPayload({ maxDailyOrders: value }))}
            title="Поменять максимум заявок за день."
          >
            {value} заявок
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Деньги" value={`${money(maxDailyRub)} RUB / день`}>
        {dailyRubButtons.map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxDailyRub && 'active')}
            onClick={() => onRiskSettingsChange(riskPayload({ maxDailyRub: value }))}
            title="Поменять общий дневной бюджет."
          >
            день {value}
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Концентрация" value={`${money(maxPositionSharePercent)}%`}>
        {positionShareButtons.map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === maxPositionSharePercent && 'active')}
            onClick={() => onRiskSettingsChange(riskPayload({ maxPositionSharePercent: value }))}
            title="Поменять максимальную долю одной бумаги в портфеле после покупки."
          >
            бумага {value}%
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Диверсификация" value={`${minDiversificationPositions} бумаг`}>
        {diversificationButtons.map((value) => (
          <button
            key={value}
            className={cls('mini-button', value === minDiversificationPositions && 'active')}
            onClick={() => onRiskSettingsChange(riskPayload({ minDiversificationPositions: value }))}
            title="Поменять целевое минимальное число разных бумаг перед докупкой существующей позиции."
          >
            диверс. {value}
          </button>
        ))}
        <button
          className={cls('mini-button', diversificationFirst && 'active')}
          onClick={() => onRiskSettingsChange(riskPayload({ diversificationFirst: !diversificationFirst }))}
          title="Когда включено, робот сначала расширяет набор бумаг, а уже потом докупает существующие тикеры."
        >
          диверсификация {diversificationFirst ? 'on' : 'off'}
        </button>
      </ControlGroup>
    </Card>
  );
}

function RiskBudget({ data }) {
  const tradeLimit = getTradeLimit(data);
  const budget = tradeLimit?.budget || {};

  return (
    <Card title="Бюджет риска" icon={ShieldCheck} className="wide" help="Показывает не просто лимит покупок, а примерную сумму под риском: дневная экспозиция и сколько робот теоретически потеряет, если все новые входы закроются по stop-loss.">
      <div className="stats compact">
        <Stat label="Счет" value={`${money(tradeLimit?.totalRub)} RUB`} title="Текущая стоимость торгового счета по портфелю брокера." />
        <Stat label="Дневная экспозиция" value={`${money(budget.dailyExposureRub)} RUB`} title="Сколько робот максимум задействует сегодня: min(дневной бюджет, заявок в день * лимит заявки)." />
        <Stat label="Экспозиция / счет" value={percent(budget.dailyExposurePortfolioPercent)} title="Доля дневной экспозиции от торгового счета." />
        <Stat label="Stop-loss риск" value={`${money(budget.stopLossRiskRub)} RUB`} tone="bad" title="Грубый worst-case по новым входам: дневная экспозиция * stop-loss %. Комиссии и гэпы отдельно не учитываются." />
        <Stat label="Stop-loss / счет" value={percent(budget.stopLossRiskPortfolioPercent)} tone="bad" title="Та же потенциальная потеря как доля счета." />
        <Stat label="Trailing giveback" value={`${money(budget.baseTrailingGivebackRub)} RUB`} title="Сколько прибыли может быть отдано базовым trailing-stop. Адаптивный trailing может быть шире для волатильной бумаги." />
        <Stat label="Лимит позиции" value={`${money(budget.maxPositionRub)} RUB`} title={`Максимум в одну бумагу: ${money(budget.maxPositionSharePercent)}% от торгового счета.`} />
        <Stat label="Мин. бумаг" value={budget.minDiversificationPositions ?? '-'} title="Цель диверсификации перед докупкой уже имеющейся бумаги." />
        <Stat label="Cash usage" value={percent(budget.cashUsagePercent)} title="Доля свободных денег, которую дневной бюджет может задействовать." />
      </div>
    </Card>
  );
}

function SellControls({ data, onSellSettingsChange }) {
  const config = data.status?.config || {};
  const stopLossPercent = Number(config.stopLossPercent || 0);
  const stopLossMaxPercent = Number(config.stopLossMaxPercent || 0);
  const stopLossVolatilityMultiplier = Number(config.stopLossVolatilityMultiplier || 0);
  const trailingStopPercent = Number(config.trailingStopPercent || 0);
  const trailingStopMinProfitPercent = Number(config.trailingStopMinProfitPercent || 0);
  const sellHoldWinnerMinProfitPercent = Number(config.sellHoldWinnerMinProfitPercent || 0);
  const sellHoldWinnerMaxDrawdownPercent = Number(config.sellHoldWinnerMaxDrawdownPercent || 0);
  const payload = (patch) => ({
    stopLossPercent,
    trailingStopPercent,
    trailingStopMinProfitPercent,
    sellHoldWinnerMinProfitPercent,
    sellHoldWinnerMaxDrawdownPercent,
    ...patch
  });
  const stopLossButtons = [1, 2, 3, 5, 8, 10, 15, 20];
  const trailingButtons = [0.5, 1, 2, 3, 5, 8, 10];
  const profitButtons = [0.5, 1, 2, 3, 5, 8, 10, 15, 25];
  const drawdownButtons = [0.5, 1, 2, 3, 5, 8, 10];

  return (
    <Card title="Пороги продаж" icon={AlertTriangle} help="Это не лимиты денег, а правила выхода: когда резать убыток, когда защищать прибыль trailing-stop и когда держать сильную позицию.">
      <div className="stats compact">
        <Stat label="Stop-loss" value={`${money(stopLossPercent)}%`} tone="bad" title={`Адаптивный порог: max(base ${money(stopLossPercent)}%, avg daily range * ${money(stopLossVolatilityMultiplier)}), но не выше ${stopLossMaxPercent > 0 ? `${money(stopLossMaxPercent)}%` : 'без лимита'}.`} />
        <Stat label="Trailing" value={`${money(trailingStopPercent)}%`} />
        <Stat label="Trail min profit" value={`${money(trailingStopMinProfitPercent)}%`} />
        <Stat label="Hold winner" value={`${money(sellHoldWinnerMinProfitPercent)}% / ${money(sellHoldWinnerMaxDrawdownPercent)}%`} />
      </div>
      <ControlGroup label="Stop-loss" value={`${money(stopLossPercent)}%`}>
        {stopLossButtons.map((value) => (
          <button key={value} className={cls('mini-button', value === stopLossPercent && 'active')} onClick={() => onSellSettingsChange(payload({ stopLossPercent: value }))}>
            stop {value}%
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Trailing" value={`${money(trailingStopPercent)}%`}>
        {trailingButtons.map((value) => (
          <button key={value} className={cls('mini-button', value === trailingStopPercent && 'active')} onClick={() => onSellSettingsChange(payload({ trailingStopPercent: value }))}>
            trail {value}%
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Старт trailing" value={`${money(trailingStopMinProfitPercent)}%`}>
        {profitButtons.map((value) => (
          <button key={value} className={cls('mini-button', value === trailingStopMinProfitPercent && 'active')} onClick={() => onSellSettingsChange(payload({ trailingStopMinProfitPercent: value, sellHoldWinnerMinProfitPercent: Math.max(sellHoldWinnerMinProfitPercent, value) }))}>
            min profit {value}%
          </button>
        ))}
      </ControlGroup>
      <ControlGroup label="Winner drawdown" value={`${money(sellHoldWinnerMaxDrawdownPercent)}%`}>
        {drawdownButtons.map((value) => (
          <button key={value} className={cls('mini-button', value === sellHoldWinnerMaxDrawdownPercent && 'active')} onClick={() => onSellSettingsChange(payload({ sellHoldWinnerMaxDrawdownPercent: value }))}>
            winner dd {value}%
          </button>
        ))}
      </ControlGroup>
    </Card>
  );
}

function Accounts({ data, loadingKeys, onModeChange, onLiveSellToggle, onRiskSettingsChange, onSellSettingsChange }) {
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

      <div className="account-control-layout wide">
        <div className="account-control-stack">
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
          <SellControls data={data} onSellSettingsChange={onSellSettingsChange} />
        </div>
        <div className="account-control-stack">
          <RiskControls data={data} onRiskSettingsChange={onRiskSettingsChange} />
        </div>
      </div>
      <RiskBudget data={data} />
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

const orderStatusLabel = (status) => {
  const value = display(status);
  const known = {
    EXECUTION_REPORT_STATUS_FILL: 'filled',
    EXECUTION_REPORT_STATUS_PARTIALLYFILL: 'partial',
    EXECUTION_REPORT_STATUS_NEW: 'new',
    EXECUTION_REPORT_STATUS_CANCELLED: 'cancelled',
    EXECUTION_REPORT_STATUS_REJECTED: 'rejected',
    LOCAL_PENDING_SUBMIT: 'pending',
    LOCAL_SUBMIT_UNKNOWN: 'unknown',
    LOCAL_POST_REJECTED: 'rejected',
    LOCAL_VALIDATION_FAILED: 'invalid'
  };
  if (known[value]) return known[value];
  if (value.startsWith('EXECUTION_REPORT_STATUS_')) return value.replace('EXECUTION_REPORT_STATUS_', '').toLowerCase();
  if (value.startsWith('LOCAL_')) return value.replace('LOCAL_', '').toLowerCase().replaceAll('_', ' ');
  return value;
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

const sideFromDirection = (direction) => {
  const value = String(direction || '').toLowerCase();
  if (value === '1' || value === 'buy') return 'buy';
  if (value === '2' || value === 'sell') return 'sell';
  return value || EMPTY;
};

const sortTrades = (rows, sort) => {
  const copy = [...rows];
  if (sort === 'oldest') return copy.reverse();
  if (sort === 'pnl-desc') return copy.sort((a, b) => Number(b.roundTripPnlRub ?? -Infinity) - Number(a.roundTripPnlRub ?? -Infinity));
  if (sort === 'pnl-asc') return copy.sort((a, b) => Number(a.roundTripPnlRub ?? Infinity) - Number(b.roundTripPnlRub ?? Infinity));
  if (sort === 'amount-desc') return copy.sort((a, b) => Number(b.tradeAmount ?? 0) - Number(a.tradeAmount ?? 0));
  if (sort === 'amount-asc') return copy.sort((a, b) => Number(a.tradeAmount ?? 0) - Number(b.tradeAmount ?? 0));
  return copy;
};

const sortRoundTrips = (rows, sort) => {
  const copy = [...rows];
  if (sort === 'oldest') return copy.reverse();
  if (sort === 'pnl-desc') return copy.sort((a, b) => Number(b.pnlRub ?? -Infinity) - Number(a.pnlRub ?? -Infinity));
  if (sort === 'pnl-asc') return copy.sort((a, b) => Number(a.pnlRub ?? Infinity) - Number(b.pnlRub ?? Infinity));
  if (sort === 'amount-desc') return copy.sort((a, b) => Number(b.exitAmount ?? 0) - Number(a.exitAmount ?? 0));
  if (sort === 'amount-asc') return copy.sort((a, b) => Number(a.exitAmount ?? 0) - Number(b.exitAmount ?? 0));
  return copy;
};

const roundTripStatusLabel = (status) => {
  if (status === 'closed') return 'закрыто';
  if (status === 'partial') return 'частично';
  if (status === 'unmatched') return 'без пары';
  return display(status);
};

const accountingIgnoredStatuses = new Set([
  'LOCAL_PENDING_SUBMIT',
  'LOCAL_SUBMIT_UNKNOWN',
  'EXECUTION_REPORT_STATUS_NEW',
  'EXECUTION_REPORT_STATUS_REJECTED',
  'EXECUTION_REPORT_STATUS_CANCELLED',
  'LOCAL_POST_REJECTED',
  'LOCAL_VALIDATION_FAILED'
]);

const tradeLedgerStatus = (trade, event) => {
  if (event) return 'в ledger';
  if (accountingIgnoredStatuses.has(String(trade.status || ''))) return 'не в accounting';
  return 'только broker';
};

const buildTradeRows = (data) => {
  const trades = data.trades?.trades || [];
  const events = data.robotPositions?.events || [];
  const decisions = data.decisions?.decisions || [];
  const roundTrips = data.tradePnl?.roundTrips || [];
  const roundTripByTradeId = new Map();

  roundTrips.forEach((roundTrip) => {
    (roundTrip.entryTradeIds || []).forEach((id) => roundTripByTradeId.set(String(id), { roundTrip, leg: 'entry' }));
    if (roundTrip.exitTradeId !== undefined && roundTrip.exitTradeId !== null) {
      roundTripByTradeId.set(String(roundTrip.exitTradeId), { roundTrip, leg: 'exit' });
    }
  });
  const lastOrderDecisionByTicker = new Map(
    decisions
      .filter((decision) => decision.ticker && decision.status === 'order-posted')
      .map((decision) => [decision.ticker, decision])
  );

  return trades.map((trade) => {
    const event = events.find((item) => item.orderId && item.orderId === trade.orderId);
    const decision = lastOrderDecisionByTicker.get(trade.ticker);
    const roundTripMatch = roundTripByTradeId.get(String(trade.id));
    const roundTrip = roundTripMatch?.roundTrip;
    const matchedReason = roundTripMatch?.leg === 'entry'
      ? roundTrip?.entryDecisionReason
      : roundTrip?.exitDecisionReason;
    const matchedSignal = roundTripMatch?.leg === 'entry'
      ? roundTrip?.entrySignalSource
      : roundTrip?.exitSignalSource;

    return {
      ...trade,
      side: sideFromDirection(trade.direction),
      ledgerStatus: tradeLedgerStatus(trade, event),
      decisionReason: matchedReason || decision?.reason,
      signalSource: matchedSignal || decision?.signalSource,
      roundTripLeg: roundTripMatch?.leg,
      roundTripPnlRub: roundTrip?.pnlRub,
      roundTripGrossPnlRub: roundTrip?.grossPnlRub,
      roundTripCommissionRub: roundTrip?.commissionRub,
      roundTripNetPnlRub: roundTrip?.netPnlRub,
      roundTripPnlPercent: roundTrip?.pnlPercent,
      roundTripNetPnlPercent: roundTrip?.netPnlPercent,
      roundTripStatus: roundTrip?.status,
      tradePrice: moneyParts(trade.executedPriceUnits ?? trade.price_units, trade.executedPriceNano ?? trade.price_nano),
      tradeAmount: moneyParts(trade.totalAmountUnits, trade.totalAmountNano),
      createdAt: trade.tradeDateTime || trade.createdAt
    };
  });
};

function TradeFilters({ rows, filters, onChange }) {
  const statuses = [...new Set(rows.map((row) => row.status).filter(Boolean))].sort();

  return (
    <div className="filters trade-filters">
      <label>
        <span>Сторона</span>
        <select value={filters.side} onChange={(event) => onChange({ ...filters, side: event.target.value })}>
          <option value="all">Все</option>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </label>
      <label>
        <span>Статус</span>
        <select value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value })}>
          <option value="all">Все</option>
          {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label>
      <label>
        <span>Ledger</span>
        <select value={filters.ledger} onChange={(event) => onChange({ ...filters, ledger: event.target.value })}>
          <option value="all">Любой</option>
          <option value="в ledger">В ledger</option>
          <option value="только broker">Только broker</option>
          <option value="не в accounting">Не в accounting</option>
        </select>
      </label>
      <label>
        <span>Тикер</span>
        <input value={filters.ticker} onChange={(event) => onChange({ ...filters, ticker: event.target.value.toUpperCase() })} placeholder="AQUA" />
      </label>
      <label>
        <span>P/L пары</span>
        <select value={filters.pnl} onChange={(event) => onChange({ ...filters, pnl: event.target.value })}>
          <option value="all">Любой</option>
          <option value="profit">Плюс</option>
          <option value="loss">Минус</option>
          <option value="empty">Нет пары</option>
        </select>
      </label>
      <label>
        <span>Сортировка</span>
        <select value={filters.sort} onChange={(event) => onChange({ ...filters, sort: event.target.value })}>
          <option value="newest">Новые</option>
          <option value="oldest">Старые</option>
          <option value="pnl-desc">P/L выше</option>
          <option value="pnl-asc">P/L ниже</option>
          <option value="amount-desc">Сумма выше</option>
          <option value="amount-asc">Сумма ниже</option>
        </select>
      </label>
    </div>
  );
}

function TradeReview({ rows, loading, children, className }) {
  const visibleRows = rows.slice(0, 80);

  return (
    <Card title="Сделки брокера" icon={Database} className={className} help="Последние реальные сделки из брокера плюс связь с внутренним ledger. Если сделка есть у брокера, но не попала в ledger, это отдельный повод смотреть reconciliation.">
      {children}
      <Table
        className="trade-review-table"
        columns={[
          { key: 'createdAt', label: 'Время', width: '150px', render: (row) => time(row.createdAt) },
          { key: 'ticker', label: 'Тикер', width: '90px', render: (row) => <TextCell>{row.ticker}</TextCell> },
          { key: 'side', label: 'Сторона', width: '90px', render: (row) => <Pill tone={row.side === 'buy' ? 'good' : 'bad'}>{display(row.side)}</Pill> },
          { key: 'quantityLots', label: 'Лоты', width: '70px', className: 'right', render: (row) => money(row.lotsExecuted ?? row.lotsRequested ?? row.lot) },
          { key: 'price', label: 'Цена', width: '90px', className: 'right', render: (row) => money(row.tradePrice) },
          { key: 'amount', label: 'Сумма', width: '95px', className: 'right', render: (row) => money(row.tradeAmount) },
          { key: 'roundTripPnlRub', label: 'P/L пары', width: '105px', className: 'right', render: (row) => row.roundTripPnlRub === undefined ? EMPTY : <span className={Number(row.roundTripPnlRub) >= 0 ? 'good' : 'bad'}>{money(row.roundTripPnlRub)}</span> },
          { key: 'ledgerStatus', label: 'Ledger', width: '115px', render: (row) => <Pill tone={row.ledgerStatus === 'в ledger' ? 'good' : 'warn'}>{row.ledgerStatus}</Pill> },
          { key: 'decisionReason', label: 'Решение', className: 'reason', render: (row) => <Reason>{row.decisionReason || row.status || EMPTY}</Reason> }
        ]}
        rows={visibleRows}
        empty="Сделок пока нет"
        loading={loading}
      />
    </Card>
  );
}

function OrderSafety({ data, loading, onCancelStaleLimits }) {
  const summary = data.orderSafety?.summary || {};
  const orders = data.orderSafety?.orders || [];

  return (
    <Card title="Заявки / Order Safety" icon={ShieldCheck} help="Контроль неизвестных и открытых заявок. UNKNOWN значит: запрос мог уйти брокеру, но ответ потерялся; робот не будет повторять такую заявку, пока reconciliation не выяснит статус.">
      <div className="card-actions">
        <button
          className="mini-button danger"
          disabled={loading || !summary.staleLimit || !onCancelStaleLimits}
          onClick={() => onCancelStaleLimits?.()}
          title="Ручная отмена stale limit-заявок у брокера. Работает только через защищенный admin endpoint и требует подтверждения."
        >
          Cancel stale limits
        </button>
      </div>
      <div className="stats compact">
        <Stat label="Open" value={summary.open ?? 0} tone={summary.open ? 'warn' : 'good'} />
        <Stat label="Pending" value={summary.pending ?? 0} tone={summary.pending ? 'warn' : 'good'} />
        <Stat label="Unknown" value={summary.unknown ?? 0} tone={summary.unknown ? 'bad' : 'good'} />
        <Stat label="Partial" value={summary.partial ?? 0} tone={summary.partial ? 'warn' : 'good'} />
        <Stat label="Limit wait" value={summary.pendingLimit ?? 0} tone={summary.pendingLimit ? 'warn' : 'good'} />
        <Stat label="Stale" value={summary.staleLimit ?? 0} tone={summary.staleLimit ? 'bad' : 'good'} />
      </div>
      <Table
        className="order-safety-table"
        columns={[
          { key: 'createdAt', label: 'Время', width: '150px', render: (row) => time(row.tradeDateTime || row.createdAt) },
          { key: 'ticker', label: 'Тикер', width: '100px', render: (row) => <><strong>{row.ticker || row.figi || EMPTY}</strong><div className="muted">{row.name}</div></> },
          { key: 'direction', label: 'Side', width: '80px', render: (row) => <Pill tone={String(row.direction) === '1' ? 'good' : 'bad'}>{String(row.direction) === '1' ? 'buy' : String(row.direction) === '2' ? 'sell' : display(row.direction)}</Pill> },
          { key: 'orderType', label: 'Type', width: '115px', render: (row) => <TextCell>{String(row.orderType || EMPTY).replace('ORDER_TYPE_', '').toLowerCase()}</TextCell> },
          { key: 'status', label: 'Status', width: '118px', render: (row) => <Pill tone={orderStatusTone(row.status)} className="order-status-badge" title={display(row.status)}>{orderStatusLabel(row.status)}</Pill> },
          { key: 'staleLimitReason', label: 'Stale', width: '95px', render: (row) => row.staleLimitReason ? <Pill tone="bad" className="table-pill">{row.staleLimitReason}</Pill> : <span className="stale-ok" title="Не stale">ok</span> },
          { key: 'orderAgeMs', label: 'Age', width: '85px', className: 'right', render: (row) => duration(row.orderAgeMs) },
          { key: 'priceDriftPercent', label: 'Drift', width: '85px', className: 'right', render: (row) => percent(row.priceDriftPercent) },
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

function ExecutionOverview({ data, loading, className, onOrderTypeChange }) {
  const config = data.status?.config || {};
  const summary = data.orderSafety?.summary || {};
  const protectiveStops = data.protectiveStops?.summary || {};
  const orderType = config.orderType || EMPTY;
  const buyOrderType = config.buyOrderType || orderType;
  const sellOrderType = config.sellOrderType || orderType;
  const openAge = duration(summary.oldestOpenAgeMs);
  const setOrderType = (patch) => onOrderTypeChange?.({
    buyOrderType,
    sellOrderType,
    ...patch
  });

  return (
    <Card title="Исполнение" icon={ShieldCheck} className={className} help="Execution layer: какой тип заявок включен, есть ли зависшие limit/pending/unknown заявки, и насколько чисто брокер подтверждает исполнения. Signal accepted не равно trade executed.">
      <StageStrip
        items={[
          { label: 'Buy type', value: buyOrderType, tone: buyOrderType === 'smart' || buyOrderType === 'limit' ? 'good' : 'warn', detail: buyOrderType === 'smart' ? 'market только при сильном сигнале и узком спреде' : buyOrderType === 'limit' ? 'вход только по цене сигнала' : 'вход по рынку' },
          { label: 'Sell type', value: sellOrderType, tone: sellOrderType === 'market' ? 'good' : 'warn', detail: sellOrderType === 'market' ? 'аварийный выход исполняется быстрее' : 'limit sell может не исполниться' },
          { label: 'Open', value: summary.open ?? 0, tone: summary.open ? 'warn' : 'good', detail: openAge !== EMPTY ? `старейшая ${openAge}` : 'нет открытых' },
          { label: 'Pending limit', value: summary.pendingLimit ?? 0, tone: summary.pendingLimit ? 'warn' : 'good', detail: 'limit-заявки ждут исполнения' },
          { label: 'Protective stops', value: protectiveStops.active ?? 0, tone: protectiveStops.errors ? 'bad' : protectiveStops.active ? 'good' : 'warn', detail: protectiveStops.enabled ? 'broker stop-loss active' : 'disabled' },
          { label: 'Stale limit', value: summary.staleLimit ?? 0, tone: summary.staleLimit ? 'bad' : 'good', detail: summary.stalePolicy ? `${duration(summary.stalePolicy.maxAgeMs)} / ${percent(summary.stalePolicy.maxPriceDriftPercent)}` : 'policy loading' },
          { label: 'Unknown', value: summary.unknown ?? 0, tone: summary.unknown ? 'bad' : 'good', detail: summary.unknown ? 'повторы заблокированы' : 'нет неизвестных' },
          { label: 'Market / Limit', value: `${summary.market || 0} / ${summary.limit || 0}`, detail: `${summary.checked || 0} последних заявок` },
          { label: 'Filled / Rejected', value: `${summary.filled || 0} / ${summary.rejected || 0}`, tone: summary.rejected ? 'warn' : 'good', detail: 'по последней выборке' }
        ]}
      />
      {onOrderTypeChange ? (
        <div className="control-row">
          <button className={cls('mini-button', buyOrderType === 'limit' && 'active')} onClick={() => setOrderType({ buyOrderType: 'limit' })} title="Покупки лимитными заявками: робот не платит выше цены сигнала, но заявка может не исполниться.">
            buy limit
          </button>
          <button className={cls('mini-button', buyOrderType === 'smart' && 'active')} onClick={() => setOrderType({ buyOrderType: 'smart' })} title="Умная покупка: market только для сильного сигнала, узкого спреда и достаточной ликвидности; иначе limit.">
            buy smart
          </button>
          <button className={cls('mini-button', buyOrderType === 'market' && 'active')} onClick={() => setOrderType({ buyOrderType: 'market' })} title="Покупки рыночными заявками: выше шанс исполнения, выше риск проскальзывания.">
            buy market
          </button>
          <button className={cls('mini-button', sellOrderType === 'market' && 'active')} onClick={() => setOrderType({ sellOrderType: 'market' })} title="Продажи рыночными заявками: лучше для stop-loss, потому что важнее выйти, чем ждать цену.">
            sell market
          </button>
          <button className={cls('mini-button', sellOrderType === 'limit' && 'active')} onClick={() => setOrderType({ sellOrderType: 'limit' })} title="Продажи лимитными заявками: цена контролируется, но stop-loss может не закрыться, если рынок пролетит ниже лимита.">
            sell limit
          </button>
        </div>
      ) : null}
      {loading ? <div className="muted">Обновляю исполнение...</div> : null}
    </Card>
  );
}

function PnlBreakdown({ title, rows, loading, help }) {
  return (
    <Card title={title} icon={LineChart} className="wide" help={help}>
      <Table
        columns={[
          { key: 'key', label: 'Разрез', render: (row) => <strong>{row.key || EMPTY}</strong> },
          { key: 'count', label: 'Пар', width: '80px', className: 'right', render: (row) => money(row.count) },
          { key: 'wins', label: 'W/L', width: '90px', className: 'right', render: (row) => `${row.wins || 0}/${row.losses || 0}` },
          { key: 'winRate', label: 'Win rate', width: '95px', className: 'right', render: (row) => percent(row.winRate) },
          { key: 'pnlRub', label: 'P/L RUB', width: '105px', className: 'right', render: (row) => <span className={Number(row.pnlRub) >= 0 ? 'good' : 'bad'}>{money(row.pnlRub)}</span> },
          { key: 'averagePnlRub', label: 'Avg RUB', width: '100px', className: 'right', render: (row) => money(row.averagePnlRub) }
        ]}
        rows={rows || []}
        empty="Закрытых пар пока нет"
        loading={loading}
      />
    </Card>
  );
}

function PnlDiagnostics({ rows, loading }) {
  return (
    <Card title="Диагностика качества" icon={ShieldCheck} className="wide" help="Разделяет качество стратегии и качество исполнения. Entry/Exit показывают сигналы робота, Hold - сколько держали позицию, Diagnostics - фактические метки. Execution пока gross-only: без отдельного учета комиссий и проскальзывания.">
      <Table
        columns={[
          { key: 'ticker', label: 'Тикер', width: '110px', render: (row) => <><strong>{row.ticker || EMPTY}</strong><div className="muted">{row.name}</div></> },
          { key: 'pnlRub', label: 'P/L', width: '105px', className: 'right', render: (row) => <span className={Number(row.pnlRub) >= 0 ? 'good' : 'bad'}>{money(row.pnlRub)}</span> },
          { key: 'pnlPercent', label: 'P/L %', width: '90px', className: 'right', render: (row) => percent(row.pnlPercent) },
          { key: 'holdMinutes', label: 'Hold', width: '95px', className: 'right', render: (row) => row.holdMinutes === undefined ? EMPTY : `${money(row.holdMinutes)} мин` },
          { key: 'entrySignalSource', label: 'Entry', width: '135px', render: (row) => <><TextCell>{row.entrySignalSource || EMPTY}</TextCell><div className="muted">score {money(row.entryScore)}</div></> },
          { key: 'exitKind', label: 'Exit', width: '135px', render: (row) => <><TextCell>{row.exitSignalSource || EMPTY}</TextCell><div className="muted">{row.exitKind || EMPTY}</div></> },
          { key: 'diagnoses', label: 'Diagnostics', className: 'reason', render: (row) => <Reason>{(row.diagnoses || []).join(', ')}</Reason> },
          { key: 'executionAccounting', label: 'Execution', width: '125px', render: (row) => <Pill tone="warn">{row.executionAccounting || EMPTY}</Pill> }
        ]}
        rows={rows || []}
        empty="Закрытых пар для диагностики пока нет"
        loading={loading}
      />
    </Card>
  );
}

function UnmatchedSells({ rows, loading }) {
  return (
    <Card title="Продажи без пары" icon={AlertTriangle} className="wide" help="Sell-сделки, для которых в выбранном окне broker trades не нашлась robot buy-сделка. Обычно это значит: buy был раньше лимита выгрузки, позиция была ручной, либо нужно расширить reconciliation.">
      <Table
        columns={[
          { key: 'exitAt', label: 'Выход', width: '150px', render: (row) => time(row.exitAt) },
          { key: 'ticker', label: 'Тикер', width: '110px', render: (row) => <><strong>{row.ticker || EMPTY}</strong><div className="muted">{row.name}</div></> },
          { key: 'accountAlias', label: 'Счет', width: '130px', render: (row) => <TextCell>{row.accountAlias || row.accountId}</TextCell> },
          { key: 'lots', label: 'Лоты', width: '70px', className: 'right', render: (row) => money(row.lots) },
          { key: 'exitPrice', label: 'Цена', width: '90px', className: 'right', render: (row) => money(row.exitPrice) },
          { key: 'exitAmount', label: 'Сумма', width: '100px', className: 'right', render: (row) => money(row.exitAmount) },
          { key: 'exitSignalSource', label: 'Сигнал', width: '130px', render: (row) => <TextCell>{row.exitSignalSource || EMPTY}</TextCell> },
          { key: 'reason', label: 'Причина', className: 'reason', render: (row) => <Reason>{row.reason || row.exitDecisionReason || EMPTY}</Reason> }
        ]}
        rows={rows || []}
        empty="Продаж без пары нет"
        loading={loading}
      />
    </Card>
  );
}

function OpenLots({ rows, loading }) {
  return (
    <Card title="Открытые robot-лоты" icon={Bot} className="wide" help="Buy-остатки по FIFO, которые еще не закрылись sell-сделками в trade accounting. Это не весь брокерский портфель, а только сделки робота в выбранном окне учета.">
      <Table
        columns={[
          { key: 'entryAt', label: 'Вход', width: '150px', render: (row) => time(row.entryAt) },
          { key: 'ticker', label: 'Тикер', width: '110px', render: (row) => <><strong>{row.ticker || EMPTY}</strong><div className="muted">{row.name}</div></> },
          { key: 'accountAlias', label: 'Счет', width: '130px', render: (row) => <TextCell>{row.accountAlias || row.accountId}</TextCell> },
          { key: 'lots', label: 'Лоты', width: '70px', className: 'right', render: (row) => money(row.lots) },
          { key: 'entryPrice', label: 'Цена входа', width: '105px', className: 'right', render: (row) => money(row.entryPrice) },
          { key: 'entryAmount', label: 'Сумма', width: '100px', className: 'right', render: (row) => money(row.entryAmount) },
          { key: 'entrySignalSource', label: 'Сигнал', width: '130px', render: (row) => <TextCell>{row.entrySignalSource || EMPTY}</TextCell> },
          { key: 'entryDecisionReason', label: 'Причина входа', className: 'reason', render: (row) => <Reason>{row.entryDecisionReason || EMPTY}</Reason> }
        ]}
        rows={rows || []}
        empty="Открытых robot-лотов нет"
        loading={loading}
      />
    </Card>
  );
}

function AccountingAudit({ audit, loading }) {
  const summary = audit?.summary || {};
  const issues = audit?.issues || [];

  return (
    <Card title="Расхождения учета" icon={ShieldCheck} className="wide" help="Сравнение robot-owned ledger с реальным брокерским портфелем. Ghost означает: робот считает лоты открытыми, но у брокера такой позиции уже нет. Такие строки нельзя использовать для стопов и продаж, пока accounting не очищен.">
      <StageStrip
        items={[
          { label: 'Проверено', value: summary.checkedLedgerPositions ?? EMPTY, detail: 'открытых ledger-позиций' },
          { label: 'У брокера', value: summary.brokerPositions ?? EMPTY, detail: 'позиций на торговых счетах' },
          { label: 'Проблемы', value: summary.issues ?? 0, tone: summary.issues ? 'bad' : 'good', detail: summary.issues ? 'нужен accounting-аудит' : 'расхождений нет' },
          { label: 'Ghost', value: summary.ghosts ?? 0, tone: summary.ghosts ? 'bad' : 'good', detail: 'ledger есть, брокера нет' },
          { label: 'Lots mismatch', value: summary.quantityMismatches ?? 0, tone: summary.quantityMismatches ? 'warn' : 'good', detail: 'ledger больше брокера' }
        ]}
      />
      <Table
        columns={[
          { key: 'type', label: 'Тип', width: '150px', render: (row) => <Pill tone={row.severity === 'high' ? 'bad' : 'warn'}>{row.type}</Pill> },
          { key: 'ticker', label: 'Тикер', width: '120px', render: (row) => <><strong>{row.ticker || EMPTY}</strong><div className="muted">{row.name}</div></> },
          { key: 'accountAlias', label: 'Счет', width: '135px', render: (row) => <TextCell>{row.accountAlias || row.accountId}</TextCell> },
          { key: 'ledgerLots', label: 'Ledger', width: '90px', className: 'right', render: (row) => money(row.ledgerLots) },
          { key: 'brokerLots', label: 'Broker', width: '90px', className: 'right', render: (row) => money(row.brokerLots) },
          { key: 'averagePrice', label: 'Avg', width: '90px', className: 'right', render: (row) => money(row.averagePrice) },
          { key: 'lastTradeAt', label: 'Last trade', width: '150px', render: (row) => time(row.lastTradeAt) },
          { key: 'reason', label: 'Причина', className: 'reason', render: (row) => <Reason>{row.reason}</Reason> }
        ]}
        rows={issues}
        empty="Ledger совпадает с брокерским портфелем"
        loading={loading}
      />
    </Card>
  );
}

function Trades({ data, loadingKeys, onCancelStaleLimits, onOrderTypeChange }) {
  const [filters, setFilters] = useState({ side: 'all', status: 'all', ledger: 'all', ticker: '', pnl: 'all', sort: 'newest' });
  const rows = buildTradeRows(data);
  const robotEvents = data.robotPositions?.events || [];
  const buyCount = rows.filter((row) => row.side === 'buy').length;
  const sellCount = rows.filter((row) => row.side === 'sell').length;
  const brokerOnly = rows.filter((row) => row.ledgerStatus === 'только broker').length;
  const ledgerCount = rows.filter((row) => row.ledgerStatus === 'в ledger').length;
  const tradePnlSummary = data.tradePnl?.summary || {};
  const tradePnlBreakdowns = data.tradePnl?.breakdowns || {};
  const tradePnlDiagnostics = data.tradePnl?.diagnostics || [];
  const roundTrips = data.tradePnl?.roundTrips || [];
  const unmatchedSells = data.tradePnl?.unmatchedSells || [];
  const openLots = data.tradePnl?.openLots || [];
  const accountingIssues = data.accountingAudit?.summary?.issues || 0;
  const roundTripMatchesPnl = (row) => {
    const pnl = Number(row.pnlRub);
    if (filters.pnl === 'profit') return Number.isFinite(pnl) && pnl > 0;
    if (filters.pnl === 'loss') return Number.isFinite(pnl) && pnl < 0;
    if (filters.pnl === 'empty') return !Number.isFinite(pnl);
    return true;
  };
  const filteredRoundTrips = sortRoundTrips(roundTrips.filter((row) => {
    if (filters.ticker && !String(row.ticker || '').toUpperCase().includes(filters.ticker)) return false;
    if (filters.side === 'buy') return false;
    if (!roundTripMatchesPnl(row)) return false;
    return true;
  }), filters.sort);
  const allRoundTripsVisible = !filters.ticker && filters.side !== 'buy' && filters.pnl === 'all';
  const realizedGrossPnlRub = allRoundTripsVisible && Number.isFinite(Number(tradePnlSummary.realizedGrossPnlRub ?? tradePnlSummary.realizedPnlRub))
    ? Number(tradePnlSummary.realizedGrossPnlRub ?? tradePnlSummary.realizedPnlRub)
    : filteredRoundTrips.reduce((sum, row) => Number.isFinite(Number(row.grossPnlRub ?? row.pnlRub)) ? sum + Number(row.grossPnlRub ?? row.pnlRub) : sum, 0);
  const realizedNetPnlRub = allRoundTripsVisible && Number.isFinite(Number(tradePnlSummary.realizedNetPnlRub ?? tradePnlSummary.realizedPnlRub))
    ? Number(tradePnlSummary.realizedNetPnlRub ?? tradePnlSummary.realizedPnlRub)
    : filteredRoundTrips.reduce((sum, row) => Number.isFinite(Number(row.netPnlRub ?? row.pnlRub)) ? sum + Number(row.netPnlRub ?? row.pnlRub) : sum, 0);
  const commissionRub = allRoundTripsVisible && Number.isFinite(Number(tradePnlSummary.commissionRub))
    ? Number(tradePnlSummary.commissionRub)
    : filteredRoundTrips.reduce((sum, row) => Number.isFinite(Number(row.commissionRub)) ? sum + Number(row.commissionRub) : sum, 0);
  const filteredRows = sortTrades(rows.filter((row) => {
    const pnl = Number(row.roundTripPnlRub);
    if (filters.side !== 'all' && row.side !== filters.side) return false;
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.ledger !== 'all' && row.ledgerStatus !== filters.ledger) return false;
    if (filters.ticker && !String(row.ticker || '').toUpperCase().includes(filters.ticker)) return false;
    if (filters.pnl === 'profit' && !(Number.isFinite(pnl) && pnl > 0)) return false;
    if (filters.pnl === 'loss' && !(Number.isFinite(pnl) && pnl < 0)) return false;
    if (filters.pnl === 'empty' && Number.isFinite(pnl)) return false;
    return true;
  }), filters.sort);
  const filteredRobotEvents = robotEvents.filter((row) => {
    if (filters.side !== 'all' && row.direction !== filters.side) return false;
    if (filters.ticker && !String(row.ticker || '').toUpperCase().includes(filters.ticker)) return false;
    return true;
  });

  return (
    <div className="grid">
      <Card title="Поток сделок" icon={ArrowLeftRight} className="wide" help="Отдельная страница фактических сделок: broker records, связь с ledger робота и заявки/order safety. Это не buy/sell-сигналы, а то, что реально произошло.">
        <StageStrip
          items={[
            { label: 'Всего записей', value: rows.length, detail: 'broker trade records' },
            { label: 'Buy / Sell', value: `${buyCount} / ${sellCount}`, tone: sellCount ? 'warn' : 'good', detail: 'стороны сделок' },
            { label: 'Ledger', value: `${ledgerCount} / ${rows.length}`, tone: brokerOnly ? 'warn' : 'good', detail: brokerOnly ? `${brokerOnly} только broker` : 'нет broker-only' },
            { label: 'Фильтр', value: filteredRows.length, detail: 'строк сейчас видно' },
            { label: 'Round-trip P/L', value: `${money(realizedNetPnlRub)} RUB`, tone: realizedNetPnlRub >= 0 ? 'good' : 'bad', detail: `gross ${money(realizedGrossPnlRub)}, fees ${money(commissionRub)}` },
            { label: 'Matching', value: percent(tradePnlSummary.matchingQuality), tone: tradePnlSummary.unmatchedSells ? 'warn' : 'good', detail: `${tradePnlSummary.unmatchedSells || 0} sell без пары` },
            { label: 'Accounting audit', value: accountingIssues, tone: accountingIssues ? 'bad' : 'good', detail: accountingIssues ? 'расхождения ledger/broker' : 'ledger и брокер сходятся' },
            { label: 'Open robot lots', value: money(tradePnlSummary.openLots || 0), detail: `${tradePnlSummary.openPositions || 0} позиций` }
          ]}
        />
      </Card>

      <TradeReview rows={filteredRows} loading={loadingKeys.trades || loadingKeys.robotPositions || loadingKeys.decisions} className="wide">
        <TradeFilters rows={rows} filters={filters} onChange={setFilters} />
      </TradeReview>

      <ExecutionOverview data={data} loading={loadingKeys.orderSafety} className="wide" onOrderTypeChange={onOrderTypeChange} />

      <Card title="Round-trip P/L" icon={LineChart} className="wide" help="Закрытые пары buy -> sell по FIFO. Net P/L вычитает комиссии брокера, биржи и клиринга, если они найдены в broker report по orderId.">
        <Table
          className="round-trip-table"
          columns={[
            { key: 'entryAt', label: 'Вход', width: '150px', render: (row) => time(row.entryAt) },
            { key: 'exitAt', label: 'Выход', width: '150px', render: (row) => time(row.exitAt) },
            { key: 'ticker', label: 'Тикер', width: '125px', render: (row) => <><strong>{row.ticker || '-'}</strong><div className="muted">{row.name}</div></> },
            { key: 'entrySignalSource', label: 'Сигнал входа', width: '125px', render: (row) => <TextCell>{row.entrySignalSource || EMPTY}</TextCell> },
            { key: 'exitSignalSource', label: 'Сигнал выхода', width: '125px', render: (row) => <TextCell>{row.exitSignalSource || EMPTY}</TextCell> },
            { key: 'status', label: 'Статус', width: '95px', render: (row) => <Pill tone={row.status === 'closed' ? 'good' : 'warn'}>{roundTripStatusLabel(row.status)}</Pill> },
            { key: 'lots', label: 'Лоты', width: '70px', className: 'right', render: (row) => money(row.lots) },
            { key: 'entryPrice', label: 'Вход', width: '90px', className: 'right', render: (row) => money(row.entryPrice) },
            { key: 'exitPrice', label: 'Выход', width: '90px', className: 'right', render: (row) => money(row.exitPrice) },
            { key: 'grossPnlRub', label: 'Gross', width: '95px', className: 'right', render: (row) => <span className={Number(row.grossPnlRub ?? row.pnlRub) >= 0 ? 'good' : 'bad'}>{money(row.grossPnlRub ?? row.pnlRub)}</span> },
            { key: 'commissionRub', label: 'Fees', width: '80px', className: 'right', render: (row) => money(row.commissionRub) },
            { key: 'netPnlRub', label: 'Net', width: '95px', className: 'right', render: (row) => <span className={Number(row.netPnlRub ?? row.pnlRub) >= 0 ? 'good' : 'bad'}>{money(row.netPnlRub ?? row.pnlRub)}</span> },
            { key: 'netPnlPercent', label: 'Net %', width: '90px', className: 'right', render: (row) => percent(row.netPnlPercent ?? row.pnlPercent) },
            { key: 'entryDecisionReason', label: 'Причина входа', width: '190px', render: (row) => <CompactReason>{row.entryDecisionReason || EMPTY}</CompactReason> },
            { key: 'exitDecisionReason', label: 'Причина выхода', width: '190px', render: (row) => <CompactReason>{row.exitDecisionReason || row.reason}</CompactReason> }
          ]}
          rows={filteredRoundTrips}
          empty="Закрытых пар под фильтр нет"
          loading={loadingKeys.tradePnl}
        />
      </Card>

      <PnlBreakdown
        title="P/L по датам"
        rows={tradePnlBreakdowns.byDate}
        loading={loadingKeys.tradePnl}
        help="Закрытые пары сгруппированы по дате выхода. Так видно, какие торговые дни реально дали плюс или минус."
      />

      <PnlBreakdown
        title="P/L по входному сигналу"
        rows={tradePnlBreakdowns.byEntrySignal}
        loading={loadingKeys.tradePnl}
        help="Группировка по ближайшему решению робота перед buy-сделкой. Это первый шаг к ответу, какая стратегия входа зарабатывает."
      />

      <PnlBreakdown
        title="P/L по выходному сигналу"
        rows={tradePnlBreakdowns.byExitSignal}
        loading={loadingKeys.tradePnl}
        help="Группировка по ближайшему решению робота перед sell-сделкой. Тут видно, какие причины выхода режут убыток или забирают прибыль."
      />

      <PnlBreakdown
        title="P/L по тикерам"
        rows={tradePnlBreakdowns.byTicker}
        loading={loadingKeys.tradePnl}
        help="Сводка по инструментам: какие бумаги робот закрыл в плюс или минус."
      />

      <PnlBreakdown
        title="P/L по диагнозу"
        rows={tradePnlBreakdowns.byDiagnosis}
        loading={loadingKeys.tradePnl}
        help="Фактические метки по закрытым парам: gross-profit/loss, missing-entry/exit-signal, exit:* и execution:gross-only. Одна сделка может попадать в несколько меток."
      />

      <PnlDiagnostics rows={tradePnlDiagnostics} loading={loadingKeys.tradePnl} />

      <UnmatchedSells rows={unmatchedSells} loading={loadingKeys.tradePnl} />

      <OpenLots rows={openLots} loading={loadingKeys.tradePnl} />

      <AccountingAudit audit={data.accountingAudit} loading={loadingKeys.accountingAudit} />

      <Card title="Ledger робота" icon={Bot} className="wide" help="Внутренние события robot-owned ledger: из них робот понимает, какие лоты купил сам и какие может продавать.">
        <Table
          columns={[
            { key: 'at', label: 'Время', width: '150px', render: (row) => time(row.at) },
            { key: 'ticker', label: 'Тикер', width: '110px', render: (row) => <><strong>{row.ticker || '-'}</strong><div className="muted">{row.name}</div></> },
            { key: 'direction', label: 'Сторона', width: '90px', render: (row) => <Pill tone={row.direction === 'buy' ? 'good' : 'bad'}>{row.direction}</Pill> },
            { key: 'lots', label: 'Лоты', width: '70px', className: 'right', render: (row) => money(row.lots) },
            { key: 'price', label: 'Цена', width: '90px', className: 'right', render: (row) => money(row.price) },
            { key: 'amount', label: 'Сумма', width: '100px', className: 'right', render: (row) => money(row.amount) },
            { key: 'status', label: 'Статус', render: (row) => <Reason>{row.status || '-'}</Reason> }
          ]}
          rows={filteredRobotEvents}
          empty="Событий ledger под фильтр нет"
          loading={loadingKeys.robotPositions}
        />
      </Card>

      <OrderSafety data={data} loading={loadingKeys.orderSafety} onCancelStaleLimits={onCancelStaleLimits} />
    </div>
  );
}

function Logs({ data, loadingKeys, onCancelStaleLimits }) {
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
      <OrderSafety data={data} loading={loadingKeys.orderSafety} onCancelStaleLimits={onCancelStaleLimits} />
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
  const updateOrderType = async (settings) => {
    setActionError('');
    let confirmation;

    if (settings.sellOrderType === 'limit') {
      confirmation = window.prompt('Limit sell может не исполнить stop-loss. Чтобы включить, введи LIMIT_SELL');
      if (confirmation !== 'LIMIT_SELL') {
        setActionError('Limit sell was not armed');
        return;
      }
    }

    const response = await fetch('/api/admin/order-type', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'order-type'
      },
      body: JSON.stringify({
        ...settings,
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
  const updateSellSettings = async (settings) => {
    setActionError('');
    const response = await fetch('/api/admin/sell-settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'sell-settings'
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
  const cancelStaleLimitOrders = async () => {
    setActionError('');
    const confirmation = window.prompt('Чтобы отменить stale limit-заявки у брокера, введи CANCEL');
    if (confirmation !== 'CANCEL') {
      setActionError('Stale limit cancel was not confirmed');
      return;
    }

    const response = await fetch('/api/admin/cancel-stale-limit-orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robot-admin-action': 'cancel-stale-limit-orders'
      },
      body: JSON.stringify({
        dryRun: false,
        confirm: 'CANCEL_STALE_LIMITS'
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      setActionError(payload.error || `HTTP ${response.status}`);
      return;
    }

    window.alert(`Stale limit cancel: ${payload.cancelled || 0} cancelled, ${payload.failed || 0} failed`);
    await reload();
  };

  const content = {
    overview: <Overview data={data} loadingKeys={loadingKeys} onMarketRegimeChange={updateMarketRegime} />,
    buy: <Buy data={data} loadingKeys={loadingKeys} />,
    social: <Social data={data} loadingKeys={loadingKeys} />,
    socialProfiles: <SocialProfiles data={data} loadingKeys={loadingKeys} reload={reload} />,
    evidence: <Evidence data={data} loadingKeys={loadingKeys} />,
    accounts: <Accounts data={data} loadingKeys={loadingKeys} onModeChange={updateAccountMode} onLiveSellToggle={updateLiveSell} onRiskSettingsChange={updateRiskSettings} onSellSettingsChange={updateSellSettings} />,
    sell: <Sell data={data} loadingKeys={loadingKeys} />,
    trades: <Trades data={data} loadingKeys={loadingKeys} onCancelStaleLimits={cancelStaleLimitOrders} onOrderTypeChange={updateOrderType} />,
    logs: <Logs data={data} loadingKeys={loadingKeys} onCancelStaleLimits={cancelStaleLimitOrders} />
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
            <p>{loading ? `Загрузка API: ${Object.values(loadingKeys).filter(Boolean).length}` : error ? `Ошибка API: ${splitErrors(error).length}` : `Обновлено ${updatedAt ? updatedAt.toLocaleTimeString('ru-RU') : EMPTY}`}</p>
          </div>
          <button className="icon-button" onClick={() => void reload()} title="Обновить">
            <RefreshCw size={18} />
            Обновить
          </button>
        </header>
        {error ? <div className="error-banner" title={error}><AlertTriangle size={18} />{compactError(error)}</div> : null}
        {actionError ? <div className="error-banner"><AlertTriangle size={18} />{actionError}</div> : null}
        <OperatorBar data={data} loading={loading} error={error} />
        {content}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
