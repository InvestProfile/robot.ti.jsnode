import type {
    VirtualExecutionPolicy,
    VirtualExecutionResult,
    VirtualMarketQuote
} from '../virtual/execution';
import type { ShadowDecisionObservation, ShadowIntentAdaptation } from './shadow-intent.adapter';

export interface ShadowObservationStore {
    append(observation: ShadowDecisionObservation): Promise<void>;
}

export interface ShadowVirtualExecutionPort {
    execute(
        intent: NonNullable<ShadowIntentAdaptation['intent']>,
        quote: VirtualMarketQuote,
        context: { readonly now: string; readonly availableLots: number },
        policy: VirtualExecutionPolicy
    ): Promise<VirtualExecutionResult>;
}

export interface ShadowExecutionInput {
    readonly adaptation: ShadowIntentAdaptation;
    readonly quote?: VirtualMarketQuote;
    readonly availableLots?: number;
    readonly policy?: VirtualExecutionPolicy;
}

export type ShadowRunResult =
    | { readonly status: 'disabled' }
    | { readonly status: 'observed'; readonly observation: ShadowDecisionObservation }
    | {
        readonly status: 'executed';
        readonly observation: ShadowDecisionObservation;
        readonly execution: VirtualExecutionResult;
    };

export class ShadowRunner {
    constructor(
        private readonly enabled: boolean,
        private readonly observations: ShadowObservationStore,
        private readonly execution: ShadowVirtualExecutionPort
    ) {}

    async run(input: ShadowExecutionInput): Promise<ShadowRunResult> {
        if (!this.enabled) return Object.freeze({ status: 'disabled' });

        await this.observations.append(input.adaptation.observation);
        const intent = input.adaptation.intent;
        if (!intent) {
            return Object.freeze({
                status: 'observed',
                observation: input.adaptation.observation
            });
        }
        if (!input.quote || input.availableLots === undefined || !input.policy) {
            throw new Error('executable shadow intent requires quote, availableLots and policy');
        }
        const execution = await this.execution.execute(intent, input.quote, {
            now: input.adaptation.observation.evaluatedAt,
            availableLots: input.availableLots
        }, input.policy);
        return Object.freeze({
            status: 'executed',
            observation: input.adaptation.observation,
            execution
        });
    }
}
