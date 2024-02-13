

// import initDebug from './debug-instance'
// const debug = initDebug(__filename)
// debug('hui')

// const greeting: string = "Hello, TypeScript!";
// console.log(greeting);


import { getEnv } from './config/env.config';

const envVariables = getEnv();

console.log(`The Tinkoff INVEST_TOKEN is: ${envVariables.INVEST_TOKEN}`);
