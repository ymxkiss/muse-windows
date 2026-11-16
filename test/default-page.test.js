'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  DEFAULT_PAGE_FILE,
  DEFAULT_START_URL,
  loadOrCreateDefaultPage,
  validateDefaultPage
} = require('../src/default-page.js');

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-default-page-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('creates and persists the default page configuration on first use', async (t) => {
  const dataDir = await makeTempDir(t);
  const config = loadOrCreateDefaultPage(dataDir);

  assert.deepEqual(config, { startUrl: DEFAULT_START_URL });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, DEFAULT_PAGE_FILE), 'utf8')), config);
});

test('loads an edited HTTP or HTTPS address from the same data directory', async (t) => {
  const dataDir = await makeTempDir(t);
  const file = path.join(dataDir, DEFAULT_PAGE_FILE);
  await fs.writeFile(file, JSON.stringify({ startUrl: 'https://example.com/path?q=1' }));

  assert.deepEqual(loadOrCreateDefaultPage(dataDir), { startUrl: 'https://example.com/path?q=1' });
});

test('normalizes a valid URL and rejects unsafe or invalid addresses', () => {
  assert.deepEqual(validateDefaultPage({ startUrl: '  https://example.com  ' }), { startUrl: 'https://example.com/' });
  for (const startUrl of ['', 'not a URL', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.throws(() => validateDefaultPage({ startUrl }));
  }
});

test('does not overwrite malformed or invalid existing configuration', async (t) => {
  const dataDir = await makeTempDir(t);
  const file = path.join(dataDir, DEFAULT_PAGE_FILE);
  const invalid = Buffer.from('{ invalid json\n');
  await fs.writeFile(file, invalid);

  assert.throws(() => loadOrCreateDefaultPage(dataDir), /default-page\.json/);
  assert.deepEqual(await fs.readFile(file), invalid);
});
