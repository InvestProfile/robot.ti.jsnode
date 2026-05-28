import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradesModel } from '../models/trades.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import InstrumentsService from './instruments.service';
import OperationsService from './operations.service';
import TradesService from './trades.service';
import TradePnlService from './trade-pnl.service';
import RobotPositionLedgerService from './robot-position-ledger.service';
import AccountingAuditService from './accounting-audit.service';
import { RobotConfig } from '../config/robot.config';
import { OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';

type PlainTrade = Record<string, unknown>;

const originalTradesFindAll = TradesModel.findAll;
const originalDecisionFindAll = TradeDecisionModel.findAll;
const originalGetShares = InstrumentsService.getShares;
const originalGetPortfolio = OperationsService.getPortfolio;
const originalGetBrokerReportRows = OperationsService.getBrokerReportRows;
const originalGetOperationsByCursorItems = OperationsService.getOperationsByCursorItems;

const config = {
    accountIds: ['acc-1'],
    accountAliases: { 'acc-1': 'Trade' }
} as unknown as RobotConfig;

const asModel = (row: PlainTrade) => ({
    get: () => row,
    toJSON: () => row
});

const setTrades = (rows: PlainTrade[]) => {
    (TradesModel.findAll as unknown) = async () => rows.map(asModel);
};

beforeEach(() => {
    (OperationsService.getBrokerReportRows as unknown) = async () => [];
    (OperationsService.getOperationsByCursorItems as unknown) = async () => [];
});

afterEach(() => {
    (TradesModel.findAll as unknown) = originalTradesFindAll;
    (TradeDecisionModel.findAll as unknown) = originalDecisionFindAll;
    (InstrumentsService.getShares as unknown) = originalGetShares;
    (OperationsService.getPortfolio as unknown) = originalGetPortfolio;
    (OperationsService.getBrokerReportRows as unknown) = originalGetBrokerReportRows;
    (OperationsService.getOperationsByCursorItems as unknown) = originalGetOperationsByCursorItems;
});

describe('trade accounting lifecycle safety', () => {
    it('excludes local rejected and unknown orders from daily buy rub limits', async () => {
        setTrades([
            {
                accountId: 'acc-1',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                lot: 1
            },
            {
                accountId: 'acc-1',
                direction: '1',
                status: 'LOCAL_POST_REJECTED',
                lotsRequested: 1,
                price_units: 200,
                lot: 1
            },
            {
                accountId: 'acc-1',
                direction: '1',
                status: 'LOCAL_SUBMIT_UNKNOWN',
                lotsRequested: 1,
                price_units: 300,
                lot: 1
            }
        ]);

        assert.strictEqual(await TradesService.sumTodayBuyTradesRub('acc-1'), 100);
    });

    it('does not count local rejected or unknown orders as used daily orders', async () => {
        setTrades([
            { accountId: 'acc-1', status: 'EXECUTION_REPORT_STATUS_FILL' },
            { accountId: 'acc-1', status: 'LOCAL_PENDING_SUBMIT' },
            { accountId: 'acc-1', status: 'LOCAL_POST_REJECTED' },
            { accountId: 'acc-1', status: 'LOCAL_SUBMIT_UNKNOWN' }
        ]);

        assert.strictEqual(await TradesService.countTodayTrades('acc-1'), 2);
    });

    it('keeps rejected and unknown orders out of round-trip P/L', async () => {
        setTrades([
            {
                id: 4,
                accountId: 'acc-1',
                ticker: 'MAYBE',
                direction: '1',
                status: 'LOCAL_SUBMIT_UNKNOWN',
                lotsRequested: 1,
                price_units: 700,
                tradeDateTime: '2026-05-20T12:00:00.000Z'
            },
            {
                id: 3,
                accountId: 'acc-1',
                ticker: 'BAD',
                direction: '1',
                status: 'LOCAL_POST_REJECTED',
                lotsRequested: 1,
                price_units: 500,
                tradeDateTime: '2026-05-20T11:00:00.000Z'
            },
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'GOOD',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 120,
                totalAmountUnits: 120,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'GOOD',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];

        const pnl = await TradePnlService.getRoundTripPnl(config, 50);

        assert.strictEqual(pnl.summary.closed, 1);
        assert.strictEqual(pnl.summary.ignoredTrades, 2);
        assert.strictEqual(pnl.summary.realizedPnlRub, 20);
        assert.deepStrictEqual(pnl.openLots, []);
    });

    it('subtracts broker report commissions from round-trip net P/L', async () => {
        setTrades([
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'GOOD',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'sell-order',
                lotsExecuted: 1,
                executedPriceUnits: 120,
                totalAmountUnits: 120,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'GOOD',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'buy-order',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];
        (OperationsService.getBrokerReportRows as unknown) = async () => [
            {
                orderId: 'buy-order',
                brokerCommission: { units: -1, nano: 0 },
                exchangeCommission: { units: 0, nano: -250000000 },
                exchangeClearingCommission: { units: 0, nano: 0 }
            },
            {
                orderId: 'sell-order',
                brokerCommission: { units: -2, nano: 0 },
                exchangeCommission: { units: 0, nano: 0 },
                exchangeClearingCommission: { units: 0, nano: -500000000 }
            }
        ];

        const pnl = await TradePnlService.getRoundTripPnl(config, 50);

        assert.strictEqual(pnl.summary.realizedGrossPnlRub, 20);
        assert.strictEqual(pnl.summary.commissionRub, 3.75);
        assert.strictEqual(pnl.summary.realizedNetPnlRub, 16.25);
        assert.strictEqual(pnl.summary.accounting, 'net');
        assert.strictEqual(pnl.closedRoundTrips[0].grossPnlRub, 20);
        assert.strictEqual(pnl.closedRoundTrips[0].commissionRub, 3.75);
        assert.strictEqual(pnl.closedRoundTrips[0].netPnlRub, 16.25);
    });

    it('falls back to operations cursor commissions when broker report has no matching order id', async () => {
        setTrades([
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'GOOD',
                figi: 'figi-good',
                instrumentUid: 'uid-good',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'local-sell-order',
                lotsExecuted: 1,
                executedPriceUnits: 120,
                totalAmountUnits: 120,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'GOOD',
                figi: 'figi-good',
                instrumentUid: 'uid-good',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'local-buy-order',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];
        (OperationsService.getBrokerReportRows as unknown) = async () => [];
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [
            {
                id: 'broker-buy-operation',
                date: new Date('2026-05-20T09:00:03.000Z'),
                type: OperationType.OPERATION_TYPE_BUY,
                state: OperationState.OPERATION_STATE_EXECUTED,
                quantity: 1,
                quantityDone: 1,
                payment: { units: -100, nano: 0 },
                commission: { units: -1, nano: 0 },
                childOperations: []
            },
            {
                id: 'broker-sell-operation',
                date: new Date('2026-05-20T10:00:02.000Z'),
                type: OperationType.OPERATION_TYPE_SELL,
                state: OperationState.OPERATION_STATE_EXECUTED,
                quantity: 1,
                quantityDone: 1,
                payment: { units: 120, nano: 0 },
                commission: { units: -2, nano: -500000000 },
                childOperations: []
            }
        ];

        const pnl = await TradePnlService.getRoundTripPnl(config, 50);

        assert.strictEqual(pnl.summary.realizedGrossPnlRub, 20);
        assert.strictEqual(pnl.summary.commissionRub, 3.5);
        assert.strictEqual(pnl.summary.realizedNetPnlRub, 16.5);
        assert.strictEqual(pnl.summary.accounting, 'net');
    });

    it('keeps rejected and unknown orders out of robot ledger positions and events', async () => {
        setTrades([
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'GOOD',
                instrumentUid: 'good-uid',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                lot: 1,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            },
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'BAD',
                instrumentUid: 'bad-uid',
                direction: '1',
                status: 'LOCAL_POST_REJECTED',
                lotsRequested: 1,
                price_units: 200,
                lot: 1,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            },
            {
                id: 3,
                accountId: 'acc-1',
                ticker: 'MAYBE',
                instrumentUid: 'maybe-uid',
                direction: '1',
                status: 'LOCAL_SUBMIT_UNKNOWN',
                lotsRequested: 1,
                price_units: 300,
                lot: 1,
                tradeDateTime: '2026-05-20T11:00:00.000Z'
            }
        ]);
        (InstrumentsService.getShares as unknown) = async () => ({
            instruments: [
                { uid: 'good-uid', ticker: 'GOOD', name: 'Good', lot: 1 },
                { uid: 'bad-uid', ticker: 'BAD', name: 'Bad', lot: 1 },
                { uid: 'maybe-uid', ticker: 'MAYBE', name: 'Maybe', lot: 1 }
            ]
        });
        (OperationsService.getPortfolio as unknown) = async () => ({
            positions: [
                {
                    instrumentUid: 'good-uid',
                    currentPrice: { units: 110, nano: 0 }
                }
            ]
        });

        const ledger = await RobotPositionLedgerService.getLedger(config);

        assert.strictEqual(ledger.summary.events, 1);
        assert.deepStrictEqual(ledger.events.map(event => event.ticker), ['GOOD']);
        assert.deepStrictEqual(ledger.items.map(item => item.ticker), ['GOOD']);
    });

    it('reports robot ledger positions that are absent from broker portfolio', async () => {
        setTrades([
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'GOOD',
                figi: 'good-figi',
                instrumentUid: 'good-uid',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                lot: 1,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            },
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'GHOST',
                figi: 'ghost-figi',
                instrumentUid: 'ghost-uid',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 2,
                executedPriceUnits: 50,
                totalAmountUnits: 100,
                lot: 1,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            }
        ]);
        (InstrumentsService.getShares as unknown) = async () => ({
            instruments: [
                { uid: 'good-uid', figi: 'good-figi', ticker: 'GOOD', name: 'Good', lot: 1 },
                { uid: 'ghost-uid', figi: 'ghost-figi', ticker: 'GHOST', name: 'Ghost', lot: 1 }
            ]
        });
        (OperationsService.getPortfolio as unknown) = async () => ({
            positions: [
                {
                    figi: 'good-figi',
                    instrumentUid: 'good-uid',
                    quantityLots: { units: 1, nano: 0 },
                    currentPrice: { units: 110, nano: 0 }
                }
            ]
        });

        const audit = await AccountingAuditService.getLedgerBrokerAudit(config);

        assert.strictEqual(audit.summary.checkedLedgerPositions, 2);
        assert.strictEqual(audit.summary.ghosts, 1);
        assert.strictEqual(audit.summary.issues, 1);
        assert.strictEqual(audit.issues[0].ticker, 'GHOST');
        assert.strictEqual(audit.issues[0].ledgerLots, 2);
        assert.strictEqual(audit.issues[0].brokerLots, 0);
    });
});
