/** Marker and root for the isolated paper-trading bounded context. */
export const PAPER_NAMESPACE = 'paper' as const;

export * from './shadow-intent.adapter';
export * from './shadow-observation.repository';
export * from './read-api';
export * from './shadow-runner';
