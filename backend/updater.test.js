'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startUpdate, UPDATE_SERVICE } = require('./updater');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-updater-'));
const serviceFile = path.join(tmpDir, 'proxybridge-update.service');
fs.writeFileSync(serviceFile, '# fake unit\n');

test('starts the fixed systemd update service when inactive', async () => {
  const calls = [];
  const execute = (command, args, callback) => {
    calls.push([command, ...args]);
    callback(calls.length === 1 ? new Error('inactive') : null);
  };

  await startUpdate(execute, { serviceFile });

  assert.deepEqual(calls, [
    ['systemctl', 'is-active', '--quiet', UPDATE_SERVICE],
    ['systemctl', 'start', '--no-block', UPDATE_SERVICE]
  ]);
});

test('rejects a concurrent update', async () => {
  const execute = (command, args, callback) => callback(null);

  await assert.rejects(
    startUpdate(execute, { serviceFile }),
    (error) => error.statusCode === 409 && error.message === '更新任务已在运行'
  );
});

test('reports a systemd start failure instead of silently swallowing it', async () => {
  let callCount = 0;
  const execute = (command, args, callback) => {
    callCount += 1;
    callback(new Error(callCount === 1 ? 'inactive' : 'start failed'));
  };

  await assert.rejects(startUpdate(execute, { serviceFile }), /start failed/);
});

test('refuses to report success when the update unit is not installed', async () => {
  const execute = () => {
    throw new Error('systemctl should not be called');
  };

  await assert.rejects(
    startUpdate(execute, { serviceFile: path.join(tmpDir, 'missing.service') }),
    (error) => error.statusCode === 503 && /更新服务未安装/.test(error.message)
  );
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
