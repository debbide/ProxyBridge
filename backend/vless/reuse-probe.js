'use strict';

// Verifies that plain HTTP requests reuse tunnels instead of dialing per
// request. Connection reuse is exactly what the proxy-chain SOCKS path lacked,
// and it is the main reason peak-hour traffic was unstable.
//
//   node backend/vless/reuse-test.js '<vless://...>'

const http = require('node:http');
const net = require('node:net');
const { VlessHttpProxy } = require('./http-proxy');

const LINK = process.argv[2];
const ROUNDS = Number(process.argv[3] || 6);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function get(agent, port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: url,
      headers: { Host: new URL(url).host }, agent
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.once('error', reject);
    req.end();
  });
}

async function main() {
  const port = await freePort();
  const proxy = new VlessHttpProxy({ host: '127.0.0.1', port, uri: LINK, logger: () => undefined });
  await proxy.listen();

  // A single agent with keepAlive: requests must share its pooled socket.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  console.log(`发送 ${ROUNDS} 次明文 HTTP 请求（复用同一连接）...\n`);
  const startedAt = Date.now();
  let ok = 0;
  for (let index = 0; index < ROUNDS; index += 1) {
    const began = Date.now();
    try {
      const body = await get(agent, port, 'http://api.ipify.org/?format=json');
      const match = body.match(/"ip"\s*:\s*"([^"]+)"/);
      if (match) {
        ok += 1;
        console.log(`  #${index + 1}  ${String(Date.now() - began).padStart(5)}ms  IP=${match[1]}`);
      } else {
        console.log(`  #${index + 1}  ${String(Date.now() - began).padStart(5)}ms  无 IP：${body.slice(0, 60)}`);
      }
    } catch (error) {
      console.log(`  #${index + 1}  ${String(Date.now() - began).padStart(5)}ms  失败：${error.message}`);
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(`\n成功 ${ok}/${ROUNDS}，总耗时 ${elapsed}ms，平均 ${Math.round(elapsed / ROUNDS)}ms/次`);
  console.log(`隧道统计：${JSON.stringify(proxy.stats)}`);
  console.log(`拨号器统计：${JSON.stringify(proxy.dialer.stats)}`);

  const dials = proxy.dialer.stats.attempts;
  console.log('');
  if (ok === ROUNDS && dials < ROUNDS) {
    console.log(`复用生效：${ROUNDS} 次请求只拨号 ${dials} 次`);
  } else if (ok === ROUNDS && dials === ROUNDS) {
    console.log(`复用未生效：${ROUNDS} 次请求拨号 ${dials} 次（每请求一条隧道）`);
  } else {
    console.log(`结果异常：成功 ${ok}/${ROUNDS}，拨号 ${dials} 次`);
  }

  agent.destroy();
  await proxy.close(true);
  process.exit(ok === ROUNDS ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常：', error.stack || error.message);
  process.exit(1);
});
