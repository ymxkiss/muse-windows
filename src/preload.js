const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('museApp', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  addTab: (name) => ipcRenderer.invoke('tabs:add', name),
  activateTab: (id) => ipcRenderer.invoke('tabs:activate', id),
  renameTab: (id, name) => ipcRenderer.invoke('tabs:rename', { id, name }),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  setProxy: (nodeId) => ipcRenderer.invoke('browser:set-proxy', nodeId),
  setRightClickDisabled: (disabled) => ipcRenderer.invoke('browser:set-right-click-disabled', disabled),
  checkProxyHealth: () => ipcRenderer.invoke('browser:check-proxy-health'),
  browserCommand: (command) => ipcRenderer.invoke('browser:command', command),
  windowControl: (command) => ipcRenderer.invoke('window:control', command),
  saveUserAgent: (value) => ipcRenderer.invoke('app:save-user-agent', value),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  setLayout: (height) => ipcRenderer.send('ui:layout', height),
  setNavigationHidden: (hidden) => ipcRenderer.send('ui:navigation-hidden', hidden),
  setOverlay: (visible) => ipcRenderer.send('ui:overlay', visible),
  saveSubscription: (input) => ipcRenderer.invoke('subscription:save', input),
  deleteSubscription: (id) => ipcRenderer.invoke('subscription:delete', id),
  updateSubscription: (id) => ipcRenderer.invoke('subscription:update', id),
  revealSubscription: (id) => ipcRenderer.invoke('subscription:reveal', id),
  onAppReady: (callback) => ipcRenderer.on('app:ready', (_event, state) => callback(state)),
  onWindowMaximized: (callback) => ipcRenderer.on('window:maximized', (_event, maximized) => callback(maximized)),
  onBrowserState: (callback) => ipcRenderer.on('browser:state', (_event, state) => callback(state)),
  onActiveTab: (callback) => ipcRenderer.on('tabs:active', (_event, tab) => callback(tab))
});
