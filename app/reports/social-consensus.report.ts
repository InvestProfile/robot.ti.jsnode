import DatabaseService from '../services/database.service';
import SocialConsensusService from '../services/social-consensus.service';
import { getRobotConfig } from '../config/robot.config';

const main = async () => {
    await DatabaseService.init();
    const config = getRobotConfig();
    const result = await SocialConsensusService.getConsensus({
        days: config.socialConsensusDays,
        maxScoreAdjustment: config.socialConsensusMaxScoreAdjustment,
        minActors: config.socialConsensusMinActors
    });

    console.log('Social Consensus');
    console.log('================');
    console.log(`Generated: ${result.generatedAt}`);
    console.log(`Window: ${result.days}d`);
    console.log(`Max score adjustment: +/-${result.maxScoreAdjustment}`);
    console.log(`Min actors: ${result.minActors}`);
    console.log('');
    console.log('Ticker      Mood       Score  Adj  Actors  Signals  Buy  Sell  Weights       Reason');
    console.log('----------  ---------  -----  ---  ------  -------  ---  ----  ------------  ----------------------------------------');

    for (const item of result.items) {
        console.log([
            item.ticker.padEnd(10),
            item.mood.padEnd(9),
            String(item.score).padStart(5),
            String(item.scoreAdjustment).padStart(3),
            String(item.actors).padStart(6),
            String(item.signals).padStart(7),
            String(item.buy).padStart(3),
            String(item.sell).padStart(4),
            `${item.bullishWeight}/${item.bearishWeight}`.padEnd(12),
            item.reason
        ].join('  '));
    }
};

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
