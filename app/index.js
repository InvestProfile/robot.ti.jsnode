"use strict";
// index.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const debug_instance_1 = __importDefault(require("./debug-instance"));
const debug = (0, debug_instance_1.default)(__filename);
debug('hui');
const greeting = "Hello, TypeScript!";
console.log(greeting);
// import * as dotenv from 'dotenv';
// dotenv.config();
//
// const dbHost = process.env.DB_HOST;
// const dbUser = process.env.DB_USER;
// const dbPass = process.env.DB_PASSWORD;
// const investToken = process.env.INVEST_TOKEN;
//
// console.log("investToken")
// console.log(investToken)
