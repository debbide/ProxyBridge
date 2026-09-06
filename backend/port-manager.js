const net = require('node:net');
const { request } = require('node:http');
const ProxyChain = require('proxy-chain');

function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function parseProxyUri(value) {
  const normalizedValue = typeof value === 'string'
    ? value.replace(/^socks:\/\//i, 'socks5://')
    : value;
  let parsed;
  try {
    parsed = new URL(normalizedValue);
  } catch (error) {
    throw new Error('代理链接格式无效');
  }

  const protocol = parsed.protocol.slice(0, -1).toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) {
    throw new Error('仅支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H 代理');
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('代理链接必须包含主机和端口');
  }
  return parsed;
}

function sanitizeProxy(proxy) {
  const parsed = parseProxyUri(proxy.uri);
  return {
    id: proxy.id,
    name: proxy.name,
    protocol: parsed.protocol.slice(0, -1),
    local_port: proxy.local_port,
    is_running: Boolean(proxy.is_running)
  };
}

class PortManager {
  constructor({ database, host = '127.0.0.1', portStart = 8001, portEnd = 8999 }) {
    this.database = database;
    this.host = host;
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.servers = new Map();
    this.operations = new Map();
  }

  serialize(id, operation) {
    const previous = this.operations.get(id) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(id, current);
    return current.finally(() => {
      if (this.operations.get(id) === current) {
        this.operations.delete(id);
      }
    });
  }

  async allocatePort() {
    const usedPorts = this.database.getUsedPorts();
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      if (!usedPorts.has(port) && await checkPortAvailable(this.host, port)) {
        return port;
      }
    }
    throw new Error('没有可分配的本地端口');
  }

  async start(proxy) {
    return this.serialize(proxy.id, async () => {
      if (this.servers.has(proxy.id)) {
        return this.database.setRunning(proxy.id, true);
      }
      parseProxyUri(proxy.uri);
      if (!await checkPortAvailable(this.host, proxy.local_port)) {
        throw new Error(`本地端口 ${proxy.local_port} 已被占用`);
      }

      const server = new ProxyChain.Server({
        host: this.host,
        port: proxy.local_port,
        prepareRequestFunction: () => ({ upstreamProxyUrl: proxy.uri })
      });

      try {
        await server.listen();
        this.servers.set(proxy.id, server);
        return this.database.setRunning(proxy.id, true);
      } catch (error) {
        await server.close(true).catch(() => undefined);
        throw error;
      }
    });
  }

  async stop(proxy, { persist = true } = {}) {
    return this.serialize(proxy.id, async () => {
      const server = this.servers.get(proxy.id);
      if (server) {
        await server.close(true);
        this.servers.delete(proxy.id);
      }
      return persist ? this.database.setRunning(proxy.id, false) : proxy;
    });
  }

  async restore() {
    const results = [];
    for (const proxy of this.database.listRunningProxies()) {
      try {
        await this.start(proxy);
        results.push({ id: proxy.id, restored: true });
      } catch (error) {
        this.database.setRunning(proxy.id, false);
        results.push({ id: proxy.id, restored: false, error: error.message });
      }
    }
    return results;
  }

  async closeAll() {
    const running = this.database.listProxies().filter((proxy) => this.servers.has(proxy.id));
    await Promise.allSettled(running.map((proxy) => this.stop(proxy, { persist: false })));
  }

  async testProxy(uri, targetUrl, timeoutMs = 15000) {
    parseProxyUri(uri);
    const port = await this.findTemporaryPort();
    const server = new ProxyChain.Server({
      host: this.host,
      port,
      prepareRequestFunction: () => ({ upstreamProxyUrl: uri })
    });
    const startedAt = Date.now();

    try {
      await server.listen();
      const body = await this.requestThroughLocalProxy(port, targetUrl, timeoutMs);
      let ip = body.trim();
      try {
        const parsed = JSON.parse(body);
        ip = parsed.ip || parsed.origin || ip;
      } catch (error) {
        // Plain-text IP services are supported as well as JSON responses.
      }
      return { ip, latency: Date.now() - startedAt };
    } finally {
      await server.close(true).catch(() => undefined);
    }
  }

  async findTemporaryPort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen({ host: this.host, port: 0 }, () => {
        const address = server.address();
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
  }

  requestThroughLocalProxy(port, targetUrl, timeoutMs) {
    const target = new URL(targetUrl);
    if (target.protocol !== 'http:') {
      throw new Error('当前测速地址必须使用 HTTP 协议');
    }

    return new Promise((resolve, reject) => {
      const req = request({
        host: this.host,
        port,
        method: 'GET',
        path: target.href,
        headers: { Host: target.host }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`测速服务返回 HTTP ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('代理测速超时')));
      req.once('error', reject);
      req.end();
    });
  }
}

module.exports = { PortManager, parseProxyUri, sanitizeProxy, checkPortAvailable };
