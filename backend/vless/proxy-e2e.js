'use strict';

// End-to-end test for the self-hosted VLESS HTTP proxy listener.
//
//   node backend/vless/proxy-e2e.js '<vless://...>'
//
// Starts a VlessHttpProxy on a random local port, then drives it with real HTTP
// clients through both proxy shapes:
//   1. CONNECT  -> https://api.ipify.org (the browser path)
//   2. plain HTTP -> http://api.ipify.org (the path that used to leak)
// It also verifies the client's own IP never appears in the response, which is
// the whole point of tunnelling plain HTTP instead of forwarding it directly.

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const { VlessHttpProxy } = require('./http-proxy');

const LINK = process.argv[2];

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Issues an HTTPS GET through the proxy using CONNECT, exactly like a browser.
function httpsViaConnect(proxyPort, targetUrl, timeoutMs = 20000) {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const connectRequest = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      timeout: timeoutMs
    });
    connectRequest.once('timeout', () => connectRequest.destroy(new Error('CONNECT 超时')));
    connectRequest.once('error', reject);
    connectRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT 返回 HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once('error', reject);
      secure.once('secureConnect', () => {
        // A raw request over the TLS socket. Using https.request with a custom
        // createConnection would re-wrap the already-secure socket.
        secure.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\n`
          + `Host: ${target.host}\r\nConnection: close\r\n\r\n`);
        const chunks = [];
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          secure.destroy();
          reject(new Error('响应超时'));
        }, timeoutMs);
        secure.on('data', (chunk) => chunks.push(chunk));
        secure.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        secure.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
    });
    connectRequest.end();
  });
}

// Issues a plain (origin-form at the client, absolute-form at the proxy) GET.
function httpViaProxy(proxyPort, targetUrl, timeoutMs = 20000) {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,          // absolute form: what a proxy client sends
      headers: { Host: target.host, Connection: 'close' },
      timeout: timeoutMs
    });
    request.once('timeout', () => request.destroy(new Error('请求超时')));
    request.once('error', reject);
    request.once('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.end();
  });
}

function publicIp() {
  return new Promise((resolve) => {
    const request = https.request({ host: 'api.ipify.org', path: '/?format=json', method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const match = Buffer.concat(chunks).toString('utf8').match(/"ip"\s*:\s*"([^"]+)"/);
        resolve(match ? match[1] : null);
      });
    });
    request.once('error', () => resolve(null));
    request.end();
  });
}

async function main() {
  if (!LINK) {
    console.error('用法: node backend/vless/proxy-e2e.js \'<vless://...>\'');
    process.exit(1);
  }

  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: assigned } = server.address();
      server.close(() => resolve(assigned));
    });
  });

  const proxy = new VlessHttpProxy({
    host: '127.0.0.1',
    port,
    uri: LINK,
    logger: (message) => console.log(`        ${message}`)
  });

  console.log(`启动 VLESS HTTP 代理于 127.0.0.1:${port}\n`);
  await proxy.listen();
  check('代理监听启动成功', true);

  const directIp = await publicIp();
  console.log(`        直连出口 IP：${directIp || '未知'}\n`);

  // 1. CONNECT path
  try {
    const body = await httpsViaConnect(port, 'https://api.ipify.org/?format=json');
    const match = body.match(/"ip"\s*:\s*"([^"]+)"/);
    check('CONNECT + TLS 请求成功', Boolean(match), body.slice(0, 80));
    if (match) {
      console.log(`        经代理出口 IP：${match[1]}`);
      check('出口 IP 与直连不同（确实走了隧道）', match[1] !== directIp,
        `直连 ${directIp}，代理 ${match[1]}`);
    }
  } catch (error) {
    check('CONNECT + TLS 请求成功', false, error.message);
  }

  // 2. Plain HTTP path - the one that used to bypass the tunnel
  try {
    const result = await httpViaProxy(port, 'http://api.ipify.org/?format=json');
    const match = result.body.match(/"ip"\s*:\s*"([^"]+)"/);
    check('明文 HTTP 请求成功', result.status === 200 && Boolean(match),
      `HTTP ${result.status} ${result.body.slice(0, 80)}`);
    if (match) {
      console.log(`        明文请求出口 IP：${match[1]}`);
      check('明文 HTTP 也走了隧道（未泄漏真实 IP）', match[1] !== directIp,
        `直连 ${directIp}，明文 ${match[1]}`);
    }
  } catch (error) {
    check('明文 HTTP 请求成功', false, error.message);
  }

  // 3. Non-http scheme over a plain request must be rejected, not forwarded
  try {
    const result = await httpViaProxy(port, 'https://api.ipify.org/');
    check('明文请求拒绝 https:// 目标', result.status === 400, `HTTP ${result.status}`);
  } catch (error) {
    check('明文请求拒绝 https:// 目标', false, error.message);
  }

  console.log(`\n统计：${JSON.stringify(proxy.stats)}`);
  await proxy.close(true);
  check('代理正常关闭', true);

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常：', error.stack || error.message);
  process.exit(1);
});
