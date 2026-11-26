const {
  app,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  session,
  net,
  shell,
  globalShortcut,
  dialog
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nodeNet = require('node:net');
const { spawn } = require('node:child_process');
const { parseSubscriptionNodes } = require('./proxy-nodes');
const { makeMihomoConfig, proxyConfiguration } = require('./proxy-core-config');
const { loadOrCreateEnvironment, applyEnvironment } = require('./browser-environment');
const { loadOrCreateDefaultPage } = require('./default-page');
const { MAX_TABS, MAX_NAME_LENGTH, nextTabName, loadTabConfig, saveTabConfig } = require('./tab-store');

const APP_TITLE = 'Muse AI Browser';
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR ||
  (app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..'));
const DATA_DIR = path.join(PORTABLE_DIR, 'MuseBrowserData');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const TABS_FILE = path.join(CONFIG_DIR, 'browser-tabs.json');
const SUBSCRIPTIONS_DIR = path.join(DATA_DIR, 'subscriptions');
const CORE_DATA_DIR = path.join(DATA_DIR, 'mihomo');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const INITIAL_URL = 'about:blank';
const MAX_SUBSCRIPTION_BYTES = 25 * 1024 * 1024;
const DEFAULT_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

// In portable builds, the complete Chromium profile and subscription store live beside the EXE.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(SUBSCRIPTIONS_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);
app.setPath('sessionData', path.join(DATA_DIR, 'SessionData'));
app.setAppUserModelId('com.xy.museaibrowser');
let defaultPage;
try {
  defaultPage = loadOrCreateDefaultPage(DATA_DIR);
} catch (error) {
  app.whenReady().then(() => {
    dialog.showErrorBox('默认访问页配置无效', error.message);
    app.exit(1);
  });
  return;
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
let browserEnvironment;
try {
  browserEnvironment = loadOrCreateEnvironment(DATA_DIR);
} catch (error) {
  app.whenReady().then(() => {
    dialog.showErrorBox('浏览器环境初始化失败', error.message);
    app.exit(1);
  });
  return;
}
app.commandLine.appendSwitch('lang', browserEnvironment.locale);
// WebRTC must not silently bypass the chosen proxy using a direct UDP socket.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

let settings = readJson(SETTINGS_FILE, {});
settings.userAgent = (typeof settings.userAgent === 'string' && settings.userAgent.trim())
  ? settings.userAgent.trim()
  : DEFAULT_USER_AGENT;
settings.navigationHidden = typeof settings.navigationHidden === 'boolean' ? settings.navigationHidden : false;
settings.rightClickDisabled = typeof settings.rightClickDisabled === 'boolean' ? settings.rightClickDisabled : false;
let subscriptions = readJson(SUBSCRIPTIONS_FILE, []);
if (!Array.isArray(subscriptions)) subscriptions = [];
let persistedTabs = loadTabConfig(TABS_FILE, defaultPage.startUrl, settings.proxyNodeId || '');
let tabs = [];
let activeTabId = persistedTabs.activeTabId;
let mainWindow = null;
let museView = null;
let browserSession = null;
let activeTab = null;
let activeProxyCore = null;
const proxyCores = new Set();
let proxyInitialization = Promise.resolve();
let tray = null;
let isQuitting = false;
let overlayVisible = false;
let topInset = settings.navigationHidden ? 52 : 104;

function persistSettings() { writeJsonAtomic(SETTINGS_FILE, settings); }
function persistSubscriptions() { writeJsonAtomic(SUBSCRIPTIONS_FILE, subscriptions); }
function persistTabs() {
  persistedTabs = saveTabConfig(TABS_FILE, {
    schemaVersion: 1,
    activeTabId,
    tabs: tabs.map(({ id, name, url, proxyNodeId, partitionKey }) => ({ id, name, url, proxyNodeId, partitionKey }))
  });
  activeTabId = persistedTabs.activeTabId;
}
function activateTab(tabId) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) throw new Error('找不到该标签。');
  activeTabId = tab.id;
  activeTab = tab;
  museView = tab.view;
  browserSession = tab.session;
  activeProxyCore = tab.proxyCore;
  for (const item of tabs) {
    if (item.view && !item.view.webContents.isDestroyed()) item.view.setVisible(item === activeTab && !overlayVisible);
  }
  persistTabs();
  layoutMuseView();
  emitBrowserState({ url: tab.view.webContents.getURL(), proxyNodeId: tab.proxyNodeId || '' });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tabs:active', publicTab(tab));
  return tab;
}
function publicTab(tab) {
  return { id: tab.id, name: tab.name, url: tab.url || '', proxyNodeId: tab.proxyNodeId || '' };
}
function cleanError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '请求超时，请检查网络后重试。';
  return '网络请求失败，请检查订阅地址和网络连接。';
}
function assertLocalRenderer(event) {
  const source = event.senderFrame?.url || event.sender.getURL();
  if (!source.startsWith('file://')) throw new Error('请求来源无效');
}
function validWebUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw).trim()); } catch { throw new Error('请输入有效的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('只支持 HTTP/HTTPS 订阅链接，且链接中不能内嵌用户名或密码。');
  }
  return parsed.href;
}
function collectProxyNodes() {
  const nodes = [];
  for (const subscription of subscriptions) {
    if (!subscription.fileName || nodes.length >= 500) continue;
    const file = path.join(SUBSCRIPTIONS_DIR, path.basename(subscription.fileName));
    try {
      const parsed = parseSubscriptionNodes(subscription, fs.readFileSync(file));
      nodes.push(...parsed.slice(0, 500 - nodes.length));
    } catch {}
  }
  return nodes;
}
function proxyNodeById(id) {
  return collectProxyNodes().find((node) => node.id === id) || null;
}
function mihomoExecutablePath() {
  if (process.env.MIHOMO_PATH) return path.resolve(process.env.MIHOMO_PATH);
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mihomo.exe')
    : path.join(__dirname, '..', 'vendor', 'mihomo.exe');
}
function findOpenLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function canConnectToLoopback(port) {
  return new Promise((resolve) => {
    const socket = nodeNet.createConnection({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timeout); resolve(false); });
  });
}
function stopProxyCore(core) {
  if (!core?.child || core.child.exitCode !== null || core.child.killed) return;
  try { core.child.kill(); } catch {}
}
async function startProxyCore(node) {
  const executable = mihomoExecutablePath();
  if (!fs.existsSync(executable)) throw new Error('找不到随应用提供的 Mihomo 代理核心。');
  const port = await findOpenLoopbackPort();
  fs.mkdirSync(CORE_DATA_DIR, { recursive: true });
  const configPath = path.join(CORE_DATA_DIR, `config-${process.pid}-${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(configPath, makeMihomoConfig(node, port), { encoding: 'utf8', mode: 0o600 });
  let spawnError = null;
  let diagnostics = '';
  const child = spawn(executable, ['-d', CORE_DATA_DIR, '-f', configPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const core = { child, port, configPath };
  proxyCores.add(core);
  child.stderr?.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
  child.once('error', (error) => { spawnError = error; });
  child.once('exit', () => {
    proxyCores.delete(core);
    try { fs.unlinkSync(configPath); } catch {}
    const owner = tabs.find((tab) => tab.proxyCore === core);
    if (owner) owner.proxyCore = null;
    if (activeProxyCore === core) {
      activeProxyCore = null;
      if (owner === activeTab) emitBrowserState({ loading: false, failed: true });
    }
  });
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (spawnError || child.exitCode !== null) break;
      if (await canConnectToLoopback(port)) return core;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    if (!spawnError && child.exitCode === null && await canConnectToLoopback(port)) return core;
    throw new Error('Mihomo 未能启动所选节点。');
  } catch {
    stopProxyCore(core);
    try { fs.unlinkSync(configPath); } catch {}
    console.warn('Selected proxy node could not be started by Mihomo.', diagnostics);
    throw new Error('所选 Clash 节点启动失败，请检查订阅格式、节点协议和参数。');
  }
}
async function applyProxyNode(node, targetTab = activeTab) {
  if (!targetTab) return;
  if (!node) {
    if (targetTab.session) {
      await targetTab.session.setProxy({ mode: 'direct' });
      await targetTab.session.closeAllConnections();
    }
    const previousCore = targetTab.proxyCore;
    targetTab.proxyCore = null;
    if (targetTab === activeTab) activeProxyCore = null;
    stopProxyCore(previousCore);
    return;
  }
  const previousCore = targetTab.proxyCore;
  const candidateCore = await startProxyCore(node);
  try {
    await targetTab.session.setProxy(proxyConfiguration(candidateCore.port));
    await targetTab.session.closeAllConnections();
    if (candidateCore.child.exitCode !== null) throw new Error('代理核心已意外退出。');
  } catch {
    stopProxyCore(candidateCore);
    try {
      const fallback = previousCore && previousCore.child.exitCode === null
        ? proxyConfiguration(previousCore.port)
        : { mode: 'direct' };
      await targetTab.session.setProxy(fallback);
      await targetTab.session.closeAllConnections();
    } catch {}
    throw new Error('浏览器无法连接到所选 Clash 节点。');
  }
  targetTab.proxyCore = candidateCore;
  if (targetTab === activeTab) activeProxyCore = candidateCore;
  if (previousCore && previousCore !== candidateCore) stopProxyCore(previousCore);
}
function publicProxyNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    sourceName: node.sourceName
  };
}
async function reconcileProxySelection(updatedSubscriptionId = '') {
  await proxyInitialization;
  const nodes = collectProxyNodes();
  let changed = false;
  for (const tab of tabs) {
    if (!tab.proxyNodeId) continue;
    const selected = nodes.find((node) => node.id === tab.proxyNodeId) || null;
    if (!selected) {
      await applyProxyNode(null, tab);
      tab.proxyNodeId = '';
      changed = true;
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    } else if (updatedSubscriptionId && selected.sourceId === String(updatedSubscriptionId)) {
      await applyProxyNode(selected, tab);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    }
  }
  if (changed) persistTabs();
  if (activeTab) emitBrowserState({ proxyNodeId: activeTab.proxyNodeId || '' });
}
async function getAppState() {
  await proxyInitialization;
  await reconcileProxySelection();
  const nodes = collectProxyNodes();
  return {
    dataDir: DATA_DIR,
    defaultPageFile: path.join(DATA_DIR, 'default-page.json'),
    startUrl: defaultPage.startUrl,
    userAgent: settings.userAgent,
    subscriptions,
    proxyNodes: nodes.map(publicProxyNode),
    proxyNodeId: activeTab?.proxyNodeId || '',
    tabs: tabs.map(publicTab),
    activeTabId,
    tabsConfigFile: TABS_FILE,
    navigationHidden: settings.navigationHidden,
    rightClickDisabled: settings.rightClickDisabled,
    environment: browserEnvironment
  };
}
function emitBrowserState(extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { url: eventUrl, ...details } = extra;
    const currentUrl = eventUrl || museView?.webContents.getURL() || '';
    const url = currentUrl === INITIAL_URL ? '' : currentUrl;
    mainWindow.webContents.send('browser:state', { url, proxyNodeId: activeTab?.proxyNodeId || '', activeTabId, ...details });
  }
}
function layoutMuseView() {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs.length) return;
  const [width, height] = mainWindow.getContentSize();
  for (const tab of tabs) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    tab.view.setBounds({
      x: 0,
      y: topInset,
      width: Math.max(0, width),
      height: Math.max(0, height - topInset)
    });
    tab.view.setVisible(tab === activeTab && !overlayVisible);
  }
}
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  showMainWindow();
}
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Muse AI Browser', click: showMainWindow },
    { label: '切换窗口显示 (Ctrl+Alt+M)', click: toggleMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function createBrowserTab(config) {
  const partition = config.partitionKey === 'legacy'
    ? `persist:muse-${browserEnvironment.id}`
    : `persist:muse-${browserEnvironment.id}-${config.partitionKey || config.id}`;
  const tabSession = session.fromPartition(partition, { cache: true });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'web-preload.js'),
      session: tabSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const tab = { ...config, session: tabSession, view, proxyCore: null };
  view.webContents.setUserAgent(settings.userAgent);
  view.webContents.on('context-menu', (event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (settings.rightClickDisabled) {
      event.preventDefault();
      return;
    }
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' });
      items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' });
    } else {
      if (params.linkURL && /^https?:\/\//i.test(params.linkURL)) {
        items.push({ label: '在当前页打开链接', click: () => view.webContents.loadURL(params.linkURL).catch(() => {}) });
      }
      if (params.selectionText) items.push({ role: 'copy', label: '复制选中文本' });
      items.push({ role: 'selectAll', label: '全选' });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: '后退', enabled: view.webContents.canGoBack(), click: () => view.webContents.goBack() },
      { label: '前进', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() },
      { label: '刷新', click: () => view.webContents.reload() }
    );
    if (params.mediaType === 'image' && Number.isFinite(params.x) && Number.isFinite(params.y)) {
      items.push({ type: 'separator' }, { label: '复制图片', click: () => view.webContents.copyImageAt(params.x, params.y) });
    }
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) view.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (url !== INITIAL_URL && !url.startsWith('http://') && !url.startsWith('https://')) event.preventDefault();
  });
  const recordUrl = (url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      tab.url = url;
      persistTabs();
    }
    if (tab === activeTab) emitBrowserState({ url });
  };
  view.webContents.on('did-navigate', (_event, url) => recordUrl(url));
  view.webContents.on('did-navigate-in-page', (_event, url) => recordUrl(url));
  view.webContents.on('did-start-loading', () => { if (tab === activeTab) emitBrowserState({ loading: true }); });
  view.webContents.on('did-stop-loading', () => { if (tab === activeTab) emitBrowserState({ loading: false }); });
  view.webContents.on('page-title-updated', (_event, title) => {
    if (tab === activeTab && mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(title ? `${title} — ${APP_TITLE}` : APP_TITLE);
  });
  view.webContents.on('did-fail-load', (_event, errorCode) => {
    if (tab === activeTab && errorCode !== -3) emitBrowserState({ loading: false, failed: true });
  });
  return tab;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  tabs = persistedTabs.tabs.map(createBrowserTab);
  activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  activeTabId = activeTab.id;
  for (const tab of tabs) mainWindow.contentView.addChildView(tab.view);
  activateTab(activeTab.id);
  mainWindow.on('resize', layoutMuseView);
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; museView = null; browserSession = null; activeTab = null; });
  mainWindow.webContents.once('did-finish-load', () => {
    layoutMuseView();
    mainWindow.show();
    mainWindow.webContents.send('app:ready', {
      dataDir: DATA_DIR,
      userAgent: settings.userAgent,
      startUrl: defaultPage.startUrl
    });
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  proxyInitialization = (async () => {
    await Promise.all(tabs.map(async (tab) => {
      await applyEnvironment(tab.view.webContents, tab.session, browserEnvironment, settings.userAgent, process.versions.chrome);
      const initialNode = tab.proxyNodeId ? proxyNodeById(tab.proxyNodeId) : null;
      if (tab.proxyNodeId && !initialNode) tab.proxyNodeId = '';
      try { await applyProxyNode(initialNode, tab); }
      catch { tab.proxyNodeId = ''; try { await applyProxyNode(null, tab); } catch {} }
      tab.view.webContents.loadURL(tab.url || defaultPage.startUrl).catch(() => {
        if (tab === activeTab) emitBrowserState({ loading: false, failed: true });
      });
    }));
    persistTabs();
    if (activeTab) activateTab(activeTab.id);
  })();
  proxyInitialization.catch((error) => {
    dialog.showErrorBox('浏览器环境应用失败', `为避免使用未配置的环境，程序已停止。\n${error.message}`);
    app.exit(1);
  });
  return mainWindow;
}

ipcMain.handle('app:get-state', async (event) => {
  assertLocalRenderer(event);
  return getAppState();
});
ipcMain.handle('window:control', (event, commandValue) => {
  assertLocalRenderer(event);
  if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false };
  const command = String(commandValue || '');
  if (command === 'minimize') mainWindow.minimize();
  else if (command === 'toggle-maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (command === 'close') mainWindow.close();
  else throw new Error('未知的窗口操作。');
  return { maximized: mainWindow.isMaximized() };
});
ipcMain.handle('tabs:add', async (event, nameValue) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  if (tabs.length >= MAX_TABS) throw new Error(`最多可创建 ${MAX_TABS} 个标签。`);
  const requestedName = String(nameValue || '').trim().slice(0, MAX_NAME_LENGTH);
  const name = requestedName || nextTabName(tabs);
  const id = crypto.randomUUID();
  const tab = createBrowserTab({ id, name, url: defaultPage.startUrl, proxyNodeId: '', partitionKey: id });
  tabs.push(tab);
  mainWindow.contentView.addChildView(tab.view);
  try {
    await applyEnvironment(tab.view.webContents, tab.session, browserEnvironment, settings.userAgent, process.versions.chrome);
    await applyProxyNode(null, tab);
    tab.view.webContents.loadURL(tab.url).catch(() => {});
    activateTab(tab.id);
    return { tabs: tabs.map(publicTab), activeTabId };
  } catch (error) {
    tabs = tabs.filter((item) => item !== tab);
    mainWindow.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
    throw error;
  }
});
ipcMain.handle('tabs:activate', async (event, idValue) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  const tab = activateTab(String(idValue || ''));
  return { tabs: tabs.map(publicTab), activeTabId, activeTab: publicTab(tab) };
});
ipcMain.handle('tabs:rename', (event, input) => {
  assertLocalRenderer(event);
  const tab = tabs.find((item) => item.id === String(input?.id || ''));
  if (!tab) throw new Error('找不到该标签。');
  const name = String(input?.name || '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new Error('标签名称不能为空。');
  tab.name = name;
  persistTabs();
  return { tabs: tabs.map(publicTab), activeTabId };
});
ipcMain.handle('tabs:close', async (event, idValue) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  if (tabs.length <= 1) throw new Error('至少需要保留一个标签。');
  const index = tabs.findIndex((item) => item.id === String(idValue || ''));
  if (index < 0) throw new Error('找不到该标签。');
  const [tab] = tabs.splice(index, 1);
  stopProxyCore(tab.proxyCore);
  mainWindow.contentView.removeChildView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
  if (tab.id === activeTabId) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
  else persistTabs();
  return { tabs: tabs.map(publicTab), activeTabId };
});
ipcMain.handle('browser:check-proxy-health', async (event) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  const proxyNodeId = activeTab?.proxyNodeId || '';
  if (!proxyNodeId) return { proxyNodeId: '', ok: true, direct: true, latencyMs: 0 };
  if (!proxyNodeById(proxyNodeId) || !activeTab?.proxyCore || activeTab.proxyCore.child.exitCode !== null) {
    return { proxyNodeId, ok: false, latencyMs: null };
  }
  const startedAt = Date.now();
  try {
    const response = await browserSession.fetch('https://cp.cloudflare.com/generate_204', {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(12000)
    });
    const ok = response.ok;
    try { await response.body?.cancel(); } catch {}
    return { proxyNodeId, ok, latencyMs: Date.now() - startedAt };
  } catch {
    return { proxyNodeId, ok: false, latencyMs: Date.now() - startedAt };
  }
});
ipcMain.on('ui:layout', (event, height) => {
  assertLocalRenderer(event);
  const value = Number(height);
  if (Number.isFinite(value)) topInset = Math.max(52, Math.min(240, Math.round(value)));
  layoutMuseView();
});
ipcMain.on('ui:navigation-hidden', (event, hidden) => {
  assertLocalRenderer(event);
  settings.navigationHidden = Boolean(hidden);
  persistSettings();
});
ipcMain.handle('browser:set-right-click-disabled', (event, disabled) => {
  assertLocalRenderer(event);
  settings.rightClickDisabled = Boolean(disabled);
  persistSettings();
  return { rightClickDisabled: settings.rightClickDisabled };
});
ipcMain.on('ui:overlay', (event, visible) => {
  assertLocalRenderer(event);
  overlayVisible = Boolean(visible);
  layoutMuseView();
});
ipcMain.handle('browser:navigate', async (event, raw) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  const url = validWebUrl(raw);
  await museView.webContents.loadURL(url);
  return { url };
});
ipcMain.handle('browser:set-proxy', async (event, nodeIdValue) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  const nodeId = String(nodeIdValue || '');
  const node = nodeId ? proxyNodeById(nodeId) : null;
  if (nodeId && !node) throw new Error('找不到该节点；请先更新订阅列表。');
  await applyProxyNode(node, activeTab);
  activeTab.proxyNodeId = node?.id || '';
  persistTabs();
  if (museView && !museView.webContents.isDestroyed()) museView.webContents.reload();
  emitBrowserState({ loading: true });
  return { proxyNodeId: activeTab.proxyNodeId, proxyNode: node ? publicProxyNode(node) : null };
});
ipcMain.handle('browser:command', async (event, command) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  const contents = museView.webContents;
  if (command === 'back' && contents.canGoBack()) contents.goBack();
  else if (command === 'forward' && contents.canGoForward()) contents.goForward();
  else if (command === 'reload') contents.reload();
  else if (command === 'stop') contents.stop();
  else if (command === 'home') contents.loadURL(defaultPage.startUrl).catch(() => {});
  return { url: contents.getURL() };
});
ipcMain.handle('app:save-user-agent', async (event, value) => {
  assertLocalRenderer(event);
  await proxyInitialization;
  const userAgent = String(value || '').trim();
  if (userAgent.length < 20 || userAgent.length > 500) throw new Error('浏览器标识长度应为 20–500 个字符。');
  await Promise.all(tabs.map((tab) => applyEnvironment(tab.view.webContents, tab.session, browserEnvironment, userAgent, process.versions.chrome)));
  settings.userAgent = userAgent;
  persistSettings();
  for (const tab of tabs) tab.view.webContents.reload();
  return { userAgent };
});
ipcMain.handle('app:open-data-dir', (event) => {
  assertLocalRenderer(event);
  return shell.openPath(DATA_DIR);
});
ipcMain.handle('subscription:save', (event, input) => {
  assertLocalRenderer(event);
  const name = String(input?.name || '').trim().slice(0, 80);
  if (!name) throw new Error('请填写订阅名称。');
  const url = validWebUrl(input?.url);
  const id = input?.id ? String(input.id) : crypto.randomUUID();
  const index = subscriptions.findIndex((item) => item.id === id);
  const old = index >= 0 ? subscriptions[index] : null;
  const item = {
    id,
    name,
    url,
    createdAt: old?.createdAt || new Date().toISOString(),
    updatedAt: old?.updatedAt || null,
    bytes: old?.bytes || 0,
    fileName: old?.fileName || null,
    lastError: null
  };
  if (index >= 0) subscriptions[index] = item;
  else subscriptions.unshift(item);
  persistSubscriptions();
  return { subscriptions };
});
ipcMain.handle('subscription:delete', async (event, idValue) => {
  assertLocalRenderer(event);
  const id = String(idValue);
  const item = subscriptions.find((entry) => entry.id === id);
  subscriptions = subscriptions.filter((entry) => entry.id !== id);
  if (item?.fileName) {
    const file = path.join(SUBSCRIPTIONS_DIR, path.basename(item.fileName));
    try { fs.unlinkSync(file); } catch {}
  }
  persistSubscriptions();
  await reconcileProxySelection();
  return { subscriptions };
});
async function fetchSubscription(url) {
  const response = await net.fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': settings.userAgent,
      'Accept': '*/*',
      'Cache-Control': 'no-cache'
    },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_BODY');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SUBSCRIPTION_BYTES) {
      await reader.cancel();
      throw new Error('TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
ipcMain.handle('subscription:update', async (event, idValue) => {
  assertLocalRenderer(event);
  const id = String(idValue);
  const index = subscriptions.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error('找不到该订阅。');
  const item = subscriptions[index];
  try {
    const data = await fetchSubscription(validWebUrl(item.url));
    const fileName = `${id}.txt`;
    const destination = path.join(SUBSCRIPTIONS_DIR, fileName);
    const temp = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, destination);
    subscriptions[index] = {
      ...item,
      updatedAt: new Date().toISOString(),
      bytes: data.length,
      fileName,
      lastError: null
    };
    persistSubscriptions();
    await reconcileProxySelection(id);
    return { subscriptions, updated: subscriptions[index] };
  } catch (error) {
    const reason = error?.message === 'TOO_LARGE'
      ? '订阅内容超过 25 MB，已停止下载。'
      : error?.message?.startsWith('HTTP_')
        ? `订阅服务器返回 HTTP ${error.message.slice(5)}。`
        : cleanError(error);
    subscriptions[index] = { ...item, lastError: reason };
    persistSubscriptions();
    throw new Error(reason);
  }
});
ipcMain.handle('subscription:reveal', (event, idValue) => {
  assertLocalRenderer(event);
  const item = subscriptions.find((entry) => entry.id === String(idValue));
  if (!item?.fileName) throw new Error('该订阅尚未拉取。');
  const file = path.join(SUBSCRIPTIONS_DIR, path.basename(item.fileName));
  if (!fs.existsSync(file)) throw new Error('本地订阅文件不存在，请重新更新。');
  shell.showItemInFolder(file);
  return true;
});

app.whenReady().then(() => {
  createTray();
  if (!globalShortcut.register('Control+Alt+M', toggleMainWindow)) {
    console.warn('Unable to register global shortcut Control+Alt+M.');
  }
  createMainWindow();
});
app.on('activate', showMainWindow);
app.on('second-instance', showMainWindow);
app.on('before-quit', () => {
  isQuitting = true;
  for (const core of proxyCores) stopProxyCore(core);
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});
