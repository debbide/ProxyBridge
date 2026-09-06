require('dotenv').config();

const path = require('node:path');
const express = require('express');
const { ProxyDatabase } = require('./database');
const { createAuth } = require('./auth');
const { PortManager, parseProxyUri, sanitizeProxy } = require('./port-manager');
const { createProxyCrypto } = require('./proxy-crypto');
const { checkVersion } = require('./version-checker');
const { startUpdate } = require('./updater');

function parseProxyInput(input, fallbackName = '') {
  const value = typeof input === 'string' ? input.trim() : '';
  const match = value.match(/(?:^|\s)((?:https?|socks|socks5|socks5h):\/\/\S+)/i);
  if (!match) {
    throw new Error('请输入包含 http、https、socks、socks5 或 socks5h 协议的代理地址');
  }

  const uri = match[1].replace(/^socks:\/\//i, 'socks5://');
  parseProxyUri(uri);
  const suppliedName = value.replace(match[0], ' ').trim() || fallbackName.trim();
  const generatedName = `节点-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const name = suppliedName || generatedName;
  if (name.length > 80) {
    throw new Error('节点名称不能超过 80 个字符');
  }
  return { name, uri };
}

function createApplication(options = {}) {
  const getVersion = options.checkVersion || checkVersion;
  const beginUpdate = options.startUpdate || startUpdate;
  const proxyCrypto = options.proxyCrypto || createProxyCrypto(
    process.env.PROXY_ENCRYPTION_KEY || process.env.JWT_SECRET || 'development-secret-change-me'
  );
  const database = options.database || new ProxyDatabase(
    options.databasePath || process.env.DATABASE_PATH || path.join(__dirname, 'data', 'data.db'),
    proxyCrypto
  );
  const portManager = options.portManager || new PortManager({
    database,
    host: process.env.LOCAL_PROXY_HOST || '127.0.0.1',
    portStart: Number(process.env.LOCAL_PORT_START || 8001),
    portEnd: Number(process.env.LOCAL_PORT_END || 8999)
  });
  const auth = createAuth({
    adminPassword: options.adminPassword || process.env.ADMIN_PASSWORD || 'admin',
    jwtSecret: options.jwtSecret || process.env.JWT_SECRET || 'development-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h'
  });
  const app = express();

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
        return res.status(503).json({ error: '暂时无法检查最新版本' });
      }
      if (!version.updateAvailable) {
        return res.json({ status: 'current', currentVersion: version.currentVersion });
      }
      await beginUpdate();
      return res.status(202).json({ status: 'started', targetVersion: version.latestVersion });
    } catch (error) {
      if (error.statusCode === 409) {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  api.post('/proxies', async (req, res, next) => {
    try {
      const legacyUri = typeof req.body?.uri === 'string' ? req.body.uri.trim() : '';
      const input = typeof req.body?.input === 'string' ? req.body.input : legacyUri;
      const fallbackName = typeof req.body?.name === 'string' ? req.body.name : '';
      const { name, uri } = parseProxyInput(input, fallbackName);
      const localPort = await portManager.allocatePort();
      const proxy = database.createProxy({ name, uri, localPort });
      return res.status(201).json(sanitizeProxy(proxy));
    } catch (error) {
      return next(error);
    }
  });

  api.patch('/proxies/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!database.getProxy(id)) {
        return res.status(404).json({ error: '代理不存在' });
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        return res.status(400).json({ error: '节点名称不能为空' });
      }
      if (name.length > 80) {
        return res.status(400).json({ error: '节点名称不能超过 80 个字符' });
      }
      return res.json(sanitizeProxy(database.updateName(id, name)));
    } catch (error) {
      return next(error);
    }
  });

  api.delete('/proxies/:id', async (req, res, next) => {
    try {
      const proxy = database.getProxy(Number(req.params.id));
      if (!proxy) {
        return res.status(404).json({ error: '代理不存在' });
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
      const proxy = database.getProxy(Number(req.body?.id));
      if (!proxy) {
        return res.status(404).json({ error: '代理不存在' });
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
      const proxy = req.body?.id ? database.getProxy(Number(req.body.id)) : null;
      const uri = proxy?.uri || (typeof req.body?.uri === 'string' ? req.body.uri.trim() : '');
      if (!uri) {
        return res.status(400).json({ error: '必须提供代理 id 或 uri' });
      }
      const result = await portManager.testProxy(
        uri,
        process.env.IP_CHECK_URL || 'https://api.ipify.org?format=json',
        Number(process.env.PROXY_TEST_TIMEOUT_MS || 15000)
      );
      return res.json(result);
    } catch (error) {
      return next(error);
    }
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
    return res.status(400).json({ error: error.message || '请求处理失败' });
  });

  return { app, database, portManager };
}

async function startServer() {
  const runtime = createApplication();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
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

module.exports = { createApplication, startServer };
