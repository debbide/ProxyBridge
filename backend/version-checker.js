const https = require('node:https');
const { version: currentVersion } = require('./package.json');

const LATEST_RELEASE_URL = 'https://github.com/debbide/ProxyBridge/releases/latest';

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split('.').map(Number);
  const rightParts = normalizeVersion(right).split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function requestLatestRelease({ request = https.get, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(LATEST_RELEASE_URL, {
      headers: {
        'User-Agent': `ProxyBridge/${currentVersion}`
      }
    }, (res) => {
      const location = res.headers.location || '';
      const match = location.match(/\/releases\/tag\/([^/?#]+)/);
      res.resume();

      if (match) {
        resolve({ tag_name: decodeURIComponent(match[1]), html_url: location });
        return;
      }
      if (res.statusCode === 404) {
        resolve(null);
        return;
      }
      reject(new Error(`GitHub release returned HTTP ${res.statusCode}`));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('GitHub API request timed out')));
    req.once('error', reject);
  });
}

async function checkVersion(options = {}) {
  const checkedAt = new Date().toISOString();
  try {
    const release = await requestLatestRelease(options);
    if (!release?.tag_name) {
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        checkedAt,
        status: 'unavailable'
      };
    }

    const latestVersion = normalizeVersion(release.tag_name);
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      checkedAt,
      status: 'ok',
      releaseUrl: release.html_url || null
    };
  } catch (error) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      checkedAt,
      status: 'error',
      error: '暂时无法连接 GitHub 检查最新版本'
    };
  }
}

module.exports = { checkVersion, compareVersions, normalizeVersion, requestLatestRelease };
