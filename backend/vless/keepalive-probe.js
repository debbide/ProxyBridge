'use strict';

// Keepalive probe: keeps a tunnel idle across Cloudflare's ~100s idle window
// and checks it still works. The request must use `Connection: keep-alive`,
// otherwise the origin closes after the first response and the tunnel dies for
// reasons unrelated to keepalive.
//
//   node backend/vless/keepalive-test.js '<vless://...>' [idleMs] [pingMs]
//
// Pass pingMs = 0 to disable keepalive and observe the idle timeout.

const tls = require('node:tls');
const { createVlessDialer } = require('./index');

const LINK = process.argv[2];
const IDLE_MS = Number(process.argv[3] || 25000);
const PING_MS = Number(process.argv[4] ?? 5000);
const TARGET = 'api.ipify.org';

// Reads one Content-Length framed response so the socket can stay open.
function readResponse(socket, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffered.subarray(0, end).toString('latin1');
      const match = head.match(/content-length:\s*(\d+)/i);
      if (!match) { finish(buffered.toString('utf8')); return; }
      const bodyStart = end + 4;
      if (buffered.length >= bodyStart + Number(match[1])) {
        finish(buffered.subarray(0, bodyStart + Number(match[1])).toString('utf8'));
      }
    };
    const onError = () => finish(null);
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

// Issues one request over the established socket and reads its response.
function request(socket, host, connectionHeader) {
  socket.write(`GET /?format=json HTTP/1.1\r\nHost: ${host}\r\n`
    + `User-Agent: curl/8.0\r\nAccept: */*\r\nConnection: ${connectionHeader}\r\n\r\n`);
  return readResponse(socket);
}

async function main() {
  const dialer = createVlessDialer({ link: LINK, keepAliveMs: PING_MS, logger: () => undefined });
  const result = await dialer.dial({ host: TARGET, port: 443 });
  const startedAt = Date.now();

  let closedAt = null;
  result.stream.connection.on('close', () => { if (closedAt === null) closedAt = Date.now(); });
  result.stream.connection.on('error', () => { if (closedAt === null) closedAt = Date.now(); });

  const socket = tls.connect({ socket: result.stream, servername: TARGET });
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  const first = await request(socket, TARGET, 'keep-alive');
  const firstIp = first && first.match(/"ip"\s*:\s*"([^"]+)"/);
  console.log(`隧道建立，边缘 = ${result.address}`);
  console.log(`第 1 次请求：${firstIp ? 'IP=' + firstIp[1] : '无响应'}`);
  console.log(PING_MS > 0
    ? `空闲 ${IDLE_MS / 1000}s（每 ${PING_MS / 1000}s 发一次 WS ping）...`
    : `空闲 ${IDLE_MS / 1000}s（保活已关闭）...`);

  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  const alive = closedAt === null;
  console.log(alive
    ? '空闲结束：隧道仍然存活'
    : `空闲结束：隧道已于 ${((closedAt - startedAt) / 1000).toFixed(1)}s 被关闭`);

  if (!alive) {
    console.log('结论：空闲期间连接被关闭');
    socket.destroy();
    result.stream.destroy();
    process.exit(1);
  }

  const second = await request(socket, TARGET, 'close');
  const secondIp = second && second.match(/"ip"\s*:\s*"([^"]+)"/);
  console.log(secondIp
    ? `保活有效：空闲后仍可通信，出口 IP = ${secondIp[1]}`
    : '保活失败：空闲后连接失效');

  socket.destroy();
  result.stream.destroy();
  process.exit(secondIp ? 0 : 1);
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});

