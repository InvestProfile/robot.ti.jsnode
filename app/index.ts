
import test from './test';
import { getHelloWorld } from './greetings';




//(async function() {

    //await test.example();

    //const message = await getHelloWorld();
    //console.log(message);

//})();



// import { UserModel } from './user.model';
//
// async function createUser() {
//     try {
//         await UserModel.sync(); // Эта команда создаст таблицу, если она не существует (и не изменит существующую)
//         const newUser = await UserModel.create({
//             name: 'John Doe',
//             email: 'john.doe@example.com',
//         });
//         console.log(newUser); // Вывод данных нового пользователя
//     } catch (error) {
//         console.error('Unable to create new user:', error);
//     }
// }
//
// createUser().then(r => {console.log("Module index - createUser()")});


// import { TradesModel } from './models/trades.model';
//
// async function createTrade() {
//     try {
//         await TradesModel.sync(); // Эта команда создаст таблицу, если она не существует (и не изменит существующую)
//         // const newUser = await TradesModel.create({
//         //     name: 'John Doe',
//         // });
//         // console.log(newUser); // Вывод данных нового пользователя
//     } catch (error) {
//         console.error('Unable to create new user:', error);
//     }
// }
//
// createTrade().then(r => {console.log("Module index - createTrades()")});


// index.ts или любой другой файл, откуда вы хотите использовать сервис
import { TradesService } from './services/trades.service';

const tradesService = new TradesService();

tradesService.createTrades()
    .then(() => {
        console.log("Module index - createTrade()");
    })
    .catch(error => {
        console.error("Failed to create trade:", error);
    });

tradesService.findTradeById(1)
    .then(trade => {
        if (trade) {
            console.log("Trade details:", trade);
        } else {
            console.log("Trade not found.");
        }
    })
    .catch(error => {
        console.error("Error during trade search:", error);
    });
