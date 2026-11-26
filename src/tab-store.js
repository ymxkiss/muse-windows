'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TABS = 50;
const MAX_NAME_LENGTH = 40;

function nextTabName(tabs) {
  const names = new Set((Array.isArray(tabs) ? tabs : []).map((tab) => String(tab?.name || '')));
  let index = 1;
  let candidate;
  do {
    candidate = index === 1 ? '新标签' : `新标签 ${index}`;
    index += 1;
  } while (names.has(candidate));
  return candidate;
}

function validTabUrl(value, fallbackUrl) {
  if (typeof value !== 'string' || !value.trim()) return fallbackUrl;
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {}
  return fallbackUrl;
}

function normalizeTabConfig(raw, startUrl, legacyProxyNodeId = '') {
  const source = Array.isArray(raw?.tabs) ? raw.tabs : [];
  const tabs = [];
  const ids = new Set();
  for (const item of source.slice(0, MAX_TABS)) {
    const id = typeof item?.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) ? item.id : crypto.randomUUID();
    if (ids.has(id)) continue;
    ids.add(id);
    const name = String(item?.name || '').trim().slice(0, MAX_NAME_LENGTH) || `标签 ${tabs.length + 1}`;
    tabs.push({
      id,
      name,
      url: validTabUrl(item?.url, startUrl),
      proxyNodeId: typeof item?.proxyNodeId === 'string' ? item.proxyNodeId : '',
      partitionKey: item?.partitionKey === 'legacy' ? 'legacy' : id
    });
  }
  if (!tabs.length) {
    tabs.push({ id: crypto.randomUUID(), name: '默认标签', url: startUrl, proxyNodeId: legacyProxyNodeId || '', partitionKey: 'legacy' });
  }
  const requestedActiveId = typeof raw?.activeTabId === 'string' ? raw.activeTabId : '';
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveId) ? requestedActiveId : tabs[0].id;
  return { schemaVersion: 1, activeTabId, tabs };
}

function loadTabConfig(filePath, startUrl, legacyProxyNodeId = '') {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`标签配置文件无法读取或解析：${error.message}`);
  }
  const config = normalizeTabConfig(raw, startUrl, legacyProxyNodeId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return config;
}

function saveTabConfig(filePath, config) {
  const normalized = normalizeTabConfig(config, 'about:blank');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return normalized;
}

module.exports = { MAX_TABS, MAX_NAME_LENGTH, nextTabName, normalizeTabConfig, loadTabConfig, saveTabConfig };
