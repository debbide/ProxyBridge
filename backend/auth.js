'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function createAuth({
  adminPassword,
  jwtSecret,
  expiresIn = '12h',
  maxAttempts = 5,
  windowMs = 300000,
  blockMs = 900000
}) {
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required');
  }
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }

  const attempts = new Map();

  function prune(entry, now) {
    if (entry.blockedUntil > now) return entry;
    if (now - entry.firstAttemptAt > windowMs) {
      return { count: 0, firstAttemptAt: now, blockedUntil: 0 };
    }
    return entry;
  }

  // Counts failures per client and locks the client out for a while once the
  // threshold is crossed, so an exposed panel is not brute-forceable.
  function registerFailure(key, now) {
    const entry = prune(attempts.get(key) || { count: 0, firstAttemptAt: now, blockedUntil: 0 }, now);
    entry.count += 1;
    if (entry.count >= maxAttempts) {
      entry.blockedUntil = now + blockMs;
      entry.count = 0;
      entry.firstAttemptAt = now;
    }
    attempts.set(key, entry);
    return entry;
  }

  function retryAfterSeconds(entry, now) {
    return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
  }

  function login(req, res) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const entry = prune(attempts.get(key) || { count: 0, firstAttemptAt: now, blockedUntil: 0 }, now);
    attempts.set(key, entry);

    if (entry.blockedUntil > now) {
      const retryAfter = retryAfterSeconds(entry, now);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `登录尝试过于频繁，请在 ${retryAfter} 秒后重试` });
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    // Constant-time compare, and equal-length buffers because timingSafeEqual throws otherwise.
    const expected = Buffer.from(adminPassword, 'utf8');
    const supplied = Buffer.from(password, 'utf8');
    const matches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

    if (!matches) {
      const failure = registerFailure(key, now);
      if (failure.blockedUntil > now) {
        const retryAfter = retryAfterSeconds(failure, now);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `登录尝试过于频繁，请在 ${retryAfter} 秒后重试` });
      }
      return res.status(401).json({ error: '管理密码错误' });
    }

    attempts.delete(key);
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
