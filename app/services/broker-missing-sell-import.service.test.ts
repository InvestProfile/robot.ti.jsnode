import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradesModel } from '../models/trades.model';
import { RobotConfig } from '../config/robot.config';
import AccountingAuditService from './accounting-audit.service';
import BrokerMissingSellImportService from './broker-missing-sell-import.service';
import InstrumentsService from './instruments.service';
import OperationsService from './operations.service';
import { OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';

const originalAudit = AccountingAuditService.getLedgerBrokerAudit;
const originalShares = InstrumentsService.getShares;
const originalOperations = OperationsService.getOperationsByCursorItems;
const originalFindAll = TradesModel.findAll;
const originalCreate = TradesModel.create;

const config = { accountIds: ['acc-1'], accountAliases: { 'acc-1': 'trade' } } as unknown as RobotConfig;

const operation = {
    id: 'sell-order-1',
    date: new Date('2026-05-26T12:31:04.000Z'),
    type: OperationType.OPERATION_TYPE_SELL,
    state: OperationState.OPERATION_STATE_EXECUTED,
    instrumentUid: 'uid-1',
    figi: 'figi-1',
    ticker: 'VKCO',
    name: 'VK',
    payment: { currency: 'rub', units: 237, nano: 150000000 },
    price: { currency: 'rub', units: 237, nano: 150000000 },
    quantity: 1,
    quantityDone: 1
};

afterEach(() => {
    (AccountingAuditService.getLedgerBrokerAudit as unknown) = originalAudit;
    (InstrumentsService.getShares as unknown) = originalShares;
    (OperationsService.getOperationsByCursorItems as unknown) = originalOperations;
    (TradesModel.findAll as unknown) = originalFindAll;
    (TradesModel.create as unknown) = originalCreate;
});

const mockMismatch = () => {
    (AccountingAuditService.getLedgerBrokerAudit as unknown) = async () => ({
        issues: [{
            type: 'ledger-overstates-broker',
            accountId: 'acc-1',
            accountAlias: 'trade',
            ticker: 'VKCO',
            name: 'VK',
            figi: 'figi-1',
            instrumentUid: 'uid-1',
            ledgerLots: 3,
            brokerLots: 2
        }]
    });
};

describe('BrokerMissingSellImportService', () => {
    beforeEach(() => {
        (InstrumentsService.getShares as unknown) = async () => ({
            instruments: [{ uid: 'uid-1', figi: 'figi-1', ticker: 'VKCO', lot: 1 }]
        });
    });

    it('finds missing broker sell operations without writing in dry-run mode', async () => {
        mockMismatch();
        let createCalls = 0;
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [operation];
        (TradesModel.findAll as unknown) = async () => [];
        (TradesModel.create as unknown) = async () => {
            createCalls += 1;
        };

        const result = await BrokerMissingSellImportService.importMissingSells(config);

        assert.strictEqual(result.dryRun, true);
        assert.strictEqual(result.checkedIssues, 1);
        assert.strictEqual(result.candidates.length, 1);
        assert.strictEqual(result.imported.length, 0);
        assert.strictEqual(createCalls, 0);
        assert.strictEqual(result.candidates[0].ticker, 'VKCO');
        assert.strictEqual(result.candidates[0].lots, 1);
    });

    it('imports missing broker sell fills only when apply is enabled', async () => {
        mockMismatch();
        const created: Record<string, unknown>[] = [];
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [operation];
        (TradesModel.findAll as unknown) = async () => [];
        (TradesModel.create as unknown) = async (data: Record<string, unknown>) => {
            created.push(data);
            return data;
        };

        const result = await BrokerMissingSellImportService.importMissingSells(config, { apply: true });

        assert.strictEqual(result.dryRun, false);
        assert.strictEqual(result.imported.length, 1);
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].direction, '2');
        assert.strictEqual(created[0].status, 'EXECUTION_REPORT_STATUS_FILL');
        assert.strictEqual(created[0].orderId, 'sell-order-1');
        assert.strictEqual(created[0].orderType, 'broker-import');
    });

    it('does not import broker operations that are already present locally', async () => {
        mockMismatch();
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [operation];
        (TradesModel.findAll as unknown) = async () => [{
            getDataValue: () => 'sell-order-1'
        }];
        (TradesModel.create as unknown) = async () => {
            throw new Error('should not write duplicate broker operation');
        };

        const result = await BrokerMissingSellImportService.importMissingSells(config, { apply: true });

        assert.strictEqual(result.candidates.length, 0);
        assert.strictEqual(result.imported.length, 0);
    });

    it('finds recent broker sells even before ledger audit exposes a mismatch', async () => {
        (AccountingAuditService.getLedgerBrokerAudit as unknown) = async () => ({ issues: [] });
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [operation];
        (TradesModel.findAll as unknown) = async () => [];

        const result = await BrokerMissingSellImportService.importMissingSells(config);

        assert.strictEqual(result.checkedIssues, 0);
        assert.strictEqual(result.candidates.length, 1);
        assert.strictEqual(result.candidates[0].orderId, 'sell-order-1');
        assert.match(result.candidates[0].reason, /recent broker sell/);
    });

    it('does not duplicate recent broker sells that are already present locally', async () => {
        (AccountingAuditService.getLedgerBrokerAudit as unknown) = async () => ({ issues: [] });
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [operation];
        (TradesModel.findAll as unknown) = async () => [{
            getDataValue: () => 'sell-order-1'
        }];
        (TradesModel.create as unknown) = async () => {
            throw new Error('should not write duplicate recent broker operation');
        };

        const result = await BrokerMissingSellImportService.importMissingSells(config, { apply: true });

        assert.strictEqual(result.candidates.length, 0);
        assert.strictEqual(result.imported.length, 0);
    });

    it('finds missing broker sells for ledger ghost positions', async () => {
        (AccountingAuditService.getLedgerBrokerAudit as unknown) = async () => ({
            issues: [{
                type: 'ledger-ghost',
                accountId: 'acc-1',
                accountAlias: 'trade',
                ticker: 'VKCO',
                name: 'VK',
                figi: 'figi-1',
                instrumentUid: 'uid-1',
                ledgerLots: 1,
                brokerLots: 0,
                lastTradeAt: '2026-05-25T12:00:00.000Z'
            }]
        });
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [operation];
        (TradesModel.findAll as unknown) = async () => [];

        const result = await BrokerMissingSellImportService.importMissingSells(config);

        assert.strictEqual(result.checkedIssues, 1);
        assert.strictEqual(result.candidates.length, 1);
        assert.match(result.candidates[0].reason, /ledger-ghost/);
    });

    it('scans the full lookback for audit issues even when the last local trade is newer', async () => {
        (AccountingAuditService.getLedgerBrokerAudit as unknown) = async () => ({
            issues: [{
                type: 'ledger-ghost',
                accountId: 'acc-1',
                accountAlias: 'trade',
                ticker: 'VKCO',
                name: 'VK',
                figi: 'figi-1',
                instrumentUid: 'uid-1',
                ledgerLots: 1,
                brokerLots: 0,
                lastTradeAt: '2026-06-10T12:00:00.000Z'
            }]
        });
        const requestedWindows: Array<{ from: Date; to: Date }> = [];
        (OperationsService.getOperationsByCursorItems as unknown) = async (_accountId: string, from: Date, to: Date) => {
            requestedWindows.push({ from, to });
            return from <= operation.date && operation.date < to ? [operation] : [];
        };
        (TradesModel.findAll as unknown) = async () => [];

        const result = await BrokerMissingSellImportService.importMissingSells(config, {
            from: new Date('2026-05-20T00:00:00.000Z'),
            to: new Date('2026-06-11T00:00:00.000Z')
        });

        assert.strictEqual(result.checkedIssues, 1);
        assert.strictEqual(result.candidates.length, 1);
        assert.strictEqual(result.candidates[0].orderId, 'sell-order-1');
        assert.ok(requestedWindows.some(window => window.from <= operation.date && operation.date < window.to));
    });

    it('converts broker operation quantity to lots using instrument lot size', async () => {
        (InstrumentsService.getShares as unknown) = async () => ({
            instruments: [{ uid: 'uid-1', figi: 'figi-1', ticker: 'VKCO', lot: 10 }]
        });
        mockMismatch();
        (OperationsService.getOperationsByCursorItems as unknown) = async () => [{
            ...operation,
            quantity: 10,
            quantityDone: 10,
            payment: { currency: 'rub', units: 481, nano: 700000000 },
            price: { currency: 'rub', units: 48, nano: 170000000 }
        }];
        (TradesModel.findAll as unknown) = async () => [];

        const created: Record<string, unknown>[] = [];
        (TradesModel.create as unknown) = async (data: Record<string, unknown>) => {
            created.push(data);
            return data;
        };

        const result = await BrokerMissingSellImportService.importMissingSells(config, { apply: true });

        assert.strictEqual(result.imported.length, 1);
        assert.strictEqual(result.imported[0].lots, 1);
        assert.strictEqual(result.imported[0].lotSize, 10);
        assert.strictEqual(created[0].lotsExecuted, 1);
        assert.strictEqual(created[0].lot, '10');
    });
});
