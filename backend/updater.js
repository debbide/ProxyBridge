const { execFile } = require('node:child_process');

const UPDATE_SERVICE = 'proxybridge-update.service';

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

  await runSystemctl(['start', '--no-block', UPDATE_SERVICE], execute);
}

module.exports = { startUpdate, UPDATE_SERVICE };
