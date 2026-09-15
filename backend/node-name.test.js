'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeNodeName } = require('./port-manager');

test('trims and collapses whitespace', () => {
  assert.equal(normalizeNodeName('  香港   节点  '), '香港 节点');
});

test('strips control characters including newlines', () => {
  assert.equal(normalizeNodeName('line1\nline2'), 'line1 line2');
  assert.equal(normalizeNodeName('a\tb\rc'), 'a b c');
  assert.equal(normalizeNodeName('name\u0000\u001b[31m'), 'name [31m');
  assert.equal(normalizeNodeName('zero\u200bwidth'), 'zero\u200bwidth');
});

test('rejects an empty or whitespace-only name', () => {
  assert.throws(() => normalizeNodeName('   '), /不能为空/);
  assert.throws(() => normalizeNodeName('\n\t'), /不能为空/);
  assert.throws(() => normalizeNodeName(undefined), /不能为空/);
});

test('enforces the length limit after normalization', () => {
  assert.equal(normalizeNodeName('x'.repeat(80)).length, 80);
  assert.throws(() => normalizeNodeName('x'.repeat(81)), /不能超过 80 个字符/);
  // Control characters collapse away, so this fits once normalized.
  assert.equal(normalizeNodeName('x'.repeat(80) + '\n\n'), 'x'.repeat(80));
});

test('keeps unicode node names intact', () => {
  assert.equal(normalizeNodeName('东京-01 🇯🇵'), '东京-01 🇯🇵');
});
