'use strict';

// Ad-hoc stress and failover probe for the VLESS dialer.
//
//   node backend/vless/stress.js '<vless://...>' [count]

const tls = require('node:tls');
const { createVlessDialer, CloudflareEdgePool } = require('./index');

const LINK = process.argv[2];
const COUNT = Number(process.argv[3] || 8);
const TARGET = 'api.ipify.org';

if (!LINK) {
  console.error('用法: node backend/vless/stress.js \'<vless://...>\' [count]');
  process.exit(1);
}

async function oneRequest(dialer, index) {
  const startedAt = Date.now();
  let stream;
  try {
    const result = await dialer.dial({ host: TARGET, port: 443 });
    stream = result.stream;
  } catch (error) {
    return { index, ok: false, stage: 'dial', error: error.message, ms: Date.now() - startedAt };
  }

  try {
    const body = await new Promise((resolve) => {
      const socket = tls.connect({ socket: stream, servername: TARGET }, () => {
        socket.write(`GET /?format=json HTTP/1.1\r\nHost: ${TARGET}\r\n`
          + 'User-Agent: curl/8.0\r\nAccept: */*\r\nConnection: close\r\n\r\n');
      });
      const chunks = [];
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 15000);
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); } });
      socket.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
    });
    const match = body && body.match(/"ip"\s*:\s*"([^"]+)"/);
    return {
      index,
      ok: Boolean(match),
      stage: match ? 'done' : 'response',
      ip: match ? match[1] : null,
      ms: Date.now() - startedAt
    };
  } catch (error) {
    return { index, ok: false, stage: 'request', error: error.message, ms: Date.now() - startedAt };
  } finally {
    stream.destroy();
  }
}

async function main() {
  const edgePool = new CloudflareEdgePool({
    host: new URL(LINK).hostname,
    servername: new URL(LINK).searchParams.get('sni') || new URL(LINK).hostname
  });

  const dialer = createVlessDialer({
    link: LINK,
    edgePool,
    logger: () => undefined
  });

  console.log(`并发 ${COUNT} 条隧道，目标 ${TARGET}:443\n`);

  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: COUNT }, (_, index) => oneRequest(dialer, index))
  );
  const elapsed = Date.now() - startedAt;

  for (const result of results) {
    const status = result.ok ? 'OK  ' : 'FAIL';
    const detail = result.ok ? `ip=${result.ip}` : `${result.stage}: ${result.error}`;
    console.log(`  ${status} #${String(result.index).padStart(2)} ${String(result.ms).padStart(5)}ms  ${detail}`);
  }

  const ok = results.filter((result) => result.ok);
  const ips = [...new Set(ok.map((result) => result.ip))];
  const times = ok.map((result) => result.ms).sort((a, b) => a - b);
  const median = times.length > 0 ? times[Math.floor(times.length / 2)] : null;

  console.log(`\n成功 ${ok.length}/${COUNT}，总耗时 ${elapsed}ms，中位延迟 ${median}ms`);
  console.log(`出口 IP：${ips.join(', ') || '无'}`);
  console.log(`边缘统计：${JSON.stringify(dialer.stats)}`);
  console.log(`边缘池快照：${JSON.stringify(edgePool.snapshot())}`);

  process.exit(ok.length === COUNT ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
