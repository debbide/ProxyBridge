'use strict';

// Proves the plain-HTTP leak is closed, and demonstrates the proxy-chain
// behaviour it replaces.
//
//   node backend/vless/leak-proof.js '<vless://...>'
//
// Both listeners are started on the same machine:
//   A. VlessHttpProxy      - tunnels CONNECT *and* plain HTTP
//   B. ProxyChain.Server   - the previous implementation, for comparison
// Each is asked for http://api.ipify.org and the egress IP is compared against
// the machine's real IP.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const ProxyChain = require('proxy-chain');
const { VlessHttpProxy } = require('./http-proxy');

const LINK = process.argv[2];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// The machine's real egress IP. Several services are tried because some are
// unreachable from certain networks (api.ipify.org answers with ECONNRESET on
// the network this was developed against, which is itself why a proxy is needed).
function realIp() {
  const probes = [
    ['api.ipify.org', '/?format=json', /"ip"\s*:\s*"([^"]+)"/],
    ['ifconfig.me', '/ip', /^([0-9a-fA-F:.]+)\s*$/],
    ['icanhazip.com', '/', /^([0-9a-fA-F:.]+)\s*$/]
  ];

  const attempt = (index) => {
    if (index >= probes.length) return Promise.resolve(null);
    const [host, path, pattern] = probes[index];
    return new Promise((resolve) => {
      const req = https.request({ host, path, method: 'GET', timeout: 10000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const match = Buffer.concat(chunks).toString().match(pattern);
          if (match && net.isIP(match[1])) resolve(match[1]);
          else attempt(index + 1).then(resolve);
        });
      });
      req.once('error', () => attempt(index + 1).then(resolve));
      req.once('timeout', () => { req.destroy(); attempt(index + 1).then(resolve); });
      req.end();
    });
  };

  return attempt(0);
}

// Sends a plain HTTP request in absolute form through a proxy.
function plainViaProxy(port, url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: url,
      headers: { Host: new URL(url).host, Connection: 'close' },
      timeout: timeoutMs
    });
    req.once('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: '超时' }); });
    req.once('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.once('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.end();
  });
}

function ipOf(result) {
  const m = result.body && result.body.match(/"ip"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function main() {
  const own = await realIp();
  console.log(`本机真实出口 IP：${own || '未知'}\n`);

  // A. our listener
  const portA = await freePort();
  const ours = new VlessHttpProxy({ host: '127.0.0.1', port: portA, uri: LINK, logger: () => undefined });
  await ours.listen();
  const resA = await plainViaProxy(portA, 'http://api.ipify.org/?format=json');
  const ipA = ipOf(resA);
  await ours.close(true);
  console.log('A. VlessHttpProxy（明文 HTTP）');
  console.log(`   HTTP ${resA.status}${resA.error ? ' ' + resA.error : ''}  出口 IP = ${ipA || '无'}`);
  console.log(`   ${ipA && ipA !== own ? '✓ 走了隧道' : '✗ 泄漏了真实 IP'}\n`);

  // B. previous implementation
  const portB = await freePort();
  const chain = new ProxyChain.Server({
    host: '127.0.0.1', port: portB,
    prepareRequestFunction: () => ({ upstreamProxyUrl: LINK })
  });
  let chainStarted = false;
  try {
    await chain.listen();
    chainStarted = true;
  } catch (error) {
    console.log('B. ProxyChain.Server（旧实现）');
    console.log(`   启动失败：${error.message}\n`);
  }

  let ipB = null;
  if (chainStarted) {
    const resB = await plainViaProxy(portB, 'http://api.ipify.org/?format=json');
    ipB = ipOf(resB);
    console.log('B. ProxyChain.Server（旧实现，明文 HTTP）');
    console.log(`   HTTP ${resB.status}${resB.error ? ' ' + resB.error : ''}  出口 IP = ${ipB || '无'}`);
    console.log(`   ${ipB && ipB !== own ? '走了隧道' : '✗ 未走隧道（旧实现无法承载 vless:// 上游）'}`);
    await chain.close(true).catch(() => undefined);
  }

  console.log('\n结论：');
  console.log(`  旧实现下明文 HTTP 出口 = ${ipB || '未知'}，本机真实 IP = ${own}`);
  console.log(`  新实现下明文 HTTP 出口 = ${ipA || '未知'}，本机真实 IP = ${own}`);
  process.exit(0);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
