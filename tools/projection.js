const statusNames = { online: '在线', offline: '离线', unknown: '未知' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const byId = (id) => document.getElementById(id);
const state = { catalog: null, petLoaded: false, chatLoaded: false };

function showView(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  if (name === 'pet' && !state.petLoaded) {
    byId('pet-frame').src = '/coo/pet';
    state.petLoaded = true;
  }
  if (name === 'chat' && !state.chatLoaded) {
    byId('chat-frame').src = '/hub/app';
    state.chatLoaded = true;
  }
}

function renderCatalog(catalog) {
  state.catalog = catalog;
  const host = catalog.host || {};
  byId('host-label').textContent = `${host.name || '未知 Host'} · ${host.address || '地址未知'}`;
  byId('host-label').previousElementSibling.classList.add('online');
  byId('updated-at').textContent = `检查时间：${new Date(catalog.checkedAt).toLocaleTimeString()}`;
  byId('services').innerHTML = (catalog.services || []).map((service) => {
    const status = statusNames[service.status] || statusNames.unknown;
    const capabilities = (service.capabilities || []).map(escapeHtml).join('、') || '未知';
    const link = service.interfaceUrl
      ? `<a href="${escapeHtml(service.interfaceUrl)}" target="_blank" rel="noreferrer">打开原服务</a>`
      : '<span class="subtle">由桌宠 / 对话视图提供</span>';
    const reachability = service.reachability === 'host-local' ? '仅 Host 本机可达' : service.reachability === 'lan' ? 'LAN 地址' : '可达范围未知';
    return `<tr><td><span class="service-name">${escapeHtml(service.name)}</span><span class="subtle">${escapeHtml(service.type)} · ${escapeHtml(service.id)}</span></td><td>${escapeHtml(service.host?.name)}<span class="subtle">${escapeHtml(service.address || '地址未知')}</span><span class="subtle">${reachability}</span></td><td><span class="state ${escapeHtml(service.status)}">${status}</span><span class="subtle">${service.latencyMs == null ? '无响应耗时' : `${service.latencyMs} ms`}</span></td><td>${escapeHtml(service.version || '未知')}</td><td>${capabilities}</td><td>${link}</td></tr>`;
  }).join('') || '<tr><td colspan="6">没有配置服务</td></tr>';
  byId('refresh-state').textContent = '状态已更新';
  byId('pet-state').textContent = (catalog.services || []).find((service) => service.id === 'cortico-world')?.status === 'online' ? '原 Coo renderer 观察入口' : 'Coo World 当前不可达';
}

async function refresh() {
  try {
    const response = await fetch('/api/services', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderCatalog(await response.json());
  } catch (error) {
    byId('refresh-state').textContent = `目录暂不可用：${error.message}`;
    byId('host-label').textContent = 'Host 不可达';
    byId('host-label').previousElementSibling.classList.remove('online');
  }
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
byId('refresh').addEventListener('click', refresh);
byId('pet-frame').addEventListener('load', () => { byId('pet-state').textContent = 'Coo 原 renderer 已载入，网页连接为观察模式'; });
byId('pet-frame').addEventListener('error', () => { byId('pet-state').textContent = 'Coo 页面暂不可用'; });
refresh();
setInterval(refresh, 5000);
