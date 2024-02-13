"use strict";
// import initDebug from './debug-instance'
// const debug = initDebug(__filename)
// debug('hui')
Object.defineProperty(exports, "__esModule", { value: true });
// const greeting: string = "Hello, TypeScript!";
// console.log(greeting);
const env_config_1 = require("./config/env.config");
const envVariables = (0, env_config_1.getEnv)();
console.log(`The Tinkoff INVEST_TOKEN is: ${envVariables.INVEST_TOKEN}`);
