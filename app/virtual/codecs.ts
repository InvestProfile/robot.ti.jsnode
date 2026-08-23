import {
    StoredVirtualLedgerEvent,
    VirtualLedgerEvent
} from './types';

const CANONICAL_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;
const RFC3339_WITH_ZONE =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export const encodeKopecks = (value: bigint): string => {
    if (typeof value !== 'bigint') throw new TypeError('kopecks must be a bigint');
    return value.toString(10);
};

export const decodeKopecks = (value: string): bigint => {
    if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) {
        throw new TypeError('kopecks must be a strict canonical decimal string');
    }
    return BigInt(value);
};

export const normalizeRfc3339Timestamp = (value: string): string => {
    if (typeof value !== 'string' || !RFC3339_WITH_ZONE.test(value)) {
        throw new TypeError('occurredAt must be an RFC3339 timestamp with timezone');
    }
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) throw new TypeError('occurredAt must be a valid RFC3339 timestamp');
    const normalized = new Date(epoch).toISOString();

    // Date.parse normalizes impossible calendar dates, so verify date components
    // by reparsing the normalized instant through the original offset.
    const match = RFC3339_WITH_ZONE.exec(value);
    if (!match) throw new TypeError('occurredAt must be an RFC3339 timestamp with timezone');
    const [, year, month, day, hour, minute, second, , zone] = match;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const daysInMonth = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
    const invalidClock = Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59;
    const invalidZone = zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59);
    if (yearNumber < 1 || monthNumber < 1 || monthNumber > 12
        || dayNumber < 1 || dayNumber > daysInMonth || invalidClock || invalidZone) {
        throw new TypeError('occurredAt must be a valid RFC3339 timestamp');
    }

    return normalized;
};

export const encodeVirtualLedgerEvent = (
    event: VirtualLedgerEvent
): StoredVirtualLedgerEvent => Object.freeze({
    ...event,
    amountKopecks: encodeKopecks(event.amountKopecks)
}) as StoredVirtualLedgerEvent;

export const decodeVirtualLedgerEvent = (
    event: StoredVirtualLedgerEvent
): VirtualLedgerEvent => ({
    ...event,
    amountKopecks: decodeKopecks(event.amountKopecks)
}) as VirtualLedgerEvent;
