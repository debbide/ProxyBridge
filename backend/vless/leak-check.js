'use strict';

// Resource-leak check for the VLESS proxy listener.
//
// Compares active handle counts before and after opening/closing the proxy, and
// cross-checks against a control (a bare net.Server) so that Node's own
// transient handles are never mistaken for a leak. Reports the delta only after
// handles have had time to be reclaimed.

const net = require('node:net');
const { VlessHttpProxy } = require('./http-proxy');

const LINK = process.argv[2];

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe() {
  return process._getActiveHandles().map((handle) => {
    const name = handle.constructor ? handle.constructor.name : 'unknown';
    const detail = name === 'Socket' ? `(fd=${handle.fd})` : '';
    return `${name}${detail}`;
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function main() {
  await settle(300);
  const baseline = process._getActiveHandles().length;
  console.log(`基线活跃句柄：${baseline}  ${JSON.stringify(describe())}`);

  // Control: a bare net.Server, closed the same way.
  const controlPort = await freePort();
  const control = net.createServer();
  await new Promise((resolve) => control.listen(controlPort, '127.0.0.1', resolve));
  const duringControl = process._getActiveHandles().length;
  await new Promise((resolve) => control.close(resolve));
  await settle(500);
  const afterControl = process._getActiveHandles().length;
  console.log(`对照组（net.Server）：监听中 ${duringControl} → 关闭后 ${afterControl}`);

  // Subject: the VLESS proxy.
  const port = await freePort();
  const proxy = new VlessHttpProxy({ host: '127.0.0.1', port, uri: LINK, logger: () => undefined });
  await proxy.listen();
  const duringProxy = process._getActiveHandles().length;
  await proxy.close(true);
  await settle(800);
  const afterProxy = process._getActiveHandles().length;

  console.log(`VLESS 代理：监听中 ${duringProxy} → 关闭后 ${afterProxy}`);
  console.log(`关闭后句柄：${JSON.stringify(describe())}`);

  const controlDelta = afterControl - baseline;
  const proxyDelta = afterProxy - baseline;
  console.log(`\n对照增量 ${controlDelta}，代理增量 ${proxyDelta}`);

  // A leak means the proxy retains handles the control does not.
  const leaked = proxyDelta > controlDelta;
  console.log(leaked
    ? `疑似泄漏 ${proxyDelta - controlDelta} 个句柄`
    : '无泄漏（与对照组一致）');
  process.exit(leaked ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
