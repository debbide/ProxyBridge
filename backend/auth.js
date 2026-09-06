const jwt = require('jsonwebtoken');

function createAuth({ adminPassword, jwtSecret, expiresIn = '12h' }) {
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required');
  }
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }

  function login(req, res) {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== adminPassword) {
      return res.status(401).json({ error: '管理密码错误' });
    }

    const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn });
    return res.json({ token });
  }

  function requireAuth(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: '缺少访问令牌' });
    }

    try {
      req.user = jwt.verify(match[1], jwtSecret);
      return next();
    } catch (error) {
      return res.status(401).json({ error: '访问令牌无效或已过期' });
    }
  }

  return { login, requireAuth };
}

module.exports = { createAuth };
