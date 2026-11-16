'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {app, BrowserWindow, webContents} = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-app-smoke-'));
const dataDir = path.join(root, 'MuseBrowserData');
fs.mkdirSync(dataDir, {recursive:true});
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Default page smoke test</title>');
});
server.listen(0, '127.0.0.1', () => {
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(dataDir, 'default-page.json'), JSON.stringify({startUrl}, null, 2));
  process.env.PORTABLE_EXECUTABLE_DIR = root;
  require('../src/main');
  const timer = setTimeout(() => { console.error('Application startup timed out'); app.exit(1); }, 20000);
  app.whenReady().then(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === startUrl && contents.debugger.isAttached());
      const main = BrowserWindow.getAllWindows()[0];
      if (page && main && !main.webContents.isLoading()) {
        const profile = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-environment.json'), 'utf8'));
        const actual = await page.executeJavaScript('({cpu:navigator.hardwareConcurrency,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})');
        assert.equal(actual.cpu, profile.hardwareConcurrency);
        assert.equal(actual.timezone, new Intl.DateTimeFormat('en', {timeZone:profile.timezoneId}).resolvedOptions().timeZone);
        const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'default-page.json'), 'utf8'));
        assert.equal(config.startUrl, startUrl);
        const ui = await main.webContents.executeJavaScript("({environment:document.querySelector('#environmentSummary').textContent,defaultPage:document.querySelector('#defaultPageFile').textContent})");
        if (!ui.environment.includes(profile.id) || ui.defaultPage !== path.join(dataDir, 'default-page.json')) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const initialState = await main.webContents.executeJavaScript('window.museApp.getState()');
        assert.equal(initialState.rightClickDisabled, false);
        const toggleState = await main.webContents.executeJavaScript("document.querySelector('#rightClickDisabledToggle').getAttribute('aria-checked')");
        assert.equal(toggleState, 'false');
        await main.webContents.executeJavaScript("document.querySelector('[data-tab=\"settingsTab\"]').click(); document.querySelector('#rightClickDisabledToggle').click();");
        let updatedState;
        for (let attempt = 0; attempt < 20; attempt++) {
          updatedState = await main.webContents.executeJavaScript('window.museApp.getState()');
          if (updatedState.rightClickDisabled) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(updatedState.rightClickDisabled, true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).rightClickDisabled, true);
        let contextMenuPrevented = false;
        page.emit('context-menu', { preventDefault() { contextMenuPrevented = true; } }, {});
        assert.equal(contextMenuPrevented, true);
        assert.equal(page.getURL(), startUrl);
        assert.ok(page.session.getStoragePath().includes(`muse-${profile.id}`));
        console.log('PASS: configured default page, isolated profile, settings UI, persisted right-click toggle and suppressed context menu');
        clearTimeout(timer);
        server.close();
        app.quit();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Application did not reach configured state');
  }).catch((error) => { console.error(error); server.close(); app.exit(1); });
});
