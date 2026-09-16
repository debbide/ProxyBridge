'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');
const { ProxyDatabase } = require('./database');
const { createAuth } = require('./auth');
const {
  PortManager,
  parseProxyUri,
  sanitizeProxy,
  normalizeNodeName
} = require('./port-manager');
const { parseVlessLink, isVlessLink } = require('./vless/link');
const { createProxyCrypto } = require('./proxy-crypto');
const { createVersionChecker } = require('./version-checker');
const { startUpdate } = require('./updater');
const { resolveSecret, loadRuntimeConfig } = require('./config');
const { badRequest, notFound, serviceUnavailable } = require('./http-error');

// Our own validation helpers throw plain Errors with client-facing Chinese
// messages; this tags them as safe 400s without changing their behaviour for
// direct callers (and tests) that use them outside HTTP.
function validate(run) {
  try {
    return run();
  } catch (error) {
    if (error.statusCode) throw error;
    throw badRequest(error.message);
  }
}

function parseProxyInput(input, fallbackName = '') {
  const value = typeof input === 'string' ? input.trim() : '';
  const match = value.match(/(?:^|\s)((?:https?|socks|socks5|socks5h|vless):\/\/\S+)/i);
  if (!match) {
    throw new Error('请输入包含 http、https、socks、socks5、socks5h 或 vless 协议的代理地址');
  }

  const uri = match[1].replace(/^socks:\/\//i, 'socks5://');
  parseProxyUri(uri);
  // A vless:// link carries its own `#name` fragment, which is a better default
  // than a random one; an explicitly typed name still wins.
  const suppliedName = value.replace(match[0], ' ').trim() || String(fallbackName || '').trim();
  const generatedName = isVlessLink(uri)
    ? (parseVlessLink(uri).name || `节点-${Math.random().toString(36).slice(2, 7).toUpperCase()}`)
    : `节点-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  return { name: normalizeNodeName(suppliedName || generatedName), uri };
}

function parseProxyId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function createApplication(options = {}) {
  const env = options.env || process.env;
  const config = { ...loadRuntimeConfig(env), ...(options.config || {}) };
  if (options.databasePath) {
    config.databasePath = options.databasePath;
  }
  const getVersion = options.checkVersion || createVersionChecker({ ttlMs: config.versionCacheTtlMs });
  const beginUpdate = options.startUpdate || startUpdate;

  // Secrets are resolved eagerly so a missing or placeholder value fails the
  // boot loudly instead of silently falling back to a known default. Injected
  // values are validated too, so an embedding caller cannot bypass the checks.
  const adminPassword = resolveSecret('ADMIN_PASSWORD', options.adminPassword ?? env.ADMIN_PASSWORD, 8);
  const jwtSecret = resolveSecret('JWT_SECRET', options.jwtSecret ?? env.JWT_SECRET, 32);
  const encryptionKey = resolveSecret('PROXY_ENCRYPTION_KEY', options.proxyEncryptionKey ?? env.PROXY_ENCRYPTION_KEY, 16);

  const proxyCrypto = options.proxyCrypto || createProxyCrypto(encryptionKey);
  const database = options.database || new ProxyDatabase(config.databasePath, proxyCrypto);
  // Fails loudly when the key no longer matches stored data, rather than
  // letting every later request fail with an opaque crypto error.
  database.verifyEncryptionKey();

  const portManager = options.portManager || new PortManager({
    database,
    host: config.localProxyHost,
    portStart: config.localPortStart,
    portEnd: config.localPortEnd
  });
  const auth = createAuth({
    adminPassword,
    jwtSecret,
    expiresIn: config.jwtExpiresIn,
    maxAttempts: config.loginMaxAttempts,
    windowMs: config.loginWindowMs,
    blockMs: config.loginBlockMs
  });
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '32kb' }));
  app.post('/api/login', auth.login);

  const api = express.Router();
  api.use(auth.requireAuth);

  api.get('/proxies', (req, res) => {
    res.json(database.listProxies().map(sanitizeProxy));
  });

  api.get('/version', async (req, res) => {
    res.json(await getVersion());
  });

  api.post('/update', async (req, res, next) => {
    try {
      const version = await getVersion();
      if (version.status !== 'ok') {
        throw serviceUnavailable('暂时无法检查最新版本');
      }
      if (!version.updateAvailable) {
        return res.json({ status: 'current', currentVersion: version.currentVersion });
      }
      await beginUpdate();
      return res.status(202).json({ status: 'started', targetVersion: version.latestVersion });
    } catch (error) {
      return next(error);
    }
  });

  api.post('/proxies', async (req, res, next) => {
    try {
      const legacyUri = typeof req.body?.uri === 'string' ? req.body.uri.trim() : '';
      const input = typeof req.body?.input === 'string' ? req.body.input : legacyUri;
      const fallbackName = typeof req.body?.name === 'string' ? req.body.name : '';
      const { name, uri } = validate(() => parseProxyInput(input, fallbackName));
      // reservePort writes the row itself, so the UNIQUE constraint arbitrates
      // concurrent allocations instead of a check-then-insert race.
      const proxy = await portManager.reservePort({ name, uri });
      if (!proxy) {
        throw serviceUnavailable('没有可分配的本地端口');
      }
      return res.status(201).json(sanitizeProxy(proxy));
    } catch (error) {
      return next(error);
    }
  });

  api.patch('/proxies/:id', (req, res, next) => {
    try {
      const id = parseProxyId(req.params.id);
      const proxy = id ? database.getProxy(id) : null;
      if (!proxy) {
        throw notFound('代理不存在');
      }
      const name = validate(() => normalizeNodeName(req.body?.name));
      return res.json(sanitizeProxy(database.updateName(id, name)));
    } catch (error) {
      return next(error);
    }
  });

  api.delete('/proxies/:id', async (req, res, next) => {
    try {
      const id = parseProxyId(req.params.id);
      const proxy = id ? database.getProxy(id) : null;
      if (!proxy) {
        throw notFound('代理不存在');
      }
      if (proxy.is_running || portManager.servers.has(proxy.id)) {
        await portManager.stop(proxy);
      }
      database.deleteProxy(proxy.id);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  api.post('/toggle-port', async (req, res, next) => {
    try {
      const id = parseProxyId(req.body?.id);
      const proxy = id ? database.getProxy(id) : null;
      if (!proxy) {
        throw notFound('代理不存在');
      }
      const updated = proxy.is_running
        ? await portManager.stop(proxy)
        : await portManager.start(proxy);
      return res.json(sanitizeProxy(updated));
    } catch (error) {
      return next(error);
    }
  });

  api.post('/test-proxy', async (req, res, next) => {
    try {
      const id = parseProxyId(req.body?.id);
      const proxy = id ? database.getProxy(id) : null;
      const uri = proxy?.uri || (typeof req.body?.uri === 'string' ? req.body.uri.trim() : '');
      if (!uri) {
        throw badRequest('必须提供代理 id 或 uri');
      }
      const result = await portManager.testProxy(uri, config.ipCheckUrl, config.proxyTestTimeoutMs);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  // Unknown API routes must 404 as JSON. Without this the SPA catch-all below
  // would answer with index.html and a 200, hiding client-side mistakes.
  api.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.get('*', (req, res, next) => {
    const indexPath = path.join(__dirname, '..', 'frontend', 'index.html');
    res.sendFile(indexPath, (error) => error ? next() : undefined);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400
      ? error.statusCode
      : 500;
    // express.json() rejections carry a status but expose parser internals, so
    // they are reported with a short message of our own instead.
    const isBodyParserError = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
    const safeMessage = !isBodyParserError
      && (error.safeMessage === true || (statusCode < 500 && error.safeMessage !== false));
    if (statusCode >= 500 && !safeMessage) {
      console.error('Request failed:', error);
    }
    const message = safeMessage
      ? (error.message || '请求处理失败')
      : (statusCode >= 500 ? '服务器内部错误' : '请求内容无效');
    return res.status(statusCode).json({ error: message });
  });

  return { app, database, portManager, config };
}

async function startServer() {
  const runtime = createApplication();
  const { host, port } = runtime.config;
  const restored = await runtime.portManager.restore();
  for (const result of restored.filter((item) => !item.restored)) {
    console.error(`Failed to restore proxy ${result.id}: ${result.error}`);
  }

  const server = runtime.app.listen(port, host, () => {
    console.log(`Proxy Manager listening at http://${host}:${port}`);
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.portManager.closeAll();
    server.close(() => {
      runtime.database.close();
      process.exit(0);
    });
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...runtime, server, shutdown };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { createApplication, startServer, parseProxyInput, parseProxyId };
