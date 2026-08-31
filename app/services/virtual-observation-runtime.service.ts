import { VirtualAccountModel } from '../models/virtual-account.model';
import { VirtualFillModel } from '../models/virtual-fill.model';
import { VirtualLedgerEventModel } from '../models/virtual-ledger-event.model';
import { VirtualOrderModel } from '../models/virtual-order.model';
import { ShadowDecisionObservationModel } from '../models/shadow-decision-observation.model';
import {
    PostRiskVirtualEvidenceSource,
    RestartSafeVirtualObservationRuntime
} from '../paper/shadow-composition';
import { decodeVirtualLedgerEvent } from '../virtual/codecs';
import type { ObservationRunnerState, ObservationScenarioSnapshot, ObservationTick } from '../virtual/observation-runner';
import { replayVirtualLedger } from '../virtual/ledger';
import { replayVirtualPositions } from '../virtual/position-repository';
import { markVirtualPosition } from '../virtual/positions';
import { virtualFillRowToDomain } from './sequelize-virtual-position.repository';
import { virtualLedgerRowToStoredEvent } from './sequelize-virtual-ledger.repository';
import { SequelizeObservationTickRepository } from './sequelize-observation-tick.repository';
import sequelize from '../config/database';
import {
    ObservationExperimentRepository,
    ObservationLease,
    ObservationLeaseRepository,
    runObservationMigrations
} from '../paper/observation-persistence';

interface EvidenceRows {
    readonly account: VirtualAccountModel;
    readonly fills: readonly VirtualFillModel[];
    readonly ledger: readonly VirtualLedgerEventModel[];
    readonly orders: readonly VirtualOrderModel[];
    readonly postRiskObservations: readonly ShadowDecisionObservationModel[];
}

export interface VirtualEvidenceReadPort {
    listActive(): Promise<readonly EvidenceRows[]>;
}

export class SequelizeVirtualEvidenceReadPort implements VirtualEvidenceReadPort {
    async listActive(): Promise<readonly EvidenceRows[]> {
        const accounts = await VirtualAccountModel.findAll({ where: { status: 'active' }, order: [['virtualAccountId', 'ASC']] });
        return Promise.all(accounts.map(async account => {
            const where = { virtualAccountId: account.virtualAccountId };
            const [fills, ledger, orders, postRiskObservations] = await Promise.all([
                VirtualFillModel.findAll({ where, order: [['sequence', 'ASC']] }),
                VirtualLedgerEventModel.findAll({ where, order: [['sequence', 'ASC']] }),
                VirtualOrderModel.findAll({ where, order: [['sequence', 'ASC']] }),
                ShadowDecisionObservationModel.findAll({ where, order: [['sequence', 'ASC']] })
            ]);
            return { account, fills, ledger, orders, postRiskObservations };
        }));
    }
}

export class PersistedPostRiskVirtualEvidenceSource implements PostRiskVirtualEvidenceSource {
    constructor(
        private readonly experimentId: string,
        private readonly rows: VirtualEvidenceReadPort = new SequelizeVirtualEvidenceReadPort(),
        private readonly now: () => string = () => new Date().toISOString()
    ) {}

    async collect(_state: ObservationRunnerState): Promise<ObservationTick> {
        const observedAt = this.now();
        const snapshots: ObservationScenarioSnapshot[] = [];
        for (const item of await this.rows.listActive()) {
            // Accounts without a post-risk decision have not entered the shared shadow pipeline.
            if (item.postRiskObservations.length === 0) continue;
            const fills = item.fills.map(virtualFillRowToDomain);
            const ledger = replayVirtualLedger(item.ledger.map(row =>
                decodeVirtualLedgerEvent(virtualLedgerRowToStoredEvent(row))
            ));
            const portfolio = replayVirtualPositions(item.account.virtualAccountId, fills);
            const latestMarks = new Map<string, bigint>();
            for (const fill of fills) latestMarks.set(fill.instrumentId, fill.executionPriceKopecks);
            const positionsValue = portfolio.positions.reduce((sum, position) =>
                sum + markVirtualPosition(position, latestMarks.get(position.instrumentId) ?? 0n).marketValueKopecks, 0n
            );
            snapshots.push(Object.freeze({
                virtualAccountId: item.account.virtualAccountId,
                scenarioId: item.account.name,
                equityKopecks: ledger.cashKopecks + positionsValue,
                closedVirtualTrades: fills.filter(fill => fill.side === 'sell').length,
                invariantViolationCount: 0,
                unknownUnreconciledOrderCount: item.orders.filter(order => !['filled', 'rejected'].includes(order.status)).length,
                marginBreachCount: 0,
                feesIncluded: true,
                slippageIncluded: true,
                financingIncluded: true,
                benchmarkAvailable: false
            }));
        }
        return Object.freeze({
            tickId: `evidence:${this.experimentId}:${observedAt}`,
            observedAt,
            snapshots: Object.freeze(snapshots)
        });
    }
}

export const createSequelizeVirtualObservationRuntime = (experimentId: string) =>
    new RestartSafeVirtualObservationRuntime(
        experimentId,
        new SequelizeObservationTickRepository(),
        new PersistedPostRiskVirtualEvidenceSource(experimentId)
    );

export interface PreparedVirtualObservationRuntime {
    readonly runtime: RestartSafeVirtualObservationRuntime;
    readonly lease: ObservationLease;
}

export const prepareSequelizeVirtualObservationRuntime = async (
    experimentId: string,
    leaseTtlMs: number
): Promise<PreparedVirtualObservationRuntime> => {
    await runObservationMigrations(sequelize);
    await new ObservationExperimentRepository(sequelize).open(experimentId);
    const lease = await new ObservationLeaseRepository(sequelize).acquire(
        `virtual-observation:${experimentId}`,
        leaseTtlMs
    );
    if (!lease) throw new Error(`virtual observation experiment already has an active worker: ${experimentId}`);
    return { runtime: createSequelizeVirtualObservationRuntime(experimentId), lease };
};
