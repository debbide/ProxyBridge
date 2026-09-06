const https = require('node:https');
const { version: currentVersion } = require('./package.json');

const RELEASE_API_URL = 'https://api.github.com/repos/debbide/ProxyBridge/releases/latest';

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
    const req = request(RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `ProxyBridge/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) {
          resolve(null);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
          return;
        }

        try {
          const release = JSON.parse(body);
          resolve(release.draft || release.prerelease ? null : release);
        } catch (error) {
          reject(new Error('GitHub API returned invalid JSON'));
        }
      });
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
