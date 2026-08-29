import { decodeKopecks } from './codecs';
import { VirtualExecutionResult, VirtualOrderIntent } from './execution';

const BIGINT_TAG = '$virtualBigInt';

export const virtualOrderIntentFingerprint = (order: VirtualOrderIntent) => [
    order.id, order.virtualAccountId, order.instrumentId, order.side,
    String(order.quantityLots), order.submittedAt
].map(value => `${value.length}:${value}`).join('|');

export const encodeVirtualExecutionResult = (result: VirtualExecutionResult) => JSON.stringify(
    result,
    (_key, value) => typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString(10) } : value
);

const deepFreeze = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
};

export const decodeVirtualExecutionResult = (json: string): VirtualExecutionResult => {
    if (typeof json !== 'string' || json.length === 0) throw new TypeError('virtual execution result JSON is required');
    const parsed = JSON.parse(json, (_key, value) => {
        if (value && typeof value === 'object' && Object.keys(value).length === 1 && BIGINT_TAG in value) {
            return decodeKopecks(String(value[BIGINT_TAG]));
        }
        return value;
    }) as VirtualExecutionResult;
    if (!parsed || (parsed.status !== 'filled' && parsed.status !== 'rejected')) {
        throw new Error('invalid stored virtual execution result');
    }
    return deepFreeze(parsed) as VirtualExecutionResult;
};
