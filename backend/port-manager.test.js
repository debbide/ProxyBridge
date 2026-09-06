const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { PortManager, createTunnelAgent } = require('./port-manager');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('binds the HTTPS request to the established proxy tunnel socket', () => {
  const secureSocket = {};
  const agent = createTunnelAgent(secureSocket);

  assert.equal(agent.createConnection(), secureSocket);
  agent.destroy();
});

test('requires an HTTPS target for proxy testing', async () => {
  const manager = new PortManager({ database: {} });

  assert.throws(
    () => manager.requestThroughLocalProxy(8001, 'http://api.ipify.org?format=json', 1000),
    /必须使用 HTTPS 协议/
  );
});

test('rejects a failed CONNECT tunnel instead of reporting latency', async () => {
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 599 Upstream Connection Failed\r\nContent-Length: 0\r\n\r\n');
  });
  const port = await listen(proxy);
  const manager = new PortManager({ database: {} });

  try {
    await assert.rejects(
      manager.requestThroughLocalProxy(port, 'https://ifconfig.me/', 1000),
      /代理 CONNECT 失败，HTTP 599/
    );
  } finally {
    await close(proxy);
  }
});

test('rejects a successful request whose response is not an IP address', async () => {
  const manager = new PortManager({ database: {} });
  manager.findTemporaryPort = async () => 0;
  manager.requestThroughLocalProxy = async () => '<html>not an IP</html>';

  const originalListen = require('proxy-chain').Server.prototype.listen;
  const originalClose = require('proxy-chain').Server.prototype.close;
  require('proxy-chain').Server.prototype.listen = async () => undefined;
  require('proxy-chain').Server.prototype.close = async () => undefined;

  try {
    await assert.rejects(
      manager.testProxy('socks5://[2001:db8::1]:1080', 'https://api.ipify.org?format=json', 1000),
      /未返回有效 IP 地址/
    );
  } finally {
    require('proxy-chain').Server.prototype.listen = originalListen;
    require('proxy-chain').Server.prototype.close = originalClose;
  }
});

test('accepts a valid IPv6 response after HTTPS proxy validation', async () => {
  const manager = new PortManager({ database: {} });
  manager.findTemporaryPort = async () => 0;
  manager.requestThroughLocalProxy = async () => JSON.stringify({ ip: '2001:db8::25' });

  const originalListen = require('proxy-chain').Server.prototype.listen;
  const originalClose = require('proxy-chain').Server.prototype.close;
  require('proxy-chain').Server.prototype.listen = async () => undefined;
  require('proxy-chain').Server.prototype.close = async () => undefined;

  try {
    const result = await manager.testProxy(
      'socks5://[2001:db8::1]:1080',
      'https://api.ipify.org?format=json',
      1000
    );
    assert.equal(result.ip, '2001:db8::25');
    assert.equal(Number.isInteger(result.latency), true);
  } finally {
    require('proxy-chain').Server.prototype.listen = originalListen;
    require('proxy-chain').Server.prototype.close = originalClose;
  }
});
