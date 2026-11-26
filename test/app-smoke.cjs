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
        assert.equal(page.getURL(), startUrl);
        assert.ok(page.session.getStoragePath().includes(`muse-${profile.id}`));
        const tabs = await main.webContents.executeJavaScript('window.museApp.addTab()');
        assert.equal(tabs.tabs.length, 2);
        const secondTab = tabs.tabs.find((tab) => tab.name === '新标签');
        assert.ok(secondTab);
        assert.equal(tabs.activeTabId, secondTab.id);
        const secondPage = webContents.getAllWebContents().find((contents) =>
          contents.session.getStoragePath().includes(`${profile.id}-${secondTab.id}`));
        assert.ok(secondPage, 'second tab should have a separate persistent browser session');
        const renameUi = await main.webContents.executeJavaScript(`(async () => {
          const button = document.querySelector('#browserTabs .browser-tab.active .browser-tab-select');
          const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
          button.dispatchEvent(contextEvent);
          const overlay = document.querySelector('#renameTabOverlay');
          const input = document.querySelector('#renameTabName');
          const dialogOpened = !overlay.hidden && input.value === '新标签';
          input.value = '右键重命名测试';
          document.querySelector('#renameTabForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          for (let attempt = 0; attempt < 40; attempt++) {
            const currentName = document.querySelector('#browserTabs .browser-tab.active .browser-tab-select')?.textContent;
            if (currentName === input.value && overlay.hidden) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return {
            contextMenuPrevented: contextEvent.defaultPrevented,
            dialogOpened,
            dialogClosed: overlay.hidden,
            tabName: document.querySelector('#browserTabs .browser-tab.active .browser-tab-select')?.textContent
          };
        })()`);
        assert.equal(renameUi.contextMenuPrevented, true);
        assert.equal(renameUi.dialogOpened, true);
        assert.equal(renameUi.dialogClosed, true);
        assert.equal(renameUi.tabName, '右键重命名测试');
        const savedTabs = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'browser-tabs.json'), 'utf8'));
        assert.equal(savedTabs.tabs.find((tab) => tab.id === secondTab.id).name, '右键重命名测试');
        assert.equal(savedTabs.tabs.find((tab) => tab.id === secondTab.id).partitionKey, secondTab.id);
        const firstTabId = tabs.tabs.find((tab) => tab.id !== secondTab.id).id;
        const switched = await main.webContents.executeJavaScript(`window.museApp.activateTab('${firstTabId}')`);
        assert.equal(switched.activeTabId, firstTabId);
        console.log('PASS: configured default page, persistent default and additional tabs, independent session, rename/switch IPC, applied parameters and settings UI');
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
