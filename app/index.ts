

// import initDebug from './debug-instance'
// const debug = initDebug(__filename)
// debug('hui')

const greeting: string = "Hello, TypeScript!";
console.log(greeting);


import { getEnv } from './config/env.config';

const envVariables = getEnv();

console.log(`The Tinkoff INVEST_TOKEN is: ${envVariables.INVEST_TOKEN}`);

import { createSdk } from 'tinkoff-sdk-grpc-js';

!(async function example() {
    if (envVariables.INVEST_TOKEN) {
        const {users, operations} = createSdk(envVariables.INVEST_TOKEN);

        const userInfo = await users.getInfo({});
        const accounts = await users.getAccounts({});
        const tarrif = await users.getUserTariff({});
        console.log('Информация о пользователе:', userInfo);
        console.log('Информация о счетах:', accounts);
        console.log('Информация о тарифе пользователя:', tarrif);

        const positions = await operations.getPortfolio({accountId: '2054310628'})
        console.log("positions", positions)

    }
})();
