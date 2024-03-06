// commonModule.ts

import operationService from "../services/operations.service";
import orderService from "../services/orders.service";
import marketData from "../services/marketData.service";
import TradesService from "../services/trades.service";
import InstrumentsService from "../services/instruments.service";

// Функция для создания задержки
function delay(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export const executeTrades = async (accountId: string) => {

    console.log('accountId: ' + accountId)

    const portfolio = await operationService.getPortfolio(accountId);

    if (portfolio?.positions) {
        for (let position of portfolio.positions) {
            // Проверяем, что все необходимые свойства существуют
            if (position?.averagePositionPrice && position?.currentPrice) {
                // Преобразуем части числа в полноценное число
                const averagePositionPrice = position.averagePositionPrice.units + position.averagePositionPrice.nano * 1e-9;
                const currentPrice = position.currentPrice.units + position.currentPrice.nano * 1e-9;


                // Ждем n секунд (n * 1000 миллисекунд)
                await delay(2 * 1000);


                // getStatus
                const tradingStatus = await marketData.getStatus(
                    position.figi,
                    position.instrumentUid,
                )


                // instruments
                const shares = await InstrumentsService.getShares()
                if (shares && shares.instruments) {
                    const instruments = shares.instruments;
                    const instrument = instruments.find(instrument => instrument?.figi === position?.figi);
                    console.log(
                        "Check || " +
                        "FIGI(position): " + position?.figi + ", " +
                        "status(position): " + tradingStatus?.tradingStatus + " || " +
                        "FIGI(instrument): " + instrument?.figi + ", " +
                        "ticker(instrument): " + instrument?.name + ", " +
                        "ticker(instrument): " + instrument?.name)
                }




                // Сравнение цен
                if (currentPrice > averagePositionPrice * 1.005 && tradingStatus?.tradingStatus === 5) {
                // if (currentPrice > averagePositionPrice && tradingStatus?.tradingStatus === 5) {
                    console.log('averagePositionPrice is less than currentPrice: ', position);

                    try {
                        // Продаем
                        const orderResult = await orderService.postOrder(
                            accountId,
                            2,
                            position.quantityLots?.units,
                            position.currentPrice,
                            position.figi,
                            position.instrumentUid,
                        );

                        // Временно выводим результат в консоль для отладки
                        console.log(orderResult);

                        if (orderResult) {

                            // instruments
                            const shares = await InstrumentsService.getShares()
                            if (shares && shares.instruments) {
                                const instruments = shares.instruments;
                                const instrument = instruments.find(instrument => instrument?.figi === position?.figi && instrument?.uid === position?.instrumentUid);

                                // Пишем в базу
                                await TradesService.createTrade(
                                    position?.figi,
                                    "1",
                                    "2",
                                    position?.currentPrice?.units,
                                    position?.currentPrice?.nano,
                                    position?.instrumentUid,
                                    position?.instrumentUid,
                                    accountId,
                                    instrument?.ticker,
                                    instrument?.name,
                                    position?.quantityLots?.units
                                )
                            }




                        } else {
                            // Логика обработки неуспешного заказа
                        }
                    }
                    catch (error: any) {
                        if (error?.code === 'INVALID_ARGUMENT' && error?.details.includes('30079')) {
                            console.error('Инструмент недоступен для торгов:', error);
                            // Дополнительная логика обработки этой ошибки
                            return;
                        } else {
                            // Обработка других видов ошибок
                            throw error;
                        }
                    }




                } else if (averagePositionPrice > currentPrice) {
                    // console.log('averagePositionPrice is greater than currentPrice: ', position.figi);
                } else {
                    // console.log('averagePositionPrice is equal to currentPrice: ', position);
                }

            }
        }
    }
}

// Эту функцию можно вызвать из другого файла для запуска процесса
export function startTradingProcess() {

    // (async () => {
    //     // console.log(await InstrumentsService.getShares())
    //
    //     // instruments
    //     const shares = await InstrumentsService.getShares()
    //
    //     if (shares && shares.instruments) {
    //         const instruments = shares.instruments;
    //
    //         const instrument = instruments.find(instrument => instrument?.figi === 'TCS00A0F61T7' && instrument?.positionUid === '0bca5962-b96e-417b-99dd-d45d538c15b2');
    //         console.log(instrument)
    //     }
    //
    // })()

    // setInterval(async () => {
    //     try {
    //         console.log("Hello! =)")
    //
    //         const accountIDs = ['2051251635', '2054310628'];
    //
    //         for (let accountID of accountIDs) {
    //             await executeTrades(accountID);
    //         }
    //
    //     } catch (error) {
    //         console.error('Error occurred in trading process:', error);
    //     }
    // }, 10 * 1000);

//=====

    async function executeAllTrades() {
        try {
            console.log("Hello! =)");

            const accountIDs = ['2051251635', '2054310628'];

            for (let accountID of accountIDs) {
                await executeTrades(accountID);
            }

            // После выполнения всех операций ждем некоторое время перед следующим вызовом
            // await new Promise(resolve => setTimeout(resolve, 10 * 1000));

            // Рекурсивный вызов функции для повторения процесса
            await executeAllTrades();
        } catch (error) {
            console.error('Error occurred in trading process:', error);

            // Вы можете решить, хотите ли вы продолжить цикл после ошибки
            await new Promise(resolve => setTimeout(resolve, 10 * 1000));
            await executeAllTrades();
        }
    }

    // Запуск функции
    executeAllTrades().then(r => console.log("Complete."));

}
