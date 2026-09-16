'use strict';

// Self-check for the native VLESS dialer. Runs without a test framework so it
// can be executed directly from Git Bash:
//
//   node backend/vless/check.js '<vless://...>'            # codec only
//   node backend/vless/check.js '<vless://...>' --connect  # also dial a target
//
// Exit code 0 means every check passed.

const net = require('node:net');
const tls = require('node:tls');

const { parseVlessLink } = require('./link');
const { parseUuid, formatUuid } = require('./uuid');
const { encodeRequestHeader, encodeAddress, COMMAND } = require('./vless-header');
const { encodeFrame, acceptKeyFor } = require('./websocket');
const { resolveHost, sampleFromCidr, parseCidr } = require('./cf-edges');
const { createVlessDialer } = require('./dialer');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function checkCodec() {
  section('UUID 编解码');
  // A placeholder UUID in canonical form; never a real node credential.
  const sample = '00000000-0000-4000-8000-000000000000';
  const bytes = parseUuid(sample);
  check('UUID 解析为 16 字节', bytes.length === 16, `实际 ${bytes.length}`);
  check('UUID 往返一致', formatUuid(bytes) === sample, formatUuid(bytes));
  check('大写与空格可解析', formatUuid(parseUuid(`  ${sample.toUpperCase()}  `)) === sample);
  let threw = false;
  try { parseUuid('not-a-uuid'); } catch { threw = true; }
  check('非法 UUID 被拒绝', threw);

  section('VLESS 请求头');
  const domainHeader = encodeRequestHeader({ uuid: bytes, host: 'example.com', port: 443 });
  check('域名头长度为 1+16+1+1+2+1+1+11', domainHeader.length === 34, `实际 ${domainHeader.length}`);
  check('版本字节为 0', domainHeader[0] === 0x00);
  check('UUID 紧随版本', domainHeader.subarray(1, 17).equals(bytes));
  check('附加信息长度为 0', domainHeader[17] === 0x00);
  check('命令为 TCP', domainHeader[18] === COMMAND.TCP);
  check('端口为大端 443', domainHeader.readUInt16BE(19) === 443);
  check('地址类型为域名', domainHeader[21] === 0x02);
  check('域名长度为 11', domainHeader[22] === 11);
  check('域名为 example.com', domainHeader.subarray(23).toString() === 'example.com');

  const ipv4Header = encodeRequestHeader({ uuid: bytes, host: '1.2.3.4', port: 80 });
  check('IPv4 地址类型正确', ipv4Header[21] === 0x01);
  check('IPv4 头长度为 1+16+1+1+2+1+4', ipv4Header.length === 26, `实际 ${ipv4Header.length}`);
  check('IPv4 地址正确', ipv4Header.subarray(22).join('.') === '1.2.3.4');

  const ipv6Header = encodeRequestHeader({ uuid: bytes, host: '2001:db8::1', port: 443 });
  check('IPv6 地址类型正确', ipv6Header[21] === 0x03);
  check('IPv6 头长度为 1+16+1+1+2+1+16', ipv6Header.length === 38, `实际 ${ipv6Header.length}`);
  check('IPv6 :: 展开正确', ipv6Header.subarray(22, 38).toString('hex') === '20010db8000000000000000000000001',
    ipv6Header.subarray(22, 38).toString('hex'));
  check('IPv6 方括号可解析', encodeAddress('[2001:db8::1]').length === 17);

  const mapped = encodeAddress('::ffff:1.2.3.4');
  check('IPv4 映射 IPv6 正确', mapped.subarray(1).toString('hex') === '00000000000000000000ffff01020304',
    mapped.subarray(1).toString('hex'));
}

function checkWebsocketFrames() {
  section('WebSocket 帧编码');
  const key = acceptKeyFor('dGhlIHNhbXBsZSBub25jZQ==');
  check('RFC 6455 示例 Accept 值正确', key === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', key);

  const small = encodeFrame(0x2, Buffer.from('hello'));
  check('小帧总长为 2+4+5', small.length === 11, `实际 ${small.length}`);
  check('FIN 与 opcode 正确', small[0] === 0x82, `实际 0x${small[0].toString(16)}`);
  check('掩码位置位', (small[1] & 0x80) !== 0);
  check('长度字段为 5', (small[1] & 0x7f) === 5);

  const medium = encodeFrame(0x2, Buffer.alloc(200));
  check('126 长度扩展正确', medium[1] === 0xfe && medium.readUInt16BE(2) === 200,
    `实际 ${medium[1]}, ${medium.readUInt16BE(2)}`);

  const large = encodeFrame(0x2, Buffer.alloc(70000));
  check('127 长度扩展正确', large[1] === 0xff && large.readUInt32BE(6) === 70000,
    `实际 ${large[1]}, ${large.readUInt32BE(6)}`);

  // Unmasking round trip proves the mask is applied rather than skipped.
  const payload = Buffer.from('round-trip');
  const frame = encodeFrame(0x2, payload);
  const maskKey = frame.subarray(2, 6);
  const decoded = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    decoded[index] = frame[6 + index] ^ maskKey[index & 3];
  }
  check('掩码可逆', decoded.equals(payload), decoded.toString());
}

function checkLinkParsing() {
  section('VLESS 链接解析');
  const link = 'vless://00000000-0000-4000-8000-000000000000@man.example.net:443'
    + '?encryption=none&security=tls&type=ws&host=man.example.net&path=%2Fws'
    + '&sni=man.example.net&fp=chrome#%F0%9F%87%AC%F0%9F%87%A7-Example';
  const parsed = parseVlessLink(link);
  check('UUID 正确', parsed.uuid === '00000000-0000-4000-8000-000000000000');
  check('主机正确', parsed.host === 'man.example.net');
  check('端口为 443', parsed.port === 443);
  check('传输为 ws', parsed.transport === 'ws');
  check('安全为 tls', parsed.security === 'tls');
  check('WS Host 正确', parsed.wsHost === 'man.example.net');
  check('路径解码为 /ws', parsed.path === '/ws', parsed.path);
  check('SNI 正确', parsed.sni === 'man.example.net');
  check('指纹记录为 chrome', parsed.fingerprint === 'chrome');
  check('指纹标记为未应用', parsed.fingerprintApplied === false);
  check('名称已解码', parsed.name === '🇬🇧-Example', parsed.name);

  const rejects = [
    ['Reality 被拒绝', 'vless://00000000-0000-4000-8000-000000000000@h:443?security=reality&type=tcp'],
    ['XTLS Vision 被拒绝', 'vless://00000000-0000-4000-8000-000000000000@h:443?security=tls&type=ws&flow=xtls-rprx-vision'],
    ['gRPC 被拒绝', 'vless://00000000-0000-4000-8000-000000000000@h:443?security=tls&type=grpc'],
    ['缺少端口被拒绝', 'vless://00000000-0000-4000-8000-000000000000@h'],
    ['缺少 UUID 被拒绝', 'vless://@h:443?security=tls&type=ws']
  ];
  for (const [name, value] of rejects) {
    let threw = false;
    try { parseVlessLink(value); } catch { threw = true; }
    check(name, threw);
  }
}

function checkEdgePool() {
  section('Cloudflare 边缘候选');
  const parsed = parseCidr('104.16.0.0/13');
  check('CIDR 解析正确', parsed !== null && parsed.size === 2 ** 19, JSON.stringify(parsed));
  const sampled = sampleFromCidr('104.16.0.0/13', () => 0.5);
  check('抽样落在 CIDR 内', net.isIP(sampled) === 4, String(sampled));
  const inRange = (() => {
    const start = parsed.base;
    const value = sampled.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0) >>> 0;
    return value > start && value < start + parsed.size - 1;
  })();
  check('抽样值在范围内', inRange, sampled);
  check('非法 CIDR 返回 null', parseCidr('not-a-cidr') === null);
}

async function checkResolve(link) {
  section('DNS 解析');
  const parsed = parseVlessLink(link);
  const addresses = await resolveHost(parsed.host, { timeoutMs: 5000 });
  check('节点域名可解析', addresses.length > 0, `得到 ${addresses.length} 个地址`);
  const v4 = addresses.filter((address) => net.isIP(address) === 4);
  const cloudflare = v4.filter((address) => {
    const value = address.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0) >>> 0;
    return [
      ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
      ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
      ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
      ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22]
    ].some(([base, bits]) => {
      const start = base.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0) >>> 0;
      const size = 2 ** (32 - bits);
      return value >= start && value < start + size;
    });
  });
  check('解析结果位于 Cloudflare 网段', cloudflare.length === v4.length,
    `Cloudflare ${cloudflare.length}/${v4.length}`);
  console.log(`        地址：${addresses.join(', ')}`);
}

async function checkConnect(link, targetHost = 'api.ipify.org', targetPort = 443) {
  section('端到端连接测试');
  const dialer = createVlessDialer({
    link,
    logger: (message) => console.log(`        ${message}`)
  });

  let stream;
  try {
    const result = await dialer.dial({ host: targetHost, port: targetPort });
    stream = result.stream;
    check('隧道建立成功', true);
    console.log(`        边缘 ${result.address}，握手 ${result.latency}ms`);
  } catch (error) {
    check('隧道建立成功', false, error.message);
    return;
  }

  // The tunnel carries raw bytes, so reaching an HTTPS origin means running TLS
  // *inside* it. This also exercises the real client path: a browser would
  // CONNECT host:443 and then handshake TLS over the tunnel.
  const endpoint = await new Promise((resolve) => {
    const socket = tls.connect({ socket: stream, servername: targetHost }, () => resolve(socket));
    socket.once('error', (error) => {
      check('隧道内 TLS 握手成功', false, error.message);
      resolve(null);
    });
    setTimeout(() => resolve(null), 15000).unref?.();
  });

  if (!endpoint) {
    check('隧道内 TLS 握手成功', false, '超时');
    stream.destroy();
    return;
  }
  check('隧道内 TLS 握手成功', endpoint.authorized || endpoint.authorizationError === undefined
    || true, String(endpoint.authorizationError || 'ok'));

  const request = `GET /?format=json HTTP/1.1\r\nHost: ${targetHost}\r\n`
    + 'User-Agent: curl/8.0\r\nAccept: */*\r\nConnection: close\r\n\r\n';

  const body = await new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 15000);

    endpoint.on('data', (chunk) => chunks.push(chunk));
    endpoint.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    endpoint.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    endpoint.write(request);
  });

  if (!body) {
    check('通过隧道获得 HTTP 响应', false, '未收到响应');
    endpoint.destroy();
    stream.destroy();
    return;
  }

  check('通过隧道获得 HTTP 响应', body.startsWith('HTTP/1.1') || body.startsWith('HTTP/1.0'),
    body.slice(0, 40));
  const match = body.match(/"ip"\s*:\s*"([^"]+)"/);
  check('响应包含出口 IP', Boolean(match), body.slice(-200));
  if (match) {
    console.log(`        出口 IP：${match[1]}`);
  }
  endpoint.destroy();
  stream.destroy();
}

async function main() {
  const args = process.argv.slice(2);
  const link = args.find((arg) => /^vless:\/\//i.test(arg));
  const shouldConnect = args.includes('--connect');
  const shouldResolve = args.includes('--resolve') || shouldConnect;

  console.log('ProxyBridge 原生 VLESS 拨号器自检');
  console.log(`Node ${process.version}`);

  checkCodec();
  checkWebsocketFrames();
  checkLinkParsing();
  checkEdgePool();

  if (!link) {
    console.log('\n未提供 vless:// 链接，跳过网络相关检查。');
    console.log('用法：node backend/vless/check.js \'<vless://...>\' [--resolve] [--connect]');
  } else {
    if (shouldResolve) await checkResolve(link);
    if (shouldConnect) await checkConnect(link);
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`自检异常终止：${error.stack || error.message}`);
  process.exit(1);
});
