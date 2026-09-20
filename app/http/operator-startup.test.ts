import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('paused production entrypoint starts HTTP only, not trading or scanner loops', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'robot-paused-start-'));
    const build = path.resolve('build');
    const code = `
      const root = ${JSON.stringify(build)};
      require(root+'/services/database.service.js').default.init=async()=>{};
      let http=0,trading=0;
      require(root+'/http/readonly-server.js').startReadOnlyHttpServer=()=>{http++;};
      require(root+'/modules/common.module.js').startTradingProcess=()=>{trading++;};
      require(root+'/index.js');
      setImmediate(()=>{process.stdout.write(JSON.stringify({http,trading}));process.exit(http===1&&trading===0?0:1);});
    `;
    try {
        const r = spawnSync(process.execPath, ['-e', code], { cwd, timeout: 15000, encoding: 'utf8',
            env: { PATH: process.env.PATH, DB_DIALECT: 'postgres', DB_NAME: 'test', DB_USER: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', ROBOT_ACCOUNT_IDS: 'test-account', ROBOT_TRADING_PAUSED: 'true' } });
        assert.equal(r.status, 0, 'isolated paused startup must not start trading');
        assert.ok(r.stdout.includes('"http":1,"trading":0'));
    } finally { rmSync(cwd, { recursive: true }); }
});
