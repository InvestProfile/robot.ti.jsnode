export const TINVEST_SANDBOX_ENVIRONMENT = Object.freeze({
    kind: 't-invest-sandbox' as const,
    label: 'T-INVEST SANDBOX — VIRTUAL MONEY — NOT LIVE',
    isLive: false as const
});

export const TINVEST_SANDBOX_CAPABILITIES = Object.freeze({
    accountLifecycle: true,
    virtualFunding: true,
    marketOrders: true,
    limitOrders: true,
    stopLoss: true,
    takeProfit: true,
    deterministicClientOrderIds: true,
    limitations: Object.freeze([
        'Sandbox validates request shapes and lifecycle behavior, not production execution quality.',
        'Sandbox margin values are not a realistic margin model and must not drive margin decisions.',
        'Unknown submit or order states require reconciliation and are never blindly retried.'
    ])
});

export type SandboxSide = 'buy' | 'sell';
export type SandboxOrderKind = 'market' | 'limit';
export type SandboxStopKind = 'stop-loss' | 'take-profit';

export interface SandboxTransportRequest {
    readonly environment: 't-invest-sandbox';
    readonly operation: 'open-account' | 'close-account' | 'fund-account' | 'submit-order' | 'submit-stop' | 'get-order-state';
    readonly commandId: string;
    readonly accountId?: string;
    readonly clientOrderId?: string;
    readonly instrumentId?: string;
    readonly side?: SandboxSide;
    readonly quantityLots?: number;
    readonly orderKind?: SandboxOrderKind;
    readonly priceKopecks?: string;
    readonly stopKind?: SandboxStopKind;
    readonly stopPriceKopecks?: string;
    readonly limitPriceKopecks?: string;
    readonly amountKopecks?: string;
    readonly brokerOrderId?: string;
}

export interface SandboxTransportResponse {
    readonly state: 'accepted' | 'rejected' | 'pending' | 'unknown';
    readonly accountId?: string;
    readonly brokerOrderId?: string;
    readonly reason?: string;
}

export interface SandboxTransport {
    execute(request: SandboxTransportRequest): Promise<SandboxTransportResponse>;
}

export interface SandboxCommandResult {
    readonly environment: typeof TINVEST_SANDBOX_ENVIRONMENT;
    readonly commandId: string;
    readonly state: 'accepted' | 'rejected' | 'pending' | 'unknown-reconcile-required';
    readonly accountId?: string;
    readonly brokerOrderId?: string;
    readonly reason?: string;
    readonly retryAllowed: false;
}

export interface SandboxOrderIntent {
    readonly experimentId: string;
    readonly intentId: string;
    readonly accountId: string;
    readonly instrumentId: string;
    readonly side: SandboxSide;
    readonly quantityLots: number;
    readonly kind: SandboxOrderKind;
    readonly priceKopecks?: bigint;
}

export interface SandboxStopIntent {
    readonly experimentId: string;
    readonly intentId: string;
    readonly accountId: string;
    readonly instrumentId: string;
    readonly side: SandboxSide;
    readonly quantityLots: number;
    readonly kind: SandboxStopKind;
    readonly stopPriceKopecks: bigint;
    readonly limitPriceKopecks?: bigint;
}

const requireId = (name: string, value: string) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${name} must be a trimmed non-empty string`);
    }
};

const requireLots = (value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('quantityLots must be a positive safe integer');
};

const encodeMoney = (name: string, value: bigint, allowZero = false) => {
    if (typeof value !== 'bigint' || (allowZero ? value < 0n : value <= 0n)) {
        throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} bigint`);
    }
    return value.toString(10);
};

export const decodeSandboxMoney = (value: string): bigint => {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
        throw new TypeError('sandbox money must be a canonical non-negative decimal string');
    }
    return BigInt(value);
};

const stableFingerprint = (parts: readonly (string | number | undefined)[]) => parts
    .map(value => value === undefined ? '-' : `${String(value).length}:${String(value)}`)
    .join('|');

const fnv1a64 = (value: string) => {
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(value, 'utf8')) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
};

export const deterministicSandboxClientOrderId = (experimentId: string, intentId: string) => {
    requireId('experimentId', experimentId);
    requireId('intentId', intentId);
    return `sbx-${fnv1a64(stableFingerprint([experimentId, intentId]))}`;
};

const unknownResult = (commandId: string, reason: string): SandboxCommandResult => Object.freeze({
    environment: TINVEST_SANDBOX_ENVIRONMENT, commandId,
    state: 'unknown-reconcile-required', reason, retryAllowed: false
});

const normalizeResult = (
    operation: SandboxTransportRequest['operation'],
    commandId: string,
    source: unknown
): SandboxCommandResult => {
    if (!source || typeof source !== 'object') return unknownResult(commandId, 'malformed sandbox response; reconcile required');
    const response = source as Partial<SandboxTransportResponse>;
    if (!['accepted', 'rejected', 'pending', 'unknown'].includes(String(response.state))) {
        return unknownResult(commandId, 'malformed sandbox response state; reconcile required');
    }
    const state = response.state as SandboxTransportResponse['state'];
    for (const value of [response.accountId, response.brokerOrderId, response.reason]) {
        if (value !== undefined && (typeof value !== 'string' || !value || value.trim() !== value)) {
            return unknownResult(commandId, 'malformed sandbox response identity; reconcile required');
        }
    }
    if (state === 'accepted' && operation === 'open-account' && !response.accountId) {
        return unknownResult(commandId, 'accepted sandbox account has no account ID; reconcile required');
    }
    if (state === 'accepted' && (operation === 'submit-order' || operation === 'submit-stop') && !response.brokerOrderId) {
        return unknownResult(commandId, 'accepted sandbox order has no broker order ID; reconcile required');
    }
    return Object.freeze({
        environment: TINVEST_SANDBOX_ENVIRONMENT,
        commandId,
        state: state === 'unknown' ? 'unknown-reconcile-required' : state,
        ...(response.accountId === undefined ? {} : { accountId: response.accountId }),
        ...(response.brokerOrderId === undefined ? {} : { brokerOrderId: response.brokerOrderId }),
        ...(response.reason === undefined ? {} : { reason: response.reason }),
        retryAllowed: false
    });
};

export class TInvestSandboxAdapter {
    readonly environment = TINVEST_SANDBOX_ENVIRONMENT;
    readonly capabilities = TINVEST_SANDBOX_CAPABILITIES;
    readonly #transport: SandboxTransport;
    readonly #commands = new Map<string, { fingerprint: string; result: Promise<SandboxCommandResult> }>();

    constructor(transport: SandboxTransport) {
        if (!transport || typeof transport.execute !== 'function') throw new TypeError('sandbox transport is required');
        this.#transport = transport;
    }

    openAccount(commandId: string) {
        return this.#execute({ environment: 't-invest-sandbox', operation: 'open-account', commandId });
    }

    closeAccount(commandId: string, accountId: string) {
        requireId('accountId', accountId);
        return this.#execute({ environment: 't-invest-sandbox', operation: 'close-account', commandId, accountId });
    }

    fundAccount(commandId: string, accountId: string, amountKopecks: bigint) {
        requireId('accountId', accountId);
        return this.#execute({
            environment: 't-invest-sandbox', operation: 'fund-account', commandId, accountId,
            amountKopecks: encodeMoney('amountKopecks', amountKopecks)
        });
    }

    submitOrder(intent: SandboxOrderIntent) {
        this.#validateTradeIntent(intent);
        if (intent.kind === 'limit' && intent.priceKopecks === undefined) throw new TypeError('limit order requires priceKopecks');
        if (intent.kind === 'market' && intent.priceKopecks !== undefined) throw new TypeError('market order must not include priceKopecks');
        const clientOrderId = deterministicSandboxClientOrderId(intent.experimentId, intent.intentId);
        return this.#execute({
            environment: 't-invest-sandbox', operation: 'submit-order', commandId: clientOrderId,
            clientOrderId, accountId: intent.accountId, instrumentId: intent.instrumentId,
            side: intent.side, quantityLots: intent.quantityLots, orderKind: intent.kind,
            ...(intent.priceKopecks === undefined ? {} : { priceKopecks: encodeMoney('priceKopecks', intent.priceKopecks) })
        });
    }

    submitStop(intent: SandboxStopIntent) {
        this.#validateTradeIntent(intent);
        const clientOrderId = deterministicSandboxClientOrderId(intent.experimentId, intent.intentId);
        return this.#execute({
            environment: 't-invest-sandbox', operation: 'submit-stop', commandId: clientOrderId,
            clientOrderId, accountId: intent.accountId, instrumentId: intent.instrumentId,
            side: intent.side, quantityLots: intent.quantityLots, stopKind: intent.kind,
            stopPriceKopecks: encodeMoney('stopPriceKopecks', intent.stopPriceKopecks),
            ...(intent.limitPriceKopecks === undefined ? {} : { limitPriceKopecks: encodeMoney('limitPriceKopecks', intent.limitPriceKopecks) })
        });
    }

    getOrderState(commandId: string, accountId: string, brokerOrderId: string) {
        requireId('accountId', accountId);
        requireId('brokerOrderId', brokerOrderId);
        return this.#execute({
            environment: 't-invest-sandbox', operation: 'get-order-state', commandId, accountId, brokerOrderId
        });
    }

    #validateTradeIntent(intent: SandboxOrderIntent | SandboxStopIntent) {
        requireId('experimentId', intent.experimentId);
        requireId('intentId', intent.intentId);
        requireId('accountId', intent.accountId);
        requireId('instrumentId', intent.instrumentId);
        if (intent.side !== 'buy' && intent.side !== 'sell') throw new TypeError('side must be buy or sell');
        requireLots(intent.quantityLots);
    }

    #execute(request: SandboxTransportRequest): Promise<SandboxCommandResult> {
        requireId('commandId', request.commandId);
        const fingerprint = stableFingerprint([
            request.environment, request.operation, request.commandId, request.accountId, request.clientOrderId,
            request.instrumentId, request.side, request.quantityLots, request.orderKind, request.priceKopecks,
            request.stopKind, request.stopPriceKopecks, request.limitPriceKopecks, request.amountKopecks, request.brokerOrderId
        ]);
        const existing = this.#commands.get(request.commandId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error(`sandbox command ID conflict: ${request.commandId}`);
            return existing.result;
        }
        const result = this.#transport.execute(Object.freeze({ ...request }))
            .then(response => normalizeResult(request.operation, request.commandId, response))
            .catch(() => unknownResult(request.commandId, 'transport outcome unknown; reconcile before any further action'));
        this.#commands.set(request.commandId, { fingerprint, result });
        return result;
    }
}
