import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import InstrumentsService from '../services/instruments.service';
import marketData from '../services/marketData.service';
import operationService from '../services/operations.service';
import { quotationToNumber } from '../utils/money';

const ok = (label: string, details = '') => console.log(`OK    ${label}${details ? ': ' + details : ''}`);
const warn = (label: string, details = '') => console.log(`WARN  ${label}${details ? ': ' + details : ''}`);
const fail = (label: string, details = '') => console.log(`FAIL  ${label}${details ? ': ' + details : ''}`);

const money = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return `${value.toFixed(2)} RUB`;
};

const main = async () => {
    const config = getRobotConfig();
    const failures: string[] = [];
    const warnings: string[] = [];

    console.log('Preflight');
    console.log('=========');

    try {
        await sequelize.authenticate();
        ok('DB connection');
    } catch (error) {
        failures.push('DB connection failed');
        fail('DB connection', error instanceof Error ? error.message : String(error));
    }

    const protectedAccountIds = new Set(config.protectedAccountIds);
    const protectedTradeAccounts = config.accountIds.filter(accountId => protectedAccountIds.has(accountId));
    if (protectedTradeAccounts.length > 0) {
        failures.push('Protected accounts are configured for trading');
        fail('Protected account overlap', protectedTradeAccounts.join(', '));
    } else {
        ok('Protected account overlap');
    }

    console.log('');
    console.log('Runtime');
    console.log('-------');
    console.log(`Dry run: ${config.dryRun}`);
    console.log(`Live enabled: ${!config.dryRun}`);
    console.log(`Live allowed actions: ${config.liveAllowedActions.join(', ')}`);
    console.log(`Strategies: ${config.enabledStrategies.join(', ')}`);
    console.log(`Trading accounts: ${config.accountIds.join(', ')}`);
    console.log(`Observe accounts: ${config.observeAccountIds.join(', ') || '<none>'}`);
    console.log(`Max order: ${money(config.maxOrderRub)}`);
    console.log(`Max daily orders: ${config.maxDailyOrders}`);

    if (config.dryRun) {
        warnings.push('Dry-run is enabled');
        warn('Live trading disabled', 'ROBOT_DRY_RUN=true');
    } else {
        ok('Live trading enabled');
    }

    const shares = await InstrumentsService.getShares();
    const instruments = shares?.instruments ?? [];
    const tradingAccountCash = new Map<string, number>();

    console.log('');
    console.log('Trading Accounts');
    console.log('----------------');

    for (const accountId of config.accountIds) {
        const alias = config.accountAliases[accountId] ?? accountId;
        const portfolio = await operationService.getPortfolio(accountId);
        const cashRub = quotationToNumber(portfolio?.totalAmountCurrencies) ?? 0;
        const totalRub = quotationToNumber(portfolio?.totalAmountPortfolio) ?? 0;
        const positionsCount = portfolio?.positions?.length ?? 0;
        tradingAccountCash.set(accountId, cashRub);

        console.log(`${alias} (${accountId})`);
        console.log(`  Cash: ${money(cashRub)}`);
        console.log(`  Total: ${money(totalRub)}`);
        console.log(`  Positions: ${positionsCount}`);

        if (cashRub <= 0) {
            warnings.push(`${alias} has no RUB cash`);
            warn('Cash', `${alias} has no RUB cash`);
        }
    }

    console.log('');
    console.log('Buy Watchlist');
    console.log('-------------');

    const buyInstruments = config.buyTickers
        .map(ticker => instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
        .filter(Boolean);
    const missingTickers = config.buyTickers.filter(ticker =>
        !buyInstruments.some(instrument => instrument?.ticker?.toUpperCase() === ticker)
    );

    for (const ticker of missingTickers) {
        warnings.push(`Ticker not found: ${ticker}`);
        warn('Ticker not found', ticker);
    }

    const lastPrices = await marketData.getLastPrices(
        buyInstruments
            .map(instrument => instrument?.uid)
            .filter((uid): uid is string => Boolean(uid))
    );

    for (const instrument of buyInstruments) {
        if (!instrument) continue;

        const lastPrice = lastPrices.get(instrument.uid);
        const estimatedOrderRub = lastPrice !== undefined
            ? lastPrice * Math.max(1, instrument.lot ?? 1)
            : undefined;
        const maxTradingCash = Math.max(...Array.from(tradingAccountCash.values()), 0);
        const blockedReason = lastPrice === undefined
            ? 'last price is empty'
            : estimatedOrderRub !== undefined && estimatedOrderRub > config.maxOrderRub
                ? 'above max order RUB'
                : estimatedOrderRub !== undefined && estimatedOrderRub > maxTradingCash
                    ? 'not enough trading account cash'
                : undefined;

        console.log(
            `${instrument.ticker}: price=${money(lastPrice)} lot=${instrument.lot ?? 1} estimated=${money(estimatedOrderRub)}${blockedReason ? ' blocked=' + blockedReason : ''}`
        );
    }

    console.log('');
    console.log('Result');
    console.log('------');

    if (failures.length > 0) {
        fail('Preflight failed', failures.join('; '));
        process.exitCode = 1;
        return;
    }

    if (warnings.length > 0) {
        warn('Preflight passed with warnings', warnings.join('; '));
        return;
    }

    ok('Preflight passed');
};

void main()
    .catch(error => {
        console.error('Preflight failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
