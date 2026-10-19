'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REGIONS = [
  { locale: 'zh-CN', languages: ['zh-CN', 'zh', 'en'], timezoneId: 'Asia/Shanghai' },
  { locale: 'en-SG', languages: ['en-SG', 'en'], timezoneId: 'Asia/Singapore' },
  { locale: 'en-US', languages: ['en-US', 'en'], timezoneId: 'America/New_York' },
  { locale: 'en-GB', languages: ['en-GB', 'en'], timezoneId: 'Europe/London' },
  { locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'], timezoneId: 'Asia/Tokyo' }
];
const SCREENS = [
  { width: 1366, height: 768, deviceScaleFactor: 1 },
  { width: 1536, height: 864, deviceScaleFactor: 1.25 },
  { width: 1920, height: 1080, deviceScaleFactor: 1 },
  { width: 1920, height: 1080, deviceScaleFactor: 1.25 },
  { width: 2560, height: 1440, deviceScaleFactor: 1.5 }
];
const pick = (items) => items[crypto.randomInt(items.length)];

function validateEnvironment(profile) {
  if (!profile || profile.schemaVersion !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.id || '') ||
      typeof profile.createdAt !== 'string' || !Number.isFinite(Date.parse(profile.createdAt)) ||
      profile.platform !== 'Win32' ||
      !REGIONS.some((region) => region.locale === profile.locale &&
        region.timezoneId === profile.timezoneId &&
        JSON.stringify(region.languages) === JSON.stringify(profile.languages)) ||
      profile.acceptLanguage !== profile.languages.join(',') ||
      ![4, 8, 12, 16].includes(profile.hardwareConcurrency) ||
      !SCREENS.some((screen) => screen.width === profile.screen?.width &&
        screen.height === profile.screen?.height && screen.deviceScaleFactor === profile.screen?.deviceScaleFactor)) {
    throw new Error('浏览器环境配置无效。为避免意外更换身份，已停止启动；请恢复 browser-environment.json 的备份。');
  }
  return profile;
}

function loadOrCreateEnvironment(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'browser-environment.json');
  try {
    const content = fs.readFileSync(file, 'utf8');
    let profile;
    try { profile = JSON.parse(content); }
    catch { throw new Error('browser-environment.json 无法解析；请恢复备份，程序不会自动覆盖原配置。'); }
    return validateEnvironment(profile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const region = pick(REGIONS);
  const profile = validateEnvironment({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    platform: 'Win32',
    ...region,
    languages: [...region.languages],
    acceptLanguage: region.languages.join(','),
    hardwareConcurrency: pick([4, 8, 12, 16]),
    screen: { ...pick(SCREENS) }
  });
  // Exclusive creation also works on FAT/exFAT portable drives. A partial write
  // after power loss fails validation on the next run instead of changing identity.
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return validateEnvironment(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return profile;
}

function userAgentOverride(profile, userAgent, chromeVersion) {
  const override = { userAgent, acceptLanguage: profile.acceptLanguage, platform: profile.platform };
  const version = /Chrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent)?.[1];
  const major = String(chromeVersion).split('.')[0];
  if (version === chromeVersion && /Windows NT 10\.0; Win64; x64/.test(userAgent) &&
      !/Edg\/|OPR\/|Electron\//.test(userAgent)) {
    override.userAgentMetadata = {
      brands: [{ brand: 'Not_A Brand', version: '99' }, { brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }],
      fullVersionList: [{ brand: 'Not_A Brand', version: '99.0.0.0' }, { brand: 'Chromium', version: chromeVersion }, { brand: 'Google Chrome', version: chromeVersion }],
      fullVersion: chromeVersion,
      platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86',
      model: '', mobile: false, bitness: '64', wow64: false
    };
  }
  return override;
}

async function applyEnvironment(contents, browserSession, profile, userAgent, chromeVersion) {
  browserSession.setUserAgent(userAgent, profile.acceptLanguage);
  contents.setUserAgent(userAgent);
  // Create a renderer using a network-free page before sending CDP commands.
  if (!contents.getURL()) await contents.loadURL('about:blank');
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  const send = (method, params) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`环境参数应用超时：${method}`)), 10000);
    contents.debugger.sendCommand(method, params).then(resolve, reject).finally(() => clearTimeout(timeout));
  });
  await send('Emulation.setUserAgentOverride', userAgentOverride(profile, userAgent, chromeVersion));
  await send('Emulation.setTimezoneOverride', { timezoneId: profile.timezoneId });
  await send('Emulation.setLocaleOverride', { locale: profile.locale.replace('-', '_') });
  await send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: profile.hardwareConcurrency });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 0, height: 0, mobile: false,
    screenWidth: profile.screen.width, screenHeight: profile.screen.height,
    deviceScaleFactor: profile.screen.deviceScaleFactor,
    screenOrientation: { type: 'landscapePrimary', angle: 0 }
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
}

module.exports = { loadOrCreateEnvironment, validateEnvironment, userAgentOverride, applyEnvironment };
