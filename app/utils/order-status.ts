import {
    OrderExecutionReportStatus,
    OrderType,
    orderExecutionReportStatusToJSON,
    orderTypeToJSON
} from 'tinkoff-sdk-grpc-js/dist/generated/orders';

const FINAL_STATUSES = new Set([
    'EXECUTION_REPORT_STATUS_FILL',
    'EXECUTION_REPORT_STATUS_REJECTED',
    'EXECUTION_REPORT_STATUS_CANCELLED',
    'LOCAL_POST_REJECTED',
    'LOCAL_VALIDATION_FAILED'
]);

export const LOCAL_PENDING_ORDER_STATUS = 'LOCAL_PENDING_SUBMIT';
export const LOCAL_UNKNOWN_ORDER_STATUS = 'LOCAL_SUBMIT_UNKNOWN';
export const LOCAL_REJECTED_ORDER_STATUS = 'LOCAL_POST_REJECTED';

export const normalizeOrderStatus = (value: unknown) => {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value === 'number') {
        return orderExecutionReportStatusToJSON(value as OrderExecutionReportStatus);
    }

    return String(value);
};

export const normalizeOrderType = (value: unknown) => {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value === 'number') {
        return orderTypeToJSON(value as OrderType);
    }

    return String(value);
};

export const isFinalOrderStatus = (status: string | undefined | null) => {
    if (!status) return false;
    return FINAL_STATUSES.has(status);
};
