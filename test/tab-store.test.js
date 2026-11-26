'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTabConfig, saveTabConfig, nextTabName, normalizeTabConfig } = require('../src/tab-store');

test('first launch creates and persists a default tab', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tabs-'));
  const file = path.join(root, 'config', 'browser-tabs.json');
  const startUrl = 'https://muse.ai/';
  const config = loadTabConfig(file, startUrl);
  assert.equal(config.tabs.length, 1);
  assert.equal(config.tabs[0].name, '默认标签');
  assert.equal(config.tabs[0].url, startUrl);
  assert.equal(config.activeTabId, config.tabs[0].id);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy proxy selection is migrated to the initial tab and tab settings persist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tabs-'));
  const file = path.join(root, 'config', 'browser-tabs.json');
  const config = loadTabConfig(file, 'https://muse.ai/', 'legacy-node');
  assert.equal(config.tabs[0].proxyNodeId, 'legacy-node');
  config.tabs[0].name = '工作';
  config.tabs[0].url = 'https://example.com/';
  config.tabs[0].proxyNodeId = 'new-node';
  saveTabConfig(file, config);
  const restored = loadTabConfig(file, 'https://muse.ai/');
  assert.equal(restored.tabs[0].name, '工作');
  assert.equal(restored.tabs[0].url, 'https://example.com/');
  assert.equal(restored.tabs[0].proxyNodeId, 'new-node');
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid tab URLs and missing active identifiers normalize safely', () => {
  const config = normalizeTabConfig({ tabs: [{ id: 'abcd', name: '  ', url: 'javascript:alert(1)' }], activeTabId: 'missing' }, 'https://muse.ai/');
  assert.equal(config.tabs[0].url, 'https://muse.ai/');
  assert.equal(config.tabs[0].name, '标签 1');
  assert.equal(config.activeTabId, config.tabs[0].id);
});

test('new tabs receive an available default name when no name is supplied', () => {
  assert.equal(nextTabName([]), '新标签');
  assert.equal(nextTabName([{ name: '新标签' }]), '新标签 2');
  assert.equal(nextTabName([{ name: '新标签' }, { name: '新标签 2' }]), '新标签 3');
  assert.equal(nextTabName([{ name: '工作' }, { name: '新标签' }]), '新标签 2');
});
