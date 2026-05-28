import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradesModel } from '../models/trades.model';
import { RobotConfig } from '../config/robot.config';
import AccountingAuditService from './accounting-audit.service';
import BrokerMissingSellImportService from './broker-missing-sell-import.service';
import OperationsService from './operations.service';

const originalAudit = AccountingAuditService.getLedgerBrokerAudit;
const originalBrokerReport = OperationsService.getBrokerReportRows;
const originalFindAll = TradesModel.findAll;
const originalCreate = TradesModel.create;

const config = { accountIds: ['acc-1'], accountAliases: { 'acc-1': 'trade' } } as unknown as RobotConfig;

const brokerReportRow = {
    orderId: 'sell-order-1',
    tradeDatetime: new Date('2026-05-26T12:31:04.000Z'),
    direction: 'sell',
    figi: 'figi-1',
    ticker: 'VKCO',
    name: 'VK',
    totalOrderAmount: { currency: 'rub', units: 237, nano: 150000000 },
    price: { currency: 'rub', units: 237, nano: 150000000 },
    quantity: 1
};

afterEach(() => {
    (AccountingAuditService.getLedgerBrokerAudit as unknown) = originalAudit;
    (OperationsService.getBrokerReportRows as unknown) = originalBrokerReport;
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
    it('finds missing broker sell operations without writing in dry-run mode', async () => {
        mockMismatch();
        let createCalls = 0;
        (OperationsService.getBrokerReportRows as unknown) = async () => [brokerReportRow];
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
        (OperationsService.getBrokerReportRows as unknown) = async () => [brokerReportRow];
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
        (OperationsService.getBrokerReportRows as unknown) = async () => [brokerReportRow];
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
});
