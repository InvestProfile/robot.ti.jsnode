import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

export interface ScanUniverseItem {
    ticker: string;
    name?: string;
    figi?: string;
    instrumentUid?: string;
    lot?: number;
    currency?: string;
    exchange?: string;
    sector?: string;
    lastPrice?: number;
    estimatedLotRub?: number;
}

const isMoexRubShare = (instrument: ShareInstrument) => {
    return Boolean(
        instrument.uid
        && instrument.figi
        && instrument.ticker
        && instrument.currency?.toLowerCase() === 'rub'
        && instrument.apiTradeAvailableFlag
        && instrument.buyAvailableFlag
        && !instrument.forQualInvestorFlag
        && !instrument.otcFlag
        && instrument.liquidityFlag
        && instrument.realExchange === 1
    );
};

export default class ScanUniverseService {
    static async resolveTickers(config: RobotConfig) {
        if (config.scanUniverse !== 'auto') {
            return {
                mode: 'manual' as const,
                tickers: config.scanTickers,
                totalShares: undefined,
                eligibleBeforePriceFilter: undefined,
                items: [] as ScanUniverseItem[]
            };
        }

        const result = await this.build(config);

        return {
            mode: 'auto' as const,
            tickers: result.items.map(item => item.ticker),
            totalShares: result.totalShares,
            eligibleBeforePriceFilter: result.eligibleBeforePriceFilter,
            items: result.items
        };
    }

    static async build(config: RobotConfig) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const eligible = instruments.filter(isMoexRubShare);
        const prices = await MarketDataService.getLastPrices(eligible.map(instrument => instrument.uid));
        const items = eligible
            .map<ScanUniverseItem | undefined>(instrument => {
                const lastPrice = prices.get(instrument.uid);
                const estimatedLotRub = lastPrice !== undefined
                    ? lastPrice * Math.max(1, instrument.lot ?? 1)
                    : undefined;

                if (!lastPrice || !estimatedLotRub) return undefined;
                if (config.scanMaxLotRub > 0 && estimatedLotRub > config.scanMaxLotRub) return undefined;

                return {
                    ticker: instrument.ticker.toUpperCase(),
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    lot: instrument.lot,
                    currency: instrument.currency,
                    exchange: instrument.exchange,
                    sector: instrument.sector,
                    lastPrice,
                    estimatedLotRub
                };
            })
            .filter((item): item is ScanUniverseItem => Boolean(item))
            .sort((a, b) => (b.estimatedLotRub ?? 0) - (a.estimatedLotRub ?? 0))
            .slice(0, config.scanUniverseLimit);

        return {
            mode: config.scanUniverse,
            totalShares: instruments.length,
            eligibleBeforePriceFilter: eligible.length,
            limit: config.scanUniverseLimit,
            maxLotRub: config.scanMaxLotRub,
            items
        };
    }
}
