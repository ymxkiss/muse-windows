const $ = (selector) => document.querySelector(selector);
const addressInput = $('#addressInput');
const proxySelect = $('#proxySelect');
const proxyHealth = $('#proxyHealth');
const connectionStatus = $('#connectionStatus');
const overlay = $('#managerOverlay');
const subscriptionList = $('#subscriptionList');
const toast = $('#toast');
let appState = { subscriptions: [], userAgent: '', dataDir: '', proxyNodes: [], proxyNodeId: '', navigationHidden: false };
let toastTimer;
let healthCheckToken = 0;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}
function formatDate(value) {
  if (!value) return '尚未更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未更新';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function formatBytes(bytes) {
  if (!bytes) return '';
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function safeText(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
function renderSubscriptions() {
  subscriptionList.replaceChildren();
  $('#subscriptionCount').textContent = `${appState.subscriptions.length} 条`;
  if (appState.subscriptions.length === 0) {
    subscriptionList.append(safeText('div', 'empty-state', '暂时没有订阅链接。添加链接后，可随时手动更新。'));
    return;
  }
  for (const item of appState.subscriptions) {
    const card = document.createElement('article');
    card.className = 'subscription-card';
    const info = document.createElement('div');
    info.className = 'subscription-info';
    info.append(safeText('strong', 'subscription-name', item.name));
    info.append(safeText('span', 'subscription-url', item.url));
    const updated = item.updatedAt ? `最近更新：${formatDate(item.updatedAt)}${item.bytes ? ` · ${formatBytes(item.bytes)}` : ''}` : '尚未拉取';
    info.append(safeText('span', 'subscription-meta', item.lastError || updated));
    const actions = document.createElement('div');
    actions.className = 'subscription-actions';
    const edit = safeText('button', 'small-button', '编辑');
    edit.type = 'button';
    edit.addEventListener('click', () => beginEdit(item));
    const update = safeText('button', 'small-button update-button', '更新');
    update.type = 'button';
    update.addEventListener('click', () => updateItem(item, update));
    actions.append(edit, update);
    if (item.fileName) {
      const reveal = safeText('button', 'small-button', '文件');
      reveal.type = 'button';
      reveal.title = '在文件夹中显示已下载的订阅';
      reveal.addEventListener('click', async () => {
        try { await window.museApp.revealSubscription(item.id); }
        catch (error) { showToast(error.message || '无法打开文件。', true); }
      });
      actions.append(reveal);
    }
    const remove = safeText('button', 'small-button danger-button', '删除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteItem(item));
    actions.append(remove);
    card.append(info, actions);
    subscriptionList.append(card);
  }
}
function renderProxyOptions() {
  const selectedId = appState.proxyNodeId || '';
  const direct = document.createElement('option');
  direct.value = '';
  direct.textContent = '直连（不使用代理）';
  proxySelect.replaceChildren(direct);
  const groups = new Map();
  for (const node of appState.proxyNodes || []) {
    const sourceName = node.sourceName || '订阅节点';
    if (!groups.has(sourceName)) {
      const group = document.createElement('optgroup');
      group.label = sourceName;
      groups.set(sourceName, group);
      proxySelect.append(group);
    }
    const option = document.createElement('option');
    option.value = node.id;
    option.textContent = `${node.name} · ${node.type.toUpperCase()}`;
    groups.get(sourceName).append(option);
  }
  if (!(appState.proxyNodes || []).length) {
    const empty = document.createElement('option');
    empty.disabled = true;
    empty.value = '__no_proxy_nodes__';
    empty.textContent = '暂无可用节点（请更新订阅）';
    proxySelect.append(empty);
  }
  proxySelect.value = selectedId;
  if (proxySelect.value !== selectedId) proxySelect.value = '';
}
function setFormEditMode(isEditing) {
  $('#saveSubscriptionButton').textContent = isEditing ? '保存修改' : '保存链接';
  $('#cancelEditButton').hidden = !isEditing;
}
function beginEdit(item) {
  $('#subscriptionId').value = item.id;
  $('#subscriptionName').value = item.name;
  $('#subscriptionUrl').value = item.url;
  setFormEditMode(true);
  $('#subscriptionName').focus();
}
function clearSubscriptionForm() {
  $('#subscriptionForm').reset();
  $('#subscriptionId').value = '';
  setFormEditMode(false);
}
async function refreshState() {
  appState = await window.museApp.getState();
  $('#userAgentInput').value = appState.userAgent;
  $('#dataDirectory').textContent = appState.dataDir;
  const environment = appState.environment;
  $('#environmentSummary').textContent = environment
    ? `环境 ID：${environment.id} · ${environment.locale} · ${environment.timezoneId} · ${environment.hardwareConcurrency} 线程 · ${environment.screen.width}×${environment.screen.height} · 配置：browser-environment.json`
    : '环境配置尚未就绪';
  renderSubscriptions();
  renderProxyOptions();
  setNavigationHidden(Boolean(appState.navigationHidden), false);
  await updateProxyHealth();
}
function openManager(tabName = 'subscriptionsTab') {
  overlay.hidden = false;
  window.museApp.setOverlay(true);
  switchTab(tabName);
}
function closeManager() {
  overlay.hidden = true;
  window.museApp.setOverlay(false);
}
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-content').forEach((section) => {
    section.hidden = section.id !== tabName;
  });
}
function updateLayout() {
  window.museApp.setLayout($('#chrome').getBoundingClientRect().height);
}
function setNavigationHidden(hidden, persist = true) {
  appState.navigationHidden = Boolean(hidden);
  $('#navigationForm').hidden = appState.navigationHidden;
  $('#chrome').classList.toggle('navigation-hidden', appState.navigationHidden);
  const button = $('#settingsButton');
  button.title = appState.navigationHidden ? '显示地址栏和节点栏' : '隐藏地址栏和节点栏';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!appState.navigationHidden));
  if (persist) window.museApp.setNavigationHidden(appState.navigationHidden);
  requestAnimationFrame(updateLayout);
}
async function updateProxyHealth() {
  const selectedId = appState.proxyNodeId || '';
  const token = ++healthCheckToken;
  if (!selectedId) {
    proxyHealth.textContent = '直连';
    proxyHealth.className = 'proxy-health direct';
    proxyHealth.title = '当前已使用直连';
    proxyHealth.disabled = true;
    return;
  }
  proxyHealth.textContent = '检测中…';
  proxyHealth.className = 'proxy-health checking';
  proxyHealth.title = '正在检测所选节点的连通性';
  proxyHealth.disabled = true;
  try {
    const result = await window.museApp.checkProxyHealth();
    if (token !== healthCheckToken || (appState.proxyNodeId || '') !== selectedId || result.proxyNodeId !== selectedId) return;
    if (result.ok) {
      proxyHealth.textContent = Number.isFinite(result.latencyMs) ? `正常 · ${result.latencyMs} ms` : '正常';
      proxyHealth.className = 'proxy-health healthy';
      proxyHealth.title = '节点连接正常；点击此状态可立即切换为直连';
    } else {
      proxyHealth.textContent = '不可用';
      proxyHealth.className = 'proxy-health unhealthy';
      proxyHealth.title = '节点连接失败；点击此状态可立即切换为直连';
    }
    proxyHealth.disabled = false;
  } catch {
    if (token !== healthCheckToken) return;
    proxyHealth.textContent = '检测失败';
    proxyHealth.className = 'proxy-health unhealthy';
    proxyHealth.title = '节点状态检测失败；点击此状态可立即切换为直连';
    proxyHealth.disabled = false;
  }
}
function renderMaximizeButton(maximized) {
  const button = $('#maximizeWindow');
  button.textContent = maximized ? '❐' : '□';
  button.title = maximized ? '还原' : '最大化';
  button.setAttribute('aria-label', button.title);
}

$('#subscriptionsButton').addEventListener('click', () => openManager('subscriptionsTab'));
$('#settingsButton').addEventListener('click', () => setNavigationHidden(!appState.navigationHidden));
$('#closeManager').addEventListener('click', closeManager);
$('#minimizeWindow').addEventListener('click', () => window.museApp.windowControl('minimize').catch((error) => showToast(error.message || '无法最小化窗口。', true)));
$('#maximizeWindow').addEventListener('click', () => window.museApp.windowControl('toggle-maximize').catch((error) => showToast(error.message || '无法调整窗口大小。', true)));
$('#closeWindow').addEventListener('click', () => window.museApp.windowControl('close').catch((error) => showToast(error.message || '无法关闭窗口。', true)));
$('#brandRow').addEventListener('dblclick', (event) => {
  if (!event.target.closest('button')) window.museApp.windowControl('toggle-maximize').catch(() => {});
});
proxyHealth.addEventListener('click', () => {
  if (appState.proxyNodeId) {
    proxySelect.value = '';
    proxySelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
overlay.addEventListener('click', (event) => { if (event.target === overlay) closeManager(); });
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#cancelEditButton').addEventListener('click', clearSubscriptionForm);
$('#subscriptionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await window.museApp.saveSubscription({
      id: $('#subscriptionId').value || undefined,
      name: $('#subscriptionName').value,
      url: $('#subscriptionUrl').value
    });
    appState.subscriptions = result.subscriptions;
    await refreshState();
    clearSubscriptionForm();
    showToast('订阅链接已保存。');
  } catch (error) { showToast(error.message || '保存失败。', true); }
});
async function deleteItem(item) {
  if (!window.confirm(`确定删除“${item.name}”及其本地下载文件吗？`)) return;
  try {
    const result = await window.museApp.deleteSubscription(item.id);
    appState.subscriptions = result.subscriptions;
    await refreshState();
    showToast('订阅及本地文件已删除。');
  } catch (error) { showToast(error.message || '删除失败。', true); }
}
async function updateItem(item, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '更新中…';
  try {
    const result = await window.museApp.updateSubscription(item.id);
    appState.subscriptions = result.subscriptions;
    await refreshState();
    showToast(`“${item.name}”已更新，${formatBytes(result.updated.bytes)}。`);
  } catch (error) {
    try { await refreshState(); } catch {}
    showToast(error.message || '订阅更新失败。', true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
$('#userAgentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await window.museApp.saveUserAgent($('#userAgentInput').value);
    appState.userAgent = result.userAgent;
    showToast('浏览器标识已保存，网页正在刷新。');
  } catch (error) { showToast(error.message || '保存失败。', true); }
});
$('#openDataDirectory').addEventListener('click', async () => {
  try {
    const result = await window.museApp.openDataDir();
    if (result) showToast(result, true);
  } catch (error) { showToast(error.message || '无法打开数据目录。', true); }
});
$('#navigationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  let value = addressInput.value.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const result = await window.museApp.navigate(value);
    addressInput.value = result.url;
  } catch (error) { showToast(error.message || '网址无效。', true); }
});
proxySelect.addEventListener('change', async () => {
  const previousId = appState.proxyNodeId || '';
  const selectedId = proxySelect.value;
  proxySelect.disabled = true;
  try {
    const result = await window.museApp.setProxy(selectedId);
    appState.proxyNodeId = result.proxyNodeId;
    proxySelect.value = appState.proxyNodeId;
    showToast(result.proxyNode
      ? `已切换到“${result.proxyNode.name}”，网页正在重新载入。`
      : '已启用直连（绕过代理），网页正在重新载入。');
    await updateProxyHealth();
  } catch (error) {
    proxySelect.value = previousId;
    await updateProxyHealth();
    showToast(error.message || '代理切换失败。', true);
  } finally {
    proxySelect.disabled = false;
  }
});
$('#backButton').addEventListener('click', () => window.museApp.browserCommand('back'));
$('#forwardButton').addEventListener('click', () => window.museApp.browserCommand('forward'));
$('#reloadButton').addEventListener('click', () => window.museApp.browserCommand('reload'));
$('#stopButton').addEventListener('click', () => window.museApp.browserCommand('stop'));
$('#homeButton').addEventListener('click', () => window.museApp.browserCommand('home'));
window.museApp.onBrowserState((state) => {
  if (state.url) addressInput.value = state.url;
  if (state.proxyNodeId !== undefined && state.proxyNodeId !== appState.proxyNodeId) {
    appState.proxyNodeId = state.proxyNodeId;
    proxySelect.value = appState.proxyNodeId;
  }
  connectionStatus.textContent = state.failed ? '页面暂不可用' : state.loading ? '正在载入' : state.url ? '网页已就绪' : '等待访问';
  $('#stopButton').disabled = !state.loading;
});
window.museApp.onAppReady((state) => {
  if (state.startUrl) addressInput.value = state.startUrl;
  updateLayout();
});
window.museApp.onWindowMaximized(renderMaximizeButton);
window.addEventListener('resize', updateLayout);

refreshState().catch((error) => showToast(error.message || '应用数据读取失败。', true));
requestAnimationFrame(updateLayout);
