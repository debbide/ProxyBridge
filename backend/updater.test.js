const assert = require('node:assert/strict');
const test = require('node:test');

const { startUpdate } = require('./updater');

test('starts the fixed systemd update service when inactive', async () => {
  const calls = [];
  const execute = (command, args, callback) => {
    calls.push([command, ...args]);
    callback(calls.length === 1 ? new Error('inactive') : null);
  };

  await startUpdate(execute);

  assert.deepEqual(calls, [
    ['systemctl', 'is-active', '--quiet', 'proxybridge-update.service'],
    ['systemctl', 'start', '--no-block', 'proxybridge-update.service']
  ]);
});

test('rejects a concurrent update', async () => {
  const execute = (command, args, callback) => callback(null);

  await assert.rejects(
    startUpdate(execute),
    (error) => error.statusCode === 409 && error.message === '更新任务已在运行'
  );
});

test('reports a systemd start failure', async () => {
  let callCount = 0;
  const execute = (command, args, callback) => {
    callCount += 1;
    callback(new Error(callCount === 1 ? 'inactive' : 'start failed'));
  };

  await assert.rejects(startUpdate(execute), /start failed/);
});
