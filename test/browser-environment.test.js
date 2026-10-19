'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  loadOrCreateEnvironment,
  validateEnvironment,
  userAgentOverride,
} = require('../src/browser-environment.js');

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-browser-environment-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const PROFILE_FILE = 'browser-environment.json';

function assertValidProfile(profile) {
  assert.equal(profile.schemaVersion, 1);
  assert.match(profile.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(Number.isFinite(Date.parse(profile.createdAt)), 'createdAt must be an ISO-compatible date');
  assert.equal(new Date(profile.createdAt).toISOString(), profile.createdAt);
  assert.equal(profile.platform, 'Win32');
  assert.match(profile.locale, /^[a-z]{2,3}(?:-[A-Z]{2})?$/);
  assert.ok(Array.isArray(profile.languages) && profile.languages.length > 0);
  assert.ok(profile.languages.every((language) => typeof language === 'string' && language.length > 0));
  assert.ok(typeof profile.timezoneId === 'string' && profile.timezoneId.length > 0);
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: profile.timezoneId }));
  assert.ok([4, 8, 12, 16].includes(profile.hardwareConcurrency));
  assert.ok(profile.screen && Number.isInteger(profile.screen.width) && profile.screen.width > 0);
  assert.ok(Number.isInteger(profile.screen.height) && profile.screen.height > 0);
  assert.ok(Number.isFinite(profile.screen.deviceScaleFactor) && profile.screen.deviceScaleFactor > 0);
  assert.ok(typeof profile.acceptLanguage === 'string' && profile.acceptLanguage.length > 0);
}

test('creates a valid profile on first use and persists it in the data directory', async (t) => {
  const dataDir = await makeTempDir(t);
  const profile = await loadOrCreateEnvironment(dataDir);

  assertValidProfile(profile);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, PROFILE_FILE), 'utf8')), profile);
  assert.deepEqual(validateEnvironment(profile), profile);
});

test('reuses the same valid profile unchanged after restart', async (t) => {
  const dataDir = await makeTempDir(t);
  const first = await loadOrCreateEnvironment(dataDir);
  const savedBytes = await fs.readFile(path.join(dataDir, PROFILE_FILE));
  const restarted = await loadOrCreateEnvironment(dataDir);

  assert.deepEqual(restarted, first);
  assert.deepEqual(await fs.readFile(path.join(dataDir, PROFILE_FILE)), savedBytes);
});

test('creates different UUIDs for different data directories', async (t) => {
  const firstDir = await makeTempDir(t);
  const secondDir = await makeTempDir(t);
  const first = await loadOrCreateEnvironment(firstDir);
  const second = await loadOrCreateEnvironment(secondDir);

  assert.notEqual(first.id, second.id);
});

test('rejects corrupt JSON without replacing the existing file', async (t) => {
  const dataDir = await makeTempDir(t);
  const filePath = path.join(dataDir, PROFILE_FILE);
  const original = Buffer.from('{ definitely not valid JSON\n');
  await fs.writeFile(filePath, original);

  assert.throws(() => loadOrCreateEnvironment(dataDir));
  assert.deepEqual(await fs.readFile(filePath), original);
});

test('rejects invalid profile fields without replacing the existing file', async (t) => {
  const dataDir = await makeTempDir(t);
  const filePath = path.join(dataDir, PROFILE_FILE);
  const invalidProfile = {
    schemaVersion: 1,
    id: 'not-a-uuid',
    createdAt: 'not-a-date',
    platform: 'Linux x86_64',
    locale: 'en-US',
    languages: ['en-US'],
    timezoneId: 'Mars/Olympus_Mons',
    hardwareConcurrency: 3,
    screen: { width: -1, height: 0, deviceScaleFactor: 0 },
    acceptLanguage: 'en-US',
  };
  const original = Buffer.from(JSON.stringify(invalidProfile, null, 2));
  await fs.writeFile(filePath, original);

  assert.throws(() => loadOrCreateEnvironment(dataDir));
  assert.deepEqual(await fs.readFile(filePath), original);
});

test('propagates non-ENOENT filesystem errors instead of creating a profile', async (t) => {
  const parentDir = await makeTempDir(t);
  const dataDirPathIsAFile = path.join(parentDir, 'not-a-directory');
  await fs.writeFile(dataDirPathIsAFile, 'keep this file');

  assert.throws(() => loadOrCreateEnvironment(dataDirPathIsAFile), (error) => {
    assert.ok(error.code && error.code !== 'ENOENT', `expected a non-ENOENT IO error, got ${error.code}`);
    return true;
  });
  assert.equal(await fs.readFile(dataDirPathIsAFile, 'utf8'), 'keep this file');
});

test('attaches Chrome metadata only for a matching Windows desktop Chrome UA', async (t) => {
  const dataDir = await makeTempDir(t);
  const profile = await loadOrCreateEnvironment(dataDir);
  const chromeVersion = '137.0.7151.69';
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  const override = userAgentOverride(profile, userAgent, chromeVersion);

  assert.equal(override.userAgent, userAgent);
  assert.equal(override.acceptLanguage, profile.acceptLanguage);
  assert.equal(override.platform, profile.platform);
  assert.ok(override.userAgentMetadata, 'matching Windows desktop Chrome should receive metadata');
  assert.equal(override.userAgentMetadata.platform, 'Windows');
  assert.equal(override.userAgentMetadata.mobile, false);
  assert.equal(override.userAgentMetadata.fullVersion, chromeVersion);
  assert.ok(override.userAgentMetadata.brands.some((brand) => brand.version === '137'));
  assert.ok(override.userAgentMetadata.fullVersionList.some((brand) => brand.version === chromeVersion));
});

test('does not attach Chrome metadata when UA and actual version/platform do not match', async (t) => {
  const dataDir = await makeTempDir(t);
  const profile = await loadOrCreateEnvironment(dataDir);
  const version = '137.0.7151.69';
  const fakeOrMismatchedUAs = [
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/${version} Safari/537.36`,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Firefox/128.0',
  ];

  for (const userAgent of fakeOrMismatchedUAs) {
    const override = userAgentOverride(profile, userAgent, version);
    assert.equal(override.userAgent, userAgent);
    assert.equal(override.acceptLanguage, profile.acceptLanguage);
    assert.equal(override.platform, profile.platform);
    assert.equal(Object.hasOwn(override, 'userAgentMetadata'), false);
  }
});
