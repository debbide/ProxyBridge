'use strict';

// Unit tests for the VLESS integration that need no network access: link
// parsing through the shared proxy-URI path, the vless:// input format, and the
// HTTP proxy's header/authority handling. Live tunnel behaviour is covered by
// the probe scripts under backend/vless/.

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseProxyUri, sanitizeProxy, normalizeNodeName } = require('./port-manager');
const { parseProxyInput } = require('./server');
const { splitAuthority, forwardableHeaders, HOP_BY_HOP } = require('./vless/http-proxy');
const { parseVlessLink, isVlessLink } = require('./vless/link');

const UUID = '00000000-0000-4000-8000-000000000000';
const LINK = `vless://${UUID}@man.example.net:443?encryption=none&security=tls&type=ws`
  + '&host=man.example.net&path=%2Fws&sni=man.example.net&fp=chrome#%F0%9F%87%AC%F0%9F%87%A7-Example';

test('parseProxyUri accepts a vless:// link and reports the vless protocol', () => {
  const parsed = parseProxyUri(LINK);
  assert.equal(parsed.protocol, 'vless:');
  assert.equal(parsed.hostname, 'man.example.net');
  assert.equal(parsed.port, '443');
});

test('parseProxyUri still accepts and normalizes the legacy protocols', () => {
  assert.equal(parseProxyUri('socks://h:1080').protocol, 'socks5:');
  assert.equal(parseProxyUri('http://h:8080').protocol, 'http:');
  assert.equal(parseProxyUri('socks5h://h:1080').protocol, 'socks5h:');
});

test('parseProxyUri rejects a vless link with an unsupported transport', () => {
  // The error must name the real reason rather than a generic parse failure.
  assert.throws(
    () => parseProxyUri(`vless://${UUID}@h:443?security=tls&type=grpc`),
    /grpc/
  );
  assert.throws(
    () => parseProxyUri(`vless://${UUID}@h:443?security=reality&type=tcp`),
    /reality/i
  );
  assert.throws(
    () => parseProxyUri(`vless://${UUID}@h:443?security=tls&type=ws&flow=xtls-rprx-vision`),
    /flow/
  );
});

test('parseProxyUri still rejects a genuinely unsupported scheme', () => {
  assert.throws(() => parseProxyUri('ftp://h:21'), /仅支持/);
  assert.throws(() => parseProxyUri('not a uri'), /格式无效|仅支持/);
});

test('isVlessLink only matches the vless scheme', () => {
  assert.equal(isVlessLink(LINK), true);
  assert.equal(isVlessLink('VLESS://x@h:443'), true);
  assert.equal(isVlessLink('socks5://h:1080'), false);
  assert.equal(isVlessLink(''), false);
  assert.equal(isVlessLink(null), false);
});

test('parseProxyInput extracts a vless link and uses its fragment as the name', () => {
  const parsed = parseProxyInput(LINK, '');
  assert.equal(parsed.uri, LINK);
  assert.equal(parsed.name, '🇬🇧-Example');
});

test('parseProxyInput prefers an explicitly typed name over the fragment', () => {
  const parsed = parseProxyInput(`${LINK} 我的节点`, '');
  assert.equal(parsed.name, '我的节点');
  assert.equal(parsed.uri, LINK);
});

test('parseProxyInput falls back to a generated name when the link has no fragment', () => {
  const bare = `vless://${UUID}@man.example.net:443?encryption=none&security=tls&type=ws`;
  const parsed = parseProxyInput(bare, '');
  assert.match(parsed.name, /^节点-/);
});

test('parseProxyInput rejects input without a recognizable protocol', () => {
  assert.throws(() => parseProxyInput('hello world'), /请输入包含/);
});

test('sanitizeProxy reports vless without leaking the link', () => {
  const row = { id: 7, name: 'n', uri: LINK, local_port: 8001, is_running: 1 };
  const sanitized = sanitizeProxy(row);
  assert.deepEqual(sanitized, {
    id: 7,
    name: 'n',
    protocol: 'vless',
    local_port: 8001,
    is_running: true
  });
  assert.equal('uri' in sanitized, false);
});

test('normalizeNodeName keeps a decoded fragment name usable', () => {
  assert.equal(normalizeNodeName('🇬🇧-Example'), '🇬🇧-Example');
  assert.throws(() => normalizeNodeName('   '), /不能为空/);
});

test('splitAuthority parses host:port and bracketed IPv6', () => {
  assert.deepEqual(splitAuthority('example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(splitAuthority('[2001:db8::1]:8443'), { host: '2001:db8::1', port: 8443 });
  assert.equal(splitAuthority('example.com'), null);
  assert.equal(splitAuthority(''), null);
  assert.equal(splitAuthority(null), null);
});

test('forwardableHeaders strips hop-by-hop headers only', () => {
  const result = forwardableHeaders({
    host: 'example.com',
    'user-agent': 'curl/8.0',
    connection: 'keep-alive',
    'proxy-authorization': 'Basic xyz',
    'proxy-connection': 'keep-alive',
    accept: '*/*'
  });
  assert.deepEqual(result, {
    host: 'example.com',
    'user-agent': 'curl/8.0',
    accept: '*/*'
  });
  for (const name of Object.keys(result)) {
    assert.equal(HOP_BY_HOP.has(name.toLowerCase()), false);
  }
});

test('parseVlessLink still rejects an unsupported flow at the source', () => {
  assert.throws(
    () => parseVlessLink(`vless://${UUID}@h:443?security=tls&type=ws&flow=xtls-rprx-vision`),
    /flow/
  );
});
