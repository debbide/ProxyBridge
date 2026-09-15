'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { conflict, serviceUnavailable } = require('./http-error');

const UPDATE_SERVICE = 'proxybridge-update.service';
const SERVICE_FILE = `/etc/systemd/system/${UPDATE_SERVICE}`;
const START_TIMEOUT_MS = 15000;

function runSystemctl(args, execute = execFile) {
  return new Promise((resolve, reject) => {
    execute('systemctl', args, (error) => error ? reject(error) : resolve());
  });
}

async function ensureUpdateServiceInstalled({ serviceFile = SERVICE_FILE } = {}) {
  try {
    await fs.access(serviceFile);
  } catch (error) {
    throw serviceUnavailable('更新服务未安装，请重新运行 install.sh 后再试');
  }
}

// `--no-block` matters: the update unit is a oneshot that can run for minutes,
// so waiting on it would hold the HTTP request open and delay the 202 response.
async function startUpdate(execute = execFile, { serviceFile = SERVICE_FILE, timeoutMs = START_TIMEOUT_MS } = {}) {
  await ensureUpdateServiceInstalled({ serviceFile });

  try {
    await runSystemctl(['is-active', '--quiet', UPDATE_SERVICE], execute);
    throw conflict('更新任务已在运行');
  } catch (error) {
    if (error.statusCode === 409) throw error;
  }

  // Failures here are surfaced to the caller instead of being logged and
  // forgotten, so the panel cannot report "started" for an update that never ran.
  await Promise.race([
    runSystemctl(['start', '--no-block', UPDATE_SERVICE], execute),
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(serviceUnavailable('启动更新服务超时')), timeoutMs);
      timer.unref?.();
    })
  ]);
}

module.exports = { startUpdate, UPDATE_SERVICE, SERVICE_FILE };
