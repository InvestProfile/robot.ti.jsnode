/** Marker and root for the isolated virtual-account bounded context. */
export const VIRTUAL_NAMESPACE = 'virtual' as const;

export * from './types';
export * from './codecs';
export * from './ledger';
export * from './valuation';
export * from './repository';
export * from './execution';
export * from './positions';
export * from './position-repository';
export * from './reconciliation';
export * from './execution-codecs';
