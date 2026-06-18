import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradesModel } from '../models/trades.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import InstrumentsService from './instruments.service';
import OperationsService from './operations.service';
import TradesService from './trades.service';
import TradePnlService from './trade-pnl.service';
import ExitQualityService from './exit-quality.service';
import RobotPositionLedgerService from './robot-position-ledger.service';
import AccountingAuditService from './accounting-audit.service';
import { RobotConfig } from '../config/robot.config';
import { OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';

type PlainTrade = Record<string, unknown>;

const originalTradesFindAll = TradesModel.findAll;
const originalDecisionFindAll = TradeDecisionModel.findAll;
const originalGetShares = InstrumentsService.getShares;
const originalGetPortfolio = OperationsService.getPortfolio;
const originalGetBrokerReportRows = OperationsService.getBrokerReportRows;
const originalGetOperationsByCursorItems = OperationsService.getOperationsByCursorItems;
const originalSnapshotsFindAll = PortfolioSnapshotModel.findAll;
const originalGetRoundTripPnl = TradePnlService.getRoundTripPnl;
const originalGetLedger = RobotPositionLedgerService.getLedger;
const originalGetLedgerBrokerAudit = AccountingAuditService.getLedgerBrokerAudit;

const config = {
    accountIds: ['acc-1'],
    accountAliases: { 'acc-1': 'Trade' },
    stopLossPercent: 3
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
    (PortfolioSnapshotModel.findAll as unknown) = originalSnapshotsFindAll;
    (TradePnlService.getRoundTripPnl as unknown) = originalGetRoundTripPnl;
    (RobotPositionLedgerService.getLedger as unknown) = originalGetLedger;
    (AccountingAuditService.getLedgerBrokerAudit as unknown) = originalGetLedgerBrokerAudit;
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

    it('matches FIFO by actual trade time, not local import time', async () => {
        setTrades([
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'TIME',
                figi: 'figi-time',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderType: 'broker-import',
                lotsExecuted: 1,
                executedPriceUnits: 90,
                totalAmountUnits: 90,
                tradeDateTime: '2026-06-01T10:00:00.000Z',
                createdAt: '2026-06-17T10:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'TIME',
                figi: 'figi-time',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-06-09T10:00:00.000Z',
                createdAt: '2026-06-09T10:00:05.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];

        const pnl = await TradePnlService.getRoundTripPnl(config, 50, { includeCommissions: false });

        assert.strictEqual(pnl.summary.closed, 0);
        assert.strictEqual(pnl.summary.unmatchedSells, 1);
        assert.strictEqual(pnl.summary.openLots, 1);
        assert.strictEqual(pnl.openLots[0].ticker, 'TIME');
        assert.strictEqual(pnl.unmatchedSells[0].ticker, 'TIME');
    });

    it('splits broker report commission windows to stay under broker range limits', async () => {
        setTrades([
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'SLOW',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'sell-order',
                lotsExecuted: 1,
                executedPriceUnits: 120,
                totalAmountUnits: 120,
                tradeDateTime: '2026-06-01T10:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'SLOW',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'buy-order',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-04-25T09:00:00.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];
        const calls: { from: Date; to: Date }[] = [];
        (OperationsService.getBrokerReportRows as unknown) = async (_accountId: string, from: Date, to: Date) => {
            calls.push({ from, to });
            return [
                {
                    orderId: calls.length === 1 ? 'buy-order' : 'sell-order',
                    brokerCommission: { units: -1, nano: 0 },
                    exchangeCommission: { units: 0, nano: 0 },
                    exchangeClearingCommission: { units: 0, nano: 0 }
                }
            ];
        };

        const pnl = await TradePnlService.getRoundTripPnl(config, 50);

        assert.ok(calls.length >= 2);
        assert.ok(calls.every(call => call.to.getTime() - call.from.getTime() <= 30 * 24 * 60 * 60 * 1000));
        assert.strictEqual(pnl.summary.realizedGrossPnlRub, 20);
        assert.strictEqual(pnl.summary.commissionRub, 2);
        assert.strictEqual(pnl.summary.realizedNetPnlRub, 18);
    });

    it('labels broker-side protective stop fills when no sell decision is available', async () => {
        setTrades([
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'STOP',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 96,
                totalAmountUnits: 96,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'STOP',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];

        const pnl = await TradePnlService.getRoundTripPnl(config, 50, { includeCommissions: false });

        assert.strictEqual(pnl.closedRoundTrips[0].exitSignalSource, 'broker-stop-loss');
        assert.match(String(pnl.closedRoundTrips[0].exitDecisionReason), /inferred broker protective stop/);
    });

    it('summarizes stop damage using net P/L and commissions', async () => {
        setTrades([
            {
                id: 4,
                accountId: 'acc-1',
                ticker: 'STOP',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'sell-stop',
                lotsExecuted: 1,
                executedPriceUnits: 96,
                totalAmountUnits: 96,
                tradeDateTime: '2026-05-20T10:00:00.000Z'
            },
            {
                id: 3,
                accountId: 'acc-1',
                ticker: 'STOP',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'buy-stop',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-05-20T09:00:00.000Z'
            },
            {
                id: 2,
                accountId: 'acc-1',
                ticker: 'WIN',
                direction: '2',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'sell-win',
                lotsExecuted: 1,
                executedPriceUnits: 120,
                totalAmountUnits: 120,
                tradeDateTime: '2026-05-20T08:00:00.000Z'
            },
            {
                id: 1,
                accountId: 'acc-1',
                ticker: 'WIN',
                direction: '1',
                status: 'EXECUTION_REPORT_STATUS_FILL',
                orderId: 'buy-win',
                lotsExecuted: 1,
                executedPriceUnits: 100,
                totalAmountUnits: 100,
                tradeDateTime: '2026-05-20T07:00:00.000Z'
            }
        ]);
        (TradeDecisionModel.findAll as unknown) = async () => [];
        (OperationsService.getBrokerReportRows as unknown) = async () => [
            { orderId: 'buy-stop', brokerCommission: { units: -1, nano: 0 } },
            { orderId: 'sell-stop', brokerCommission: { units: -2, nano: 0 } }
        ];

        const report = await ExitQualityService.getExitQuality(config, 50);

        assert.strictEqual(report.summary.closedRoundTrips, 2);
        assert.strictEqual(report.summary.stopExits, 1);
        assert.strictEqual(report.summary.brokerStopLossExits, 1);
        assert.strictEqual(report.summary.stopDamageNetRub, -7);
        assert.strictEqual(report.summary.stopCommissionRub, 3);
        assert.strictEqual(report.summary.worstTicker, 'STOP');
        assert.match(report.summary.topCause, /stop-loss \/ broker-stop-loss/);
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

    it('reconciles realized net P/L separately from broker cashflows and open robot P/L', async () => {
        (TradePnlService.getRoundTripPnl as unknown) = async () => ({
            summary: {
                scannedTrades: 4,
                closed: 1,
                unmatchedSells: 0,
                openLots: 1,
                openPositions: 1,
                matchingQuality: 100,
                realizedGrossPnlRub: 20,
                commissionRub: 3,
                realizedNetPnlRub: 17,
                accounting: 'net'
            },
            closedRoundTrips: [{ ticker: 'GOOD', netPnlRub: 17 }],
            unmatchedSells: []
        });
        (RobotPositionLedgerService.getLedger as unknown) = async () => ({
            summary: {
                unrealizedPnl: 8,
                marketValue: 108,
                positions: 1
            }
        });
        (AccountingAuditService.getLedgerBrokerAudit as unknown) = async () => ({
            summary: {
                issues: 0,
                ghosts: 0,
                quantityMismatches: 0
            },
            issues: []
        });
        (PortfolioSnapshotModel.findAll as unknown) = async () => [
            asModel({
                accountId: 'acc-1',
                totalRub: 1150,
                cashRub: 150,
                createdAt: '2026-05-20T10:00:00.000Z'
            }),
            asModel({
                accountId: 'acc-1',
                totalRub: 1000,
                cashRub: 100,
                createdAt: '2026-05-20T09:00:00.000Z'
            })
        ];
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [
            {
                type: OperationType.OPERATION_TYPE_INPUT,
                state: OperationState.OPERATION_STATE_EXECUTED,
                payment: { units: 100, nano: 0 }
            },
            {
                type: OperationType.OPERATION_TYPE_OUTPUT,
                state: OperationState.OPERATION_STATE_EXECUTED,
                payment: { units: -25, nano: 0 }
            }
        ];

        const report = await TradePnlService.getPnlReconciliation(config, { limit: 50 });

        assert.strictEqual(report.headline.realizedNetPnlRub, 17);
        assert.strictEqual(report.headline.realizedGrossPnlRub, 20);
        assert.strictEqual(report.headline.commissionRub, 3);
        assert.strictEqual(report.headline.unrealizedPnlRub, 8);
        assert.strictEqual(report.headline.robotOwnedDeltaRub, 25);
        assert.strictEqual(report.brokerAccount.totalDeltaRub, 150);
        assert.strictEqual(report.cashflows.cashInRub, 100);
        assert.strictEqual(report.cashflows.cashOutRub, 25);
        assert.strictEqual(report.cashflows.netCashflowRub, 75);
        assert.strictEqual(report.brokerAccount.totalDeltaMinusCashflowRub, 75);
        assert.strictEqual(report.quality.accountingIssues, 0);
    });
});
