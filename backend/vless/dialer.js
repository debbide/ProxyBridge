'use strict';

// VLESS over WebSocket over TLS dialer.
//
//   client socket --CONNECT--> local port --> [this dialer] --> CF edge
//     --TLS(SNI)--> --WS(path)--> --VLESS header--> target
//
// One dialed tunnel carries exactly one target stream, because the upstream
// sing-box server does not have multiplex enabled. Stability therefore comes
// from picking a healthy Cloudflare edge, retrying across edges on failure and
// keeping the WebSocket alive, not from sharing a single connection.

const tls = require('node:tls');
const { Duplex } = require('node:stream');

const { parseVlessLink } = require('./link');
const { parseUuid } = require('./uuid');
const { COMMAND, encodeRequestHeader, responseHeaderSize } = require('./vless-header');
const { upgrade } = require('./websocket');
const { CloudflareEdgePool } = require('./cf-edges');

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_KEEPALIVE_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;

class VlessTunnelError extends Error {
  constructor(message, { address, cause } = {}) {
    super(message);
    this.name = 'VlessTunnelError';
    this.address = address;
    if (cause) this.cause = cause;
  }
}

// Presents the payload stream of a tunnel: the VLESS response header is
// consumed during setup, everything after it is the target's data.
class TunnelStream extends Duplex {
  constructor(connection, { onClose, initial } = {}) {
    super({ allowHalfOpen: true });
    this.connection = connection;
    this.onClose = onClose;
    this.settled = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;

    // Payload bytes that arrived together with the VLESS response header are
    // buffered before the reader attaches, so none of the first packet is lost.
    if (initial && initial.length > 0) {
      this.bytesRead += initial.length;
      this.push(initial);
    }

    connection.on('data', (chunk) => {
      this.bytesRead += chunk.length;
      if (!this.push(chunk)) {
        connection.pause();
      }
    });
    connection.on('end', () => this.push(null));
    connection.on('error', (error) => this.destroy(error));
    connection.on('close', () => this.finalize());
  }

  finalize() {
    if (this.settled) return;
    this.settled = true;
    if (typeof this.onClose === 'function') {
      this.onClose({ bytesRead: this.bytesRead, bytesWritten: this.bytesWritten });
    }
  }

  _read() {
    this.connection.resume();
  }

  // --- socket compatibility -------------------------------------------------
  // http.Agent and http.ClientRequest treat a connection as a net.Socket and
  // call these directly. A bare Duplex does not implement them, so the agent
  // would throw (e.g. `socket.setKeepAlive is not a function`) as soon as a
  // request completed and the socket was returned to the pool.
  setNoDelay(noDelay = true) {
    this.connection.socket.setNoDelay(noDelay);
    return this;
  }

  // http.Agent calls setTimeout() when a socket is returned to the pool so a
  // stale idle connection is eventually reaped. Duplex has no such method, so
  // it is emulated with a timer that emits 'timeout' like net.Socket does.
  setTimeout(timeout, callback) {
    if (callback) this.once('timeout', callback);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (timeout > 0) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.emit('timeout');
      }, timeout);
      this.idleTimer.unref?.();
    }
    return this;
  }

  setKeepAlive(enable, initialDelay) {
    this.connection.socket.setKeepAlive(enable, initialDelay);
    return this;
  }

  ref() {
    this.connection.socket.ref();
    return this;
  }

  unref() {
    this.connection.socket.unref();
    return this;
  }

  address() {
    return this.connection.socket.address();
  }

  get remoteAddress() {
    return this.connection.socket.remoteAddress;
  }

  get remotePort() {
    return this.connection.socket.remotePort;
  }

  get localAddress() {
    return this.connection.socket.localAddress;
  }

  get localPort() {
    return this.connection.socket.localPort;
  }

  get connecting() {
    return false;
  }

  _write(chunk, encoding, callback) {
    this.bytesWritten += chunk.length;
    this.connection.send(chunk).then(() => callback(), (error) => callback(error));
  }

  _final(callback) {
    this.connection.closeFrame(1000).then(() => callback(), () => callback());
  }

  _destroy(error, callback) {
    this.finalize();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.connection.destroy();
    callback(error);
  }
}

function connectTls({ address, port, servername, timeoutMs, rejectUnauthorized, alpn }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({
      host: address,
      port,
      servername,
      rejectUnauthorized,
      ALPNProtocols: alpn && alpn.length > 0 ? alpn : ['http/1.1']
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new VlessTunnelError(`连接 ${address}:${port} TLS 握手超时`, { address }));
    }, timeoutMs);

    socket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new VlessTunnelError(`连接 ${address}:${port} 失败：${error.message}`, { address, cause: error }));
    });
  });
}

// Waits for the VLESS response header. The header is 2 bytes plus a
// self-described addons block, so the size is known as soon as byte 2 arrives.
function readResponseHeader(connection, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      connection.removeListener('data', onData);
      connection.removeListener('error', onError);
      connection.removeListener('end', onEnd);
      clearTimeout(timer);
    };

    const done = (error, rest) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Stop flowing mode before the listener is removed: without this, bytes
      // that arrive between here and the caller attaching its own reader would
      // be emitted to nobody and lost.
      connection.pause();
      if (error) reject(error);
      else resolve(rest);
    };

    const timer = setTimeout(() => {
      done(new VlessTunnelError('等待 VLESS 响应头超时'));
    }, timeoutMs);

    function onError(error) {
      done(new VlessTunnelError(`VLESS 隧道出错：${error.message}`, { cause: error }));
    }

    function onEnd() {
      done(new VlessTunnelError('VLESS 隧道在响应头返回前被关闭'));
    }

    function onData(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      if (buffered.length < 2) return;
      const size = responseHeaderSize(buffered);
      if (buffered.length < size) return;
      const version = buffered[0];
      if (version !== 0x00) {
        done(new VlessTunnelError(`VLESS 响应版本不受支持：${version}`));
        return;
      }
      done(null, buffered.subarray(size));
    }

    connection.on('data', onData);
    connection.on('error', onError);
    connection.on('end', onEnd);
  });
}

class VlessDialer {
  constructor({
    link,
    edgePool,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    keepAliveMs = DEFAULT_KEEPALIVE_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    rejectUnauthorized,
    logger = () => undefined
  }) {
    this.link = typeof link === 'string' ? parseVlessLink(link) : link;
    this.uuidBytes = parseUuid(this.link.uuid);
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepAliveMs = keepAliveMs;
    this.maxAttempts = maxAttempts;
    this.rejectUnauthorized = rejectUnauthorized === undefined
      ? !this.link.allowInsecure
      : rejectUnauthorized;
    this.logger = logger;
    this.edgePool = edgePool || new CloudflareEdgePool({
      host: this.link.host,
      port: this.link.port,
      servername: this.link.sni,
      timeoutMs: this.connectTimeoutMs
    });
    this.stats = { attempts: 0, failures: 0, successes: 0, lastAddress: null, lastLatency: null };
  }

  // Builds the request header for one target. The command is always TCP: this
  // server has no multiplex, so UDP/mux would be silently mishandled.
  buildHeader({ host, port }) {
    return encodeRequestHeader({
      uuid: this.uuidBytes,
      host,
      port,
      command: COMMAND.TCP
    });
  }

  async dialOnce({ address, host, port }) {
    const startedAt = Date.now();
    const socket = await connectTls({
      address,
      port: this.link.port,
      servername: this.link.sni,
      timeoutMs: this.connectTimeoutMs,
      rejectUnauthorized: this.rejectUnauthorized,
      alpn: this.link.alpn
    });

    let connection;
    try {
      connection = await upgrade(socket, {
        host: this.link.wsHost,
        path: this.link.path,
        headers: {
          host: this.link.wsHost,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeoutMs: this.handshakeTimeoutMs
      });
    } catch (error) {
      socket.destroy();
      throw new VlessTunnelError(`WebSocket 握手失败：${error.message}`, { address, cause: error });
    }

    let leftover = Buffer.alloc(0);
    try {
      await connection.send(this.buildHeader({ host, port }));
      leftover = await readResponseHeader(connection, this.handshakeTimeoutMs);
    } catch (error) {
      connection.destroy();
      throw new VlessTunnelError(`VLESS 握手失败：${error.message}`, { address, cause: error });
    }

    const latency = Date.now() - startedAt;
    this.edgePool.reportSuccess(address, latency);
    this.stats.lastAddress = address;
    this.stats.lastLatency = latency;

    const stream = new TunnelStream(connection, { initial: leftover });

    if (this.keepAliveMs > 0) {
      // Cloudflare drops idle WebSockets after roughly 100s, so a ping well
      // inside that window keeps a quiet tunnel usable.
      const timer = setInterval(() => {
        if (stream.destroyed || connection.isClosed) {
          clearInterval(timer);
          return;
        }
        connection.ping().catch(() => clearInterval(timer));
      }, this.keepAliveMs);
      timer.unref?.();
      stream.once('close', () => clearInterval(timer));
    }

    return { stream, address, latency };
  }

  // Tries edges best-first, marking each failure so the next request avoids it.
  async dial({ host, port }) {
    const target = { host: String(host), port: Number(port) };
    if (!target.host || !Number.isInteger(target.port)) {
      throw new VlessTunnelError('目标地址或端口无效');
    }

    const edges = await this.edgePool.ordered();
    if (edges.length === 0) {
      throw new VlessTunnelError('没有可用的 Cloudflare 边缘地址');
    }

    const attempts = Math.min(this.maxAttempts, edges.length);
    let lastError = null;

    for (let index = 0; index < attempts; index += 1) {
      const address = edges[index];
      this.stats.attempts += 1;
      try {
        const result = await this.dialOnce({ address, ...target });
        this.stats.successes += 1;
        this.logger(`vless 隧道建立成功 ${address} -> ${target.host}:${target.port} (${result.latency}ms)`);
        return result;
      } catch (error) {
        this.stats.failures += 1;
        lastError = error;
        this.edgePool.reportFailure(address);
        this.logger(`vless 边缘 ${address} 失败：${error.message}`);
      }
    }

    throw new VlessTunnelError(
      `所有 Cloudflare 边缘均连接失败：${lastError ? lastError.message : '未知错误'}`,
      { cause: lastError }
    );
  }
}

function createVlessDialer(options) {
  return new VlessDialer(options);
}

// Convenience helper for the self-check script and tests: dials a target and
// returns the raw duplex stream.
async function openVlessTunnel({ link, host, port, ...options }) {
  const dialer = createVlessDialer({ link, ...options });
  const { stream, address, latency } = await dialer.dial({ host, port });
  return { stream, dialer, address, latency };
}

module.exports = {
  VlessDialer,
  VlessTunnelError,
  TunnelStream,
  createVlessDialer,
  openVlessTunnel,
  connectTls,
  readResponseHeader,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_MS
};
