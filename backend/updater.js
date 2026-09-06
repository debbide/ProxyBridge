const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const UPDATE_SERVICE = 'proxybridge-update.service';
const SERVICE_FILE = `/etc/systemd/system/${UPDATE_SERVICE}`;

function runSystemctl(args, execute = execFile) {
  return new Promise((resolve, reject) => {
    execute('systemctl', args, (error) => error ? reject(error) : resolve());
  });
}

async function startUpdate(execute = execFile) {
  try {
    await runSystemctl(['is-active', '--quiet', UPDATE_SERVICE], execute);
    const error = new Error('更新任务已在运行');
    error.statusCode = 409;
    throw error;
  } catch (error) {
    if (error.statusCode === 409) throw error;
  }

  // 放弃使用 --no-block (以兼容 python 模拟的 systemctl)，
  // 改为在 Node 中异步执行不阻塞后续的 202 响应
  execute('systemctl', ['start', UPDATE_SERVICE], (error) => {
    if (error) console.error('Update service error:', error);
  });
}

module.exports = { startUpdate, UPDATE_SERVICE };
