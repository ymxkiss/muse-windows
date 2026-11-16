'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_START_URL = 'http://muse.ai';
const DEFAULT_PAGE_FILE = 'default-page.json';

function validateDefaultPage(config) {
  const raw = config?.startUrl;
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 2048) {
    throw new Error('default-page.json 配置无效。请将 startUrl 设置为不超过 2048 个字符的 HTTP 或 HTTPS 地址。');
  }

  let parsed;
  try { parsed = new URL(raw.trim()); }
  catch { throw new Error('default-page.json 中的 startUrl 不是有效网址；请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('default-page.json 只支持 HTTP/HTTPS 地址，且网址中不能内嵌用户名或密码。');
  }
  return { startUrl: parsed.href };
}

function readAndValidate(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('default-page.json 无法解析；请修复 JSON 格式后重新启动。');
    }
    throw error;
  }
  return validateDefaultPage(config);
}

function loadOrCreateDefaultPage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DEFAULT_PAGE_FILE);
  try {
    return readAndValidate(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const config = { startUrl: DEFAULT_START_URL };
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readAndValidate(file);
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return config;
}

module.exports = { DEFAULT_START_URL, DEFAULT_PAGE_FILE, validateDefaultPage, loadOrCreateDefaultPage };
