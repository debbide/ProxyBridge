'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createVersionChecker } = require('./version-checker');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('caches results within the TTL so panel polling cannot spam GitHub', async () => {
  let calls = 0;
  const check = async () => {
    calls += 1;
    return { status: 'ok', latestVersion: '1.0.0' };
  };
  const checkVersion = createVersionChecker({ ttlMs: 60000, check });

  await checkVersion();
  await checkVersion();
  await checkVersion();

  assert.equal(calls, 1);
});

test('refreshes once the TTL has elapsed', async () => {
  let calls = 0;
  const check = async () => {
    calls += 1;
    return { status: 'ok' };
  };
  const checkVersion = createVersionChecker({ ttlMs: 0, check });

  await checkVersion();
  await checkVersion();

  assert.equal(calls, 2);
});

test('collapses concurrent callers into a single request', async () => {
  let calls = 0;
  const gate = deferred();
  const check = async () => {
    calls += 1;
    await gate.promise;
    return { status: 'ok' };
  };
  const checkVersion = createVersionChecker({ ttlMs: 60000, check });

  const all = Promise.all([checkVersion(), checkVersion(), checkVersion()]);
  gate.resolve();
  const results = await all;

  assert.equal(calls, 1);
  assert.equal(results.length, 3);
  assert.equal(results[0], results[1]);
});

test('does not cache a failed lookup forever', async () => {
  let calls = 0;
  const check = async () => {
    calls += 1;
    return { status: 'error' };
  };
  const checkVersion = createVersionChecker({ ttlMs: 0, check });

  assert.equal((await checkVersion()).status, 'error');
  assert.equal((await checkVersion()).status, 'error');
  assert.equal(calls, 2);
});
