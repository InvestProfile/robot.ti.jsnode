import { QueryTypes, Sequelize } from 'sequelize';
import {
    CollectorLease,
    CollectorLeaseOwnershipLostError,
    CollectorLeaseOwnershipProof,
    CollectorLeasePort,
    MarketMarkWritePort
} from './tinvest-readonly-market-data.port';
import type { BrokerMarketMark } from './types';

interface LeaseRow {
    owner_id: string;
    fencing_token: string;
    expires_at: Date | string;
}

interface PersistedMarkRow {
    observation_id: string;
    source_identity: string;
    payload_fingerprint: string;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export class PostgresMarketObservationRepository implements CollectorLeasePort, MarketMarkWritePort {
    constructor(
        private readonly database: Sequelize,
        private readonly leaseName: string
    ) {
        if (!leaseName.trim()) throw new Error('leaseName is required');
    }

    async acquire(ownerId: string, ttlMs: number): Promise<CollectorLease | undefined> {
        this.assertLeaseInput(ownerId, ttlMs);
        const rows = await this.database.query<LeaseRow>(
            "INSERT INTO virtual_market_observation_leases (lease_name, owner_id, fencing_token, expires_at) VALUES (:leaseName, :ownerId, 1, date_trunc('milliseconds', clock_timestamp() + (:ttlMs * INTERVAL '1 millisecond'))) ON CONFLICT (lease_name) DO UPDATE SET owner_id = EXCLUDED.owner_id, fencing_token = virtual_market_observation_leases.fencing_token + 1, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp() WHERE virtual_market_observation_leases.expires_at <= clock_timestamp() OR virtual_market_observation_leases.owner_id = EXCLUDED.owner_id RETURNING owner_id, fencing_token::text, expires_at",
            { replacements: { leaseName: this.leaseName, ownerId, ttlMs }, type: QueryTypes.SELECT }
        );
        const row = rows[0];
        if (!row || row.owner_id !== ownerId) return undefined;
        let proof = this.proof(row);
        const lease: CollectorLease = {
            renew: async nextTtlMs => {
                this.assertLeaseInput(ownerId, nextTtlMs);
                const renewed = await this.database.query<LeaseRow>(
                    "UPDATE virtual_market_observation_leases SET expires_at = date_trunc('milliseconds', clock_timestamp() + (:ttlMs * INTERVAL '1 millisecond')), updated_at = clock_timestamp() WHERE lease_name = :leaseName AND owner_id = :ownerId AND fencing_token = :fencingToken AND expires_at > clock_timestamp() RETURNING owner_id, fencing_token::text, expires_at",
                    { replacements: { leaseName: this.leaseName, ownerId, fencingToken: proof.fencingToken.toString(), ttlMs: nextTtlMs }, type: QueryTypes.SELECT }
                );
                if (!renewed[0]) return undefined;
                proof = this.proof(renewed[0]);
                return proof;
            },
            release: async () => {
                await this.database.query(
                    "UPDATE virtual_market_observation_leases SET expires_at = clock_timestamp(), updated_at = clock_timestamp() WHERE lease_name = :leaseName AND owner_id = :ownerId AND fencing_token = :fencingToken",
                    { replacements: { leaseName: this.leaseName, ownerId, fencingToken: proof.fencingToken.toString() } }
                );
            }
        };
        return Object.freeze(lease);
    }

    async append(mark: BrokerMarketMark, ownership: CollectorLeaseOwnershipProof): Promise<'inserted' | 'duplicate'> {
        try {
            return await this.database.transaction(async transaction => {
                const inserted = await this.database.query<{ observation_id: string }>(
                    "INSERT INTO virtual_market_marks (observation_id, source_identity, instrument_uid, broker_observed_at, received_at, bid_kopecks, ask_kopecks, mark_kopecks, source, session_status, source_sequence, payload_fingerprint, collector_lease_name, collector_owner_id, collector_fence, collector_expires_at) VALUES (:observationId, :sourceIdentity, :instrumentUid, :brokerObservedAt, :receivedAt, :bidKopecks, :askKopecks, :markKopecks, :source, :sessionStatus, :sourceSequence, :payloadFingerprint, :leaseName, :ownerId, :fencingToken, :collectorExpiresAt) ON CONFLICT (observation_id) DO NOTHING RETURNING observation_id",
                    {
                        replacements: {
                            observationId: mark.observationId,
                            sourceIdentity: mark.sourceIdentity,
                            instrumentUid: mark.instrumentUid,
                            brokerObservedAt: mark.brokerObservedAt,
                            receivedAt: mark.receivedAt,
                            bidKopecks: mark.bidKopecks.toString(),
                            askKopecks: mark.askKopecks.toString(),
                            markKopecks: mark.markKopecks.toString(),
                            source: mark.source,
                            sessionStatus: mark.sessionStatus,
                            sourceSequence: mark.sourceSequence ?? null,
                            payloadFingerprint: mark.payloadFingerprint,
                            leaseName: this.leaseName,
                            ownerId: ownership.ownerId,
                            fencingToken: ownership.fencingToken.toString(),
                            collectorExpiresAt: ownership.expiresAt
                        },
                        type: QueryTypes.SELECT,
                        transaction
                    }
                );
                if (inserted[0]) return 'inserted';
                const existing = await this.database.query<PersistedMarkRow>(
                    "SELECT observation_id, source_identity, payload_fingerprint FROM virtual_market_marks WHERE observation_id = :observationId",
                    { replacements: { observationId: mark.observationId }, type: QueryTypes.SELECT, transaction }
                );
                if (!existing[0]) throw new Error('market mark insert conflict without persisted identity');
                if (existing[0].source_identity !== mark.sourceIdentity
                    || existing[0].payload_fingerprint !== mark.payloadFingerprint) {
                    throw new Error('immutable market mark identity or payload conflict: ' + mark.observationId);
                }
                return 'duplicate';
            });
        } catch (error) {
            if (error instanceof Error && error.message.includes('market mark collector lease ownership lost')) {
                throw new CollectorLeaseOwnershipLostError();
            }
            throw error;
        }
    }

    private proof(row: LeaseRow): CollectorLeaseOwnershipProof {
        return Object.freeze({
            ownerId: row.owner_id,
            fencingToken: BigInt(row.fencing_token),
            expiresAt: iso(row.expires_at)
        });
    }

    private assertLeaseInput(ownerId: string, ttlMs: number): void {
        if (!ownerId.trim()) throw new Error('ownerId is required');
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive safe integer');
    }
}
