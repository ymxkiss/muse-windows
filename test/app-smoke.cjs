'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {app, BrowserWindow, webContents} = require('electron');
process.env.PORTABLE_EXECUTABLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-app-smoke-'));
require('../src/main');
const timer = setTimeout(() => { console.error('Application startup timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL() === 'about:blank' && contents.debugger.isAttached());
    const main = BrowserWindow.getAllWindows()[0];
    if (page && main && !main.webContents.isLoading()) {
      const profile = JSON.parse(fs.readFileSync(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MuseBrowserData', 'browser-environment.json'), 'utf8'));
      const actual = await page.executeJavaScript('({cpu:navigator.hardwareConcurrency,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})');
      assert.equal(actual.cpu, profile.hardwareConcurrency);
      assert.equal(actual.timezone, new Intl.DateTimeFormat('en', {timeZone:profile.timezoneId}).resolvedOptions().timeZone);
      const ui = await main.webContents.executeJavaScript("document.querySelector('#environmentSummary').textContent");
      if (!ui.includes(profile.id)) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
      assert.ok(page.session.getStoragePath().includes(`muse-${profile.id}`));
      console.log('PASS: full application startup, random profile, isolated partition, applied parameters and settings UI');
      clearTimeout(timer);
      app.quit();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Application did not reach configured state');
}).catch((error) => { console.error(error); app.exit(1); });
