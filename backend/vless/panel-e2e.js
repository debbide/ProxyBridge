'use strict';

// Full-stack test: drives the real PortManager + database path that the panel
// uses, with a vless:// node, then verifies traffic actually tunnels.
//
//   node backend/vless/panel-e2e.js '<vless://...>'

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ProxyDatabase } = require('../database');
const { PortManager, sanitizeProxy, parseProxyUri } = require('../port-manager');
const { createProxyCrypto } = require('../proxy-crypto');
const { parseProxyInput } = require('../server');

const LINK = process.argv[2];

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function httpsViaConnect(proxyPort, targetUrl, timeoutMs = 25000) {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const connectRequest = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      timeout: timeoutMs
    });
    connectRequest.once('timeout', () => connectRequest.destroy(new Error('CONNECT 超时')));
    connectRequest.once('error', reject);
    connectRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once('error', reject);
      secure.once('secureConnect', () => {
        secure.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\n`
          + `Host: ${target.host}\r\nConnection: close\r\n\r\n`);
        const chunks = [];
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; secure.destroy(); reject(new Error('超时')); } }, timeoutMs);
        secure.on('data', (c) => chunks.push(c));
        secure.on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); } });
        secure.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      });
    });
    connectRequest.end();
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-vless-'));
  const dbPath = path.join(dir, 'data.db');
  const crypto = createProxyCrypto('test-key-for-panel-e2e-0123456789');
  const database = new ProxyDatabase(dbPath, crypto);
  const portManager = new PortManager({ database, host: '127.0.0.1', portStart: 18001, portEnd: 18100 });

  try {
    // 1. Input parsing accepts a vless link pasted with a name
    const expectedName = decodeURIComponent(LINK.split('#')[1] || '');
    const parsed = parseProxyInput(`${LINK}`, '');
    check('parseProxyInput 接受 vless:// 链接', parsed.uri.startsWith('vless://'));
    check('名称取自链接的 #fragment', parsed.name === expectedName,
      `${parsed.name}（期望 ${expectedName}）`);

    const explicit = parseProxyInput(`${LINK} 我的节点`, '');
    check('显式名称优先于 fragment', explicit.name === '我的节点', explicit.name);

    // 2. parseProxyUri / sanitizeProxy report protocol `vless`
    const uri = parseProxyUri(parsed.uri);
    check('parseProxyUri 接受 vless://', uri.protocol === 'vless:');

    const proxy = await portManager.reservePort({ name: parsed.name, uri: parsed.uri });
    check('端口分配成功', Boolean(proxy), '未分配到端口');
    if (!proxy) throw new Error('无法继续');

    const sanitized = sanitizeProxy(proxy);
    check('面板展示 protocol=vless', sanitized.protocol === 'vless', JSON.stringify(sanitized));

    // 3. start() spins up the VLESS listener
    // The raw DB row stores is_running as 0/1; sanitizeProxy is the panel-facing
    // contract that converts it to a boolean.
    const started = await portManager.start(proxy);
    check('start() 启动成功', sanitizeProxy(started).is_running === true,
      JSON.stringify(sanitizeProxy(started)));
    check('服务器已登记', portManager.servers.has(proxy.id));

    // 4. Traffic through the real managed port
    try {
      const body = await httpsViaConnect(proxy.local_port, 'https://api.ipify.org/?format=json');
      const match = body.match(/"ip"\s*:\s*"([^"]+)"/);
      check('经托管端口 CONNECT 成功', Boolean(match), body.slice(0, 60));
      if (match) console.log(`        出口 IP：${match[1]}`);
    } catch (error) {
      check('经托管端口 CONNECT 成功', false, error.message);
    }

    // 5. testProxy works for vless nodes
    try {
      const result = await portManager.testProxy(parsed.uri, 'https://api.ipify.org?format=json', 25000);
      check('testProxy 支持 vless', Boolean(result.ip), JSON.stringify(result));
      if (result.ip) console.log(`        测速结果：${result.ip} / ${result.latency}ms`);
    } catch (error) {
      check('testProxy 支持 vless', false, error.message);
    }

    // 6. stop() tears it down
    const stopped = await portManager.stop(proxy);
    check('stop() 停止成功', sanitizeProxy(stopped).is_running === false,
      JSON.stringify(sanitizeProxy(stopped)));
    check('服务器已移除', !portManager.servers.has(proxy.id));

    // 7. Restart persistence
    const restored = await portManager.restore();
    check('restore 不因已停止节点报错', Array.isArray(restored));
  } finally {
    await portManager.closeAll();
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常：', error.stack || error.message);
  process.exit(1);
});
