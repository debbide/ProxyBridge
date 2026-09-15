'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveSecret, loadRuntimeConfig, PLACEHOLDER_SECRETS } = require('./config');

test('accepts a strong secret', () => {
  assert.equal(resolveSecret('JWT_SECRET', 'a'.repeat(32), 32), 'a'.repeat(32));
});

test('rejects a missing secret', () => {
  assert.throws(() => resolveSecret('ADMIN_PASSWORD', '', 8), /配置错误：ADMIN_PASSWORD 未设置/);
  assert.throws(() => resolveSecret('ADMIN_PASSWORD', undefined, 8), /配置错误/);
});

test('rejects a too-short secret', () => {
  assert.throws(() => resolveSecret('ADMIN_PASSWORD', 'short', 8), /至少需要 8 个字符/);
  assert.throws(() => resolveSecret('JWT_SECRET', 'x'.repeat(31), 32), /至少需要 32 个字符/);
});

test('rejects every documented placeholder secret', () => {
  for (const placeholder of PLACEHOLDER_SECRETS) {
    // Short placeholders are caught by the length check, long ones by the
    // placeholder check; either way none of them may be accepted.
    assert.throws(
      () => resolveSecret('ADMIN_PASSWORD', placeholder, 8),
      /占位值|至少需要/,
      `expected "${placeholder}" to be rejected`
    );
  }
});

test('rejects placeholders that are long enough to pass the length check', () => {
  assert.throws(() => resolveSecret('JWT_SECRET', 'development-secret-change-me', 32), /占位值/);
  assert.throws(() => resolveSecret('JWT_SECRET', 'replace-with-a-long-random-secret', 32), /占位值/);
  assert.throws(() => resolveSecret('ADMIN_PASSWORD', '  change-me  ', 8), /占位值/);
});

test('never falls back to the old insecure defaults', () => {
  assert.throws(() => resolveSecret('ADMIN_PASSWORD', 'admin', 8));
  assert.throws(() => resolveSecret('JWT_SECRET', 'development-secret-change-me', 32));
});

test('loads runtime defaults without inventing secrets', () => {
  const config = loadRuntimeConfig({});

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.localPortStart, 8001);
  assert.equal(config.localPortEnd, 8999);
  assert.equal(config.loginMaxAttempts, 5);
  assert.equal(config.versionCacheTtlMs, 60000);
  assert.equal(Object.hasOwn(config, 'adminPassword'), false);
  assert.equal(Object.hasOwn(config, 'jwtSecret'), false);
});

test('parses overrides from the environment', () => {
  const config = loadRuntimeConfig({
    HOST: '0.0.0.0',
    PORT: '8080',
    TRUST_PROXY: 'true',
    LOGIN_MAX_ATTEMPTS: '3',
    LOCAL_PORT_START: '9000'
  });

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.equal(config.trustProxy, true);
  assert.equal(config.loginMaxAttempts, 3);
  assert.equal(config.localPortStart, 9000);
});
