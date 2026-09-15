'use strict';

const path = require('node:path');

const PLACEHOLDER_SECRETS = new Set([
  'admin',
  'password',
  'changeme',
  'change-me',
  'secret',
  'development-secret-change-me',
  'replace-with-a-long-random-secret'
]);

const HINTS = {
  ADMIN_PASSWORD: '请在 backend/.env 中设置一个至少 8 位的管理密码（参考 backend/.env.example）。',
  JWT_SECRET: '请在 backend/.env 中设置一个至少 32 位的随机字符串，例如 openssl rand -hex 32。',
  PROXY_ENCRYPTION_KEY: '请在 backend/.env 中设置一个至少 16 位的随机字符串，例如 openssl rand -hex 32；更换该值会导致已保存的代理地址无法解密。'
};

function configurationError(name, reason) {
  const hint = HINTS[name] || '';
  const error = new Error(`配置错误：${name} ${reason}${hint ? ` ${hint}` : ''}`);
  error.code = 'CONFIG_ERROR';
  return error;
}

// Rejects missing, too-short and placeholder secrets so the service never
// starts with the weak fallbacks that used to be baked into server.js.
// Placeholders are checked before length so leaving an example value in place
// reports "still using the sample value" rather than a confusing length error.
function resolveSecret(name, value, minLength) {
  const resolved = typeof value === 'string' ? value.trim() : '';
  if (!resolved) throw configurationError(name, '未设置。');
  if (PLACEHOLDER_SECRETS.has(resolved.toLowerCase())) {
    throw configurationError(name, '仍在使用示例占位值。');
  }
  if (resolved.length < minLength) throw configurationError(name, `至少需要 ${minLength} 个字符。`);
  return resolved;
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return value === '1' || String(value).toLowerCase() === 'true';
}

function loadRuntimeConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: toInteger(env.PORT, 3000),
    databasePath: env.DATABASE_PATH || path.join(__dirname, 'data', 'data.db'),
    jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',
    localProxyHost: env.LOCAL_PROXY_HOST || '127.0.0.1',
    localPortStart: toInteger(env.LOCAL_PORT_START, 8001),
    localPortEnd: toInteger(env.LOCAL_PORT_END, 8999),
    ipCheckUrl: env.IP_CHECK_URL || 'https://api.ipify.org?format=json',
    proxyTestTimeoutMs: toInteger(env.PROXY_TEST_TIMEOUT_MS, 15000),
    trustProxy: toBoolean(env.TRUST_PROXY),
    versionCacheTtlMs: toInteger(env.VERSION_CACHE_TTL_MS, 60000),
    loginMaxAttempts: toInteger(env.LOGIN_MAX_ATTEMPTS, 5),
    loginWindowMs: toInteger(env.LOGIN_WINDOW_MS, 300000),
    loginBlockMs: toInteger(env.LOGIN_BLOCK_MS, 900000)
  };
}

module.exports = { resolveSecret, loadRuntimeConfig, PLACEHOLDER_SECRETS };
