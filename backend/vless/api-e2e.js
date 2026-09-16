'use strict';

// Boots the real Express application and drives it over HTTP exactly as the
// panel does: login, add a vless node, start it, use it, test it, stop it.
//
//   node backend/vless/api-e2e.js '<vless://...>'

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');

const { createApplication } = require('../server');

const LINK = process.argv[2];
const PASSWORD = 'panel-test-password';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function apiRequest(port, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Uses the node's managed port the way a browser would.
function useProxy(proxyPort, targetUrl, timeoutMs = 25000) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-api-e2e-'));
  const port = await freePort();

  const runtime = createApplication({
    env: {},
    config: { host: '127.0.0.1', port, localProxyHost: '127.0.0.1', localPortStart: 19001, localPortEnd: 19100 },
    databasePath: path.join(dir, 'data.db'),
    adminPassword: PASSWORD,
    jwtSecret: 'j'.repeat(40),
    proxyEncryptionKey: 'k'.repeat(40)
  });

  const server = runtime.app.listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  console.log(`面板 API 监听于 127.0.0.1:${port}\n`);

  try {
    // login
    const login = await apiRequest(port, 'POST', '/api/login', { body: { password: PASSWORD } });
    check('登录成功', login.status === 200 && Boolean(login.json?.token), JSON.stringify(login.json));
    const token = login.json?.token;

    // add a vless node
    const created = await apiRequest(port, 'POST', '/api/proxies', { token, body: { input: LINK } });
    check('添加 vless 节点成功', created.status === 201, JSON.stringify(created.json));
    const node = created.json;
    check('面板显示 protocol=vless', node?.protocol === 'vless', JSON.stringify(node));
    // The link is supplied on the command line, so the expected name is its
    // decoded `#fragment` rather than a hardcoded value.
    const expectedName = decodeURIComponent(LINK.split('#')[1] || '');
    check('节点名称取自链接', node?.name === expectedName, `${node?.name}（期望 ${expectedName}）`);
    console.log(`        分配端口：${node?.local_port}`);

    // list
    const list = await apiRequest(port, 'GET', '/api/proxies', { token });
    check('节点出现在列表中', Array.isArray(list.json) && list.json.length === 1);

    // start
    const started = await apiRequest(port, 'POST', '/api/toggle-port', { token, body: { id: node.id } });
    check('启动节点成功', started.json?.is_running === true, JSON.stringify(started.json));

    // use it
    try {
      const body = await useProxy(node.local_port, 'https://api.ipify.org/?format=json');
      const match = body.match(/"ip"\s*:\s*"([^"]+)"/);
      check('经节点端口访问成功', Boolean(match), body.slice(0, 60));
      if (match) console.log(`        出口 IP：${match[1]}`);
    } catch (error) {
      check('经节点端口访问成功', false, error.message);
    }

    // test-proxy endpoint
    const tested = await apiRequest(port, 'POST', '/api/test-proxy', { token, body: { id: node.id } });
    check('面板测速接口支持 vless', tested.status === 200 && Boolean(tested.json?.ip),
      JSON.stringify(tested.json));
    if (tested.json?.ip) console.log(`        测速：${tested.json.ip} / ${tested.json.latency}ms`);

    // stop
    const stopped = await apiRequest(port, 'POST', '/api/toggle-port', { token, body: { id: node.id } });
    check('停止节点成功', stopped.json?.is_running === false, JSON.stringify(stopped.json));

    // delete
    const deleted = await apiRequest(port, 'DELETE', `/api/proxies/${node.id}`, { token });
    check('删除节点成功', deleted.status === 204, `HTTP ${deleted.status}`);

    // unsupported link must be rejected with a clear reason
    const rejected = await apiRequest(port, 'POST', '/api/proxies', {
      token,
      body: { input: 'vless://00000000-0000-4000-8000-000000000000@h:443?security=tls&type=grpc' }
    });
    check('不支持的传输方式被拒绝', rejected.status === 400, `HTTP ${rejected.status} ${rejected.text}`);
    if (rejected.json?.error) console.log(`        错误信息：${rejected.json.error}`);
  } finally {
    await runtime.portManager.closeAll();
    await new Promise((resolve) => server.close(resolve));
    runtime.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常：', error.stack || error.message);
  process.exit(1);
});
