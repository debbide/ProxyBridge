'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApplication } = require('./server');
const { PortManager } = require('./port-manager');

const ADMIN_PASSWORD = 'test-password-123';
const JWT_SECRET = 'j'.repeat(40);
const ENCRYPTION_KEY = 'k'.repeat(40);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-api-'));
let dbCounter = 0;

function makeApp(options = {}) {
  dbCounter += 1;
  return createApplication({
    databasePath: path.join(tmpDir, `api-${dbCounter}.db`),
    adminPassword: ADMIN_PASSWORD,
    jwtSecret: JWT_SECRET,
    proxyEncryptionKey: ENCRYPTION_KEY,
    checkVersion: async () => ({ status: 'ok', currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false }),
    startUpdate: async () => {},
    ...options
  });
}

async function withServer(options, run) {
  const runtime = makeApp(options);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (route, init = {}) => {
    const response = await fetch(base + route, init);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, headers: response.headers, body };
  };

  const login = async (password = ADMIN_PASSWORD) => {
    const response = await request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    return response;
  };

  try {
    await run({ base, request, login, runtime });
  } finally {
    await runtime.portManager.closeAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    runtime.database.close();
  }
}

function authed(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra };
}

test.after(() => {
  // SQLite may still hold a handle on Windows; a leftover temp dir is harmless.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (error) {
    // ignore
  }
});

test('unknown /api routes return JSON 404 instead of the SPA shell', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: tokenBody } = await login();
    const response = await request('/api/does-not-exist', { headers: authed(tokenBody.token) });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: '接口不存在' });
  });
});

test('the SPA shell is still served for real page routes', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/some/deep/link');

    assert.equal(response.status, 200);
    assert.match(String(response.body), /<!doctype html>/i);
  });
});

test('unauthenticated requests are rejected', async () => {
  await withServer({}, async ({ request }) => {
    assert.equal((await request('/api/proxies')).status, 401);
  });
});

test('login rejects a wrong password and accepts the right one', async () => {
  await withServer({}, async ({ login }) => {
    assert.equal((await login('wrong-password')).status, 401);
    assert.equal((await login()).status, 200);
  });
});

test('login locks a client out after repeated failures', async () => {
  await withServer({}, async ({ login }) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login('wrong-password');
      assert.equal(response.status, attempt === 4 ? 429 : 401);
    }

    const blocked = await login('wrong-password');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    // Even the correct password stays blocked while the lock is active.
    assert.equal((await login()).status, 429);
  });
});

test('validation failures report 400 with a safe message', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: token } = await login();
    const headers = authed(token.token);

    const cases = [
      ['/api/proxies', { input: 'ftp://example.com:21' }, /请输入包含/],
      ['/api/proxies', { input: 'http://example.com' }, /必须包含主机和端口/],
      ['/api/proxies', { input: 'http://127.0.0.1:1080', name: 'x'.repeat(90) }, /不能超过 80 个字符/]
    ];

    for (const [route, payload, pattern] of cases) {
      const response = await request(route, { method: 'POST', headers, body: JSON.stringify(payload) });
      assert.equal(response.status, 400, `${JSON.stringify(payload)} -> ${response.status}`);
      assert.match(response.body.error, pattern);
    }
  });
});

test('a blank name falls back to a generated one on create', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: token } = await login();
    const response = await request('/api/proxies', {
      method: 'POST', headers: authed(token.token),
      body: JSON.stringify({ input: 'http://127.0.0.1:1080', name: '   ' })
    });

    assert.equal(response.status, 201);
    assert.match(response.body.name, /^节点-/);
  });
});

test('a newline in the node name is collapsed, not rejected', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: token } = await login();
    const response = await request('/api/proxies', {
      method: 'POST', headers: authed(token.token),
      body: JSON.stringify({ input: 'line1\nline2 http://127.0.0.1:1080' })
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.name, 'line1 line2');
    assert.doesNotMatch(response.body.name, /[\r\n]/);
  });
});

test('non-numeric ids 404 rather than crashing', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: token } = await login();
    const headers = authed(token.token);

    for (const route of ['/api/proxies/abc', '/api/proxies/0', '/api/proxies/-1', '/api/proxies/1.5']) {
      const response = await request(route, { method: 'DELETE', headers });
      assert.equal(response.status, 404, route);
      assert.deepEqual(response.body, { error: '代理不存在' });
    }
  });
});

test('control characters in a node name are rejected', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: token } = await login();
    const headers = authed(token.token);

    const created = await request('/api/proxies', {
      method: 'POST', headers, body: JSON.stringify({ input: 'ok http://127.0.0.1:1080' })
    });
    assert.equal(created.status, 201);

    const renamed = await request(`/api/proxies/${created.body.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'a\nb' })
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'a b');

    const blank = await request(`/api/proxies/${created.body.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: '   ' })
    });
    assert.equal(blank.status, 400);
  });
});

test('internal errors never leak SQL, crypto or parser details', async () => {
  await withServer({}, async ({ request, login }) => {
    const { body: token } = await login();
    const headers = authed(token.token);

    // Malformed JSON body: express's parser message must not reach the client.
    const malformed = await request('/api/proxies', { method: 'POST', headers, body: '{oops' });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(String(malformed.body.error), /position|JSON at|SyntaxError/i);

    // Oversized body.
    const oversized = await request('/api/proxies', {
      method: 'POST', headers, body: JSON.stringify({ input: 'a'.repeat(40000) })
    });
    assert.equal(oversized.status, 413);
  });
});

test('a database failure surfaces as a generic 500', async () => {
  await withServer({}, async ({ request, login, runtime }) => {
    const { body: token } = await login();
    runtime.database.listProxies = () => {
      throw new Error('SQLITE_ERROR: no such table: proxies');
    };

    const response = await request('/api/proxies', { headers: authed(token.token) });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: '服务器内部错误' });
    assert.doesNotMatch(JSON.stringify(response.body), /SQLITE|no such table/i);
  });
});

test('update endpoint maps each outcome to the right status', async () => {
  const cases = [
    ['unavailable', { status: 'error', currentVersion: '1.0.0' }, 503],
    ['current', { status: 'ok', currentVersion: '2.1.0', latestVersion: '2.1.0', updateAvailable: false }, 200],
    ['available', { status: 'ok', currentVersion: '1.0.0', latestVersion: '2.1.0', updateAvailable: true }, 202]
  ];

  for (const [label, version, expected] of cases) {
    await withServer({ checkVersion: async () => version }, async ({ request, login }) => {
      const { body: token } = await login();
      const response = await request('/api/update', { method: 'POST', headers: authed(token.token) });
      assert.equal(response.status, expected, label);
    });
  }
});

test('a failed update start is reported instead of a false 202', async () => {
  const failure = new Error('更新服务未安装，请重新运行 install.sh 后再试');
  failure.statusCode = 503;
  failure.safeMessage = true;

  await withServer({
    checkVersion: async () => ({ status: 'ok', currentVersion: '1.0.0', latestVersion: '2.1.0', updateAvailable: true }),
    startUpdate: async () => { throw failure; }
  }, async ({ request, login }) => {
    const { body: token } = await login();
    const response = await request('/api/update', { method: 'POST', headers: authed(token.token) });

    assert.equal(response.status, 503);
    assert.match(response.body.error, /更新服务未安装/);
  });
});

test('a concurrent update returns 409', async () => {
  const conflict = new Error('更新任务已在运行');
  conflict.statusCode = 409;

  await withServer({
    checkVersion: async () => ({ status: 'ok', currentVersion: '1.0.0', latestVersion: '2.1.0', updateAvailable: true }),
    startUpdate: async () => { throw conflict; }
  }, async ({ request, login }) => {
    const { body: token } = await login();
    const response = await request('/api/update', { method: 'POST', headers: authed(token.token) });

    assert.equal(response.status, 409);
    assert.match(response.body.error, /更新任务已在运行/);
  });
});

// A manager that deliberately interleaves concurrent allocations, which is the
// timing that made the old check-then-insert implementation collide.
class SlowPortManager extends PortManager {
  async reservePort(input) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return super.reservePort(input);
  }
}

test('concurrent node creation never assigns the same local port twice', async () => {
  const { ProxyDatabase } = require('./database');
  const { createProxyCrypto } = require('./proxy-crypto');

  const database = new ProxyDatabase(
    path.join(tmpDir, 'race.db'),
    createProxyCrypto(ENCRYPTION_KEY)
  );
  const slow = new SlowPortManager({
    database, host: '127.0.0.1', portStart: 8001, portEnd: 8999
  });
  const runtime = createApplication({
    database,
    portManager: slow,
    adminPassword: ADMIN_PASSWORD,
    jwtSecret: JWT_SECRET,
    proxyEncryptionKey: ENCRYPTION_KEY,
    checkVersion: async () => ({ status: 'ok', currentVersion: '1.0.0', updateAvailable: false }),
    startUpdate: async () => {}
  });

  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const loginResponse = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const { token } = await loginResponse.json();
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => fetch(`${base}/api/proxies`, {
      method: 'POST', headers, body: JSON.stringify({ input: `node-${index} http://127.0.0.1:${9100 + index}` })
    }).then(async (response) => ({ status: response.status, body: await response.json() }))));

    const created = responses.filter((response) => response.status === 201);
    assert.equal(created.length, 12, JSON.stringify(responses.filter((r) => r.status !== 201)));
    assert.equal(new Set(created.map((r) => r.body.local_port)).size, 12);
    assert.deepEqual(database.getPortConflicts(), []);
  } finally {
    await slow.closeAll();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  }
});

test('port exhaustion reports 503, not a leaked constraint error', async () => {
  // Pick a port that is genuinely free right now, then cap the pool at one.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runtime = makeApp({ config: { localPortStart: freePort, localPortEnd: freePort } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const loginResponse = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    const { token } = await loginResponse.json();
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const first = await fetch(`${base}/api/proxies`, {
      method: 'POST', headers, body: JSON.stringify({ input: 'one http://127.0.0.1:1080' })
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).local_port, freePort);

    const second = await fetch(`${base}/api/proxies`, {
      method: 'POST', headers, body: JSON.stringify({ input: 'two http://127.0.0.1:1081' })
    });
    const payload = await second.json();

    assert.equal(second.status, 503);
    assert.deepEqual(payload, { error: '没有可分配的本地端口' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.database.close();
  }
});

test('startup fails loudly when secrets are missing or weak', () => {
  const base = { databasePath: path.join(tmpDir, 'boot.db') };

  assert.throws(() => createApplication({ ...base, adminPassword: undefined, env: {} }), /ADMIN_PASSWORD 未设置/);
  assert.throws(() => createApplication({ ...base, adminPassword: 'admin', env: {} }), /占位值/);
  assert.throws(() => createApplication({ ...base, adminPassword: 'short', env: {} }), /至少需要 8 个字符/);
  assert.throws(
    () => createApplication({ ...base, adminPassword: ADMIN_PASSWORD, jwtSecret: 'short', env: {} }),
    /JWT_SECRET 至少需要 32 个字符/
  );
  assert.throws(
    () => createApplication({ ...base, adminPassword: ADMIN_PASSWORD, jwtSecret: JWT_SECRET, env: {} }),
    /PROXY_ENCRYPTION_KEY 未设置/
  );
  assert.throws(
    () => createApplication({
      ...base, adminPassword: ADMIN_PASSWORD, jwtSecret: JWT_SECRET,
      proxyEncryptionKey: 'development-secret-change-me', env: {}
    }),
    /占位值/
  );
});

test('startup fails loudly when the encryption key cannot read stored data', async () => {
  const databasePath = path.join(tmpDir, 'key-check.db');
  const first = createApplication({
    databasePath,
    adminPassword: ADMIN_PASSWORD,
    jwtSecret: JWT_SECRET,
    proxyEncryptionKey: 'first-key-aaaaaaaaaaaaaaaa'
  });
  first.database.createProxy({ name: 'n', uri: 'http://127.0.0.1:1080', localPort: 8001 });
  first.database.close();

  assert.throws(() => createApplication({
    databasePath,
    adminPassword: ADMIN_PASSWORD,
    jwtSecret: JWT_SECRET,
    proxyEncryptionKey: 'second-key-bbbbbbbbbbbbbb'
  }), /unable to authenticate data|密文/);
});
