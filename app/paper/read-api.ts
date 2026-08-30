import {
    decodePaperLabCursor,
    PaperLabPayload,
    parsePaperLabLimit
} from '../services/paper-lab-read-model.service';

export interface PaperLabReadPort {
    load(virtualAccountId: string | undefined, limit: number, cursor?: unknown): Promise<PaperLabPayload>;
}

export interface PaperApiRequest {
    readonly method?: string;
    readonly url: URL;
}

export interface PaperApiResponse {
    readonly statusCode: number;
    readonly payload: unknown;
    readonly allow?: string;
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const handlePaperReadApi = async (
    request: PaperApiRequest,
    service: PaperLabReadPort
): Promise<PaperApiResponse> => {
    if (request.method !== 'GET') {
        return { statusCode: 405, allow: 'GET', payload: { error: 'Method not allowed' } };
    }
    const virtualAccountId = request.url.searchParams.get('virtualAccountId')?.trim();
    if (virtualAccountId && !ACCOUNT_ID_PATTERN.test(virtualAccountId)) {
        return { statusCode: 400, payload: { error: 'invalid virtualAccountId' } };
    }
    const limitValue = request.url.searchParams.get('limit');
    if (limitValue !== null && (!/^\d+$/.test(limitValue) || Number(limitValue) < 1)) {
        return { statusCode: 400, payload: { error: 'limit must be a positive integer' } };
    }
    try {
        const cursor = virtualAccountId
            ? decodePaperLabCursor(request.url.searchParams.get('cursor'), virtualAccountId)
            : undefined;
        if (!virtualAccountId && request.url.searchParams.has('cursor')) {
            return { statusCode: 400, payload: { error: 'cursor requires virtualAccountId' } };
        }
        return {
            statusCode: 200,
            payload: await service.load(virtualAccountId, parsePaperLabLimit(limitValue), cursor)
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('virtual account not found:')) {
            return { statusCode: 404, payload: { error: message } };
        }
        return { statusCode: 400, payload: { error: message } };
    }
};
