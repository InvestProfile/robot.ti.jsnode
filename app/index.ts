//
// //import test from './test';
// //import { Test } from './test';
// //import { getHelloWorld } from './greetings';
//
// import { TradesModel } from './models/trades.model';
// import TradesService from "./services/trades.service";
//
// import operationService from "./services/operations.service";
// import orderService from "./services/orders.service"
// import marketData from "./services/marketData.service"
//
// (async function() {
//     // await test.example();
//     // const message = await getHelloWorld();
//     // console.log(message);
//
//     const portfolio = await operationService.getPortfolio('2054310628')
//     //console.log(portfolio?.positions)
//
//     // const positions = await operationService.getPositions('2054310628')
//     // console.log(positions)
//
//     if (portfolio?.positions) {
//         for (let position of portfolio.positions) {
//             // Проверяем, что все необходимые свойства существуют
//             if (position?.averagePositionPriceFifo && position?.currentPrice) {
//                 // Преобразуем части числа в полноценное число
//                 const averagePrice = position.averagePositionPriceFifo.units + position.averagePositionPriceFifo.nano * 1e-9;
//                 const currentPrice = position.currentPrice.units + position.currentPrice.nano * 1e-9;
//
//                 const tradingStatus = await marketData.getStatus(
//                     position.figi,
//                     position.instrumentUid,
//                 )
//
//
//                 // Сравнение цен
//                 if (averagePrice < currentPrice && tradingStatus?.tradingStatus !== 1) {
//                     console.log('averagePositionPrice is less than currentPrice: ', position);
//
//                     console.log(tradingStatus)
//
//                     // Продаем
//                     await orderService.postOrder(
//                         '2054310628',
//                         2,
//                         //position.quantity.units,
//                         position.currentPrice,
//                         position.figi,
//                         position.instrumentUid,
//                     )
//
//                     // Пишем в базу
//                     await TradesService.createTrade(
//                         position?.figi,
//                         "1",
//                         position?.currentPrice?.units,
//                         position?.currentPrice?.nano,
//                         position.instrumentUid
//                     )
//
//                 } else if (averagePrice > currentPrice) {
//                     //console.log('averagePositionPrice is greater than currentPrice: ', position);
//                 } else {
//                     //console.log('averagePositionPrice is equal to currentPrice: ', position);
//                 }
//
//             }
//         }
//     }
// })();
//
//


// index.ts или app.ts

import { startTradingProcess } from './modules/common.module';

// Запускаем процесс торговли
startTradingProcess();
