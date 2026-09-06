const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  checkVersion,
  compareVersions,
  normalizeVersion,
  requestLatestRelease
} = require('./version-checker');

function createRequest({ statusCode = 302, location = '', error = null }) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (requestError) => process.nextTick(() => req.emit('error', requestError));

    process.nextTick(() => {
      if (error) {
        req.emit('error', error);
        return;
      }

      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = { location };
      res.resume = () => {};
      callback(res);
    });

    return req;
  };
}

test('normalizes release tags and compares semantic versions', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(compareVersions('v1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('requests the latest official GitHub release', async () => {
  const release = await requestLatestRelease({
    request: createRequest({
      location: 'https://github.com/debbide/ProxyBridge/releases/tag/v1.1.0'
    })
  });

  assert.equal(release.tag_name, 'v1.1.0');
});

test('reports an available update', async () => {
  const result = await checkVersion({
    request: createRequest({
      location: 'https://github.com/debbide/ProxyBridge/releases/tag/v1.1.0'
    })
  });

  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.1.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.status, 'ok');
});

test('reports when the installed version is current', async () => {
  const result = await checkVersion({
    request: createRequest({
      location: 'https://github.com/debbide/ProxyBridge/releases/tag/v1.0.0'
    })
  });

  assert.equal(result.updateAvailable, false);
  assert.equal(result.status, 'ok');
});

test('handles a repository with no release', async () => {
  const result = await checkVersion({ request: createRequest({ statusCode: 404 }) });

  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.status, 'unavailable');
});

test('returns a safe error when GitHub cannot be reached', async () => {
  const result = await checkVersion({
    request: createRequest({ error: new Error('sensitive network detail') })
  });

  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.status, 'error');
  assert.equal(result.error, '暂时无法连接 GitHub 检查最新版本');
  assert.doesNotMatch(JSON.stringify(result), /sensitive network detail/);
});
