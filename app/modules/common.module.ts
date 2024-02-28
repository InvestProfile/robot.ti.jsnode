// commonModule.ts

import operationService from "../services/operations.service";
import orderService from "../services/orders.service";
import marketData from "../services/marketData.service";
import TradesService from "../services/trades.service";

export const executeTrades = async () => {

    const portfolio = await operationService.getPortfolio('2054310628');

    if (portfolio?.positions) {
        for (let position of portfolio.positions) {
            // Проверяем, что все необходимые свойства существуют
            if (position?.averagePositionPriceFifo && position?.currentPrice) {
                // Преобразуем части числа в полноценное число
                const averagePrice = position.averagePositionPriceFifo.units + position.averagePositionPriceFifo.nano * 1e-9;
                const currentPrice = position.currentPrice.units + position.currentPrice.nano * 1e-9;

                const tradingStatus = await marketData.getStatus(
                    position.figi,
                    position.instrumentUid,
                )


                // Сравнение цен
                if (averagePrice < currentPrice && tradingStatus?.tradingStatus !== 1) {
                    console.log('averagePositionPrice is less than currentPrice: ', position);

                    console.log(tradingStatus)

                    // Продаем
                    await orderService.postOrder(
                        '2054310628',
                        2,
                        //position.quantity.units,
                        position.currentPrice,
                        position.figi,
                        position.instrumentUid,
                    )

                    // Пишем в базу
                    await TradesService.createTrade(
                        position?.figi,
                        "1",
                        position?.currentPrice?.units,
                        position?.currentPrice?.nano,
                        position.instrumentUid
                    )

                } else if (averagePrice > currentPrice) {
                    //console.log('averagePositionPrice is greater than currentPrice: ', position);
                } else {
                    //console.log('averagePositionPrice is equal to currentPrice: ', position);
                }

            }
        }
    }
}

// Эту функцию можно вызвать из другого файла для запуска процесса
export function startTradingProcess() {
    setInterval(async () => {
        try {
            await executeTrades();
        } catch (error) {
            console.error('Error occurred in trading process:', error);
        }
    }, 60000); // Запускаем каждую минуту
}
