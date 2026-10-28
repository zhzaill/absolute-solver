const statusNames = { online: '在线', offline: '离线', unknown: '未知' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const byId = (id) => document.getElementById(id);

function renderCatalog(catalog) {
  const host = catalog.host || {};
  byId('host-label').textContent = `${host.name || host.id || 'Host'} · ${host.address || '本机'}`;
  byId('services').innerHTML = (catalog.services || []).map((service) => `<tr>
    <td><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.type)}</small></td>
    <td><code>${escapeHtml(service.address || 'unknown')}</code><small>${escapeHtml(service.reachability)}</small></td>
    <td><span class="status ${escapeHtml(service.status)}">${escapeHtml(statusNames[service.status] || service.status)}</span><small>${service.latencyMs == null ? '' : `${service.latencyMs} ms`}</small></td>
    <td>${escapeHtml(service.version || 'unknown')}</td>
    <td>${(service.capabilities || []).map(escapeHtml).join(' · ')}</td>
    <td>${service.interfaceUrl ? `<a href="${escapeHtml(service.interfaceUrl)}" target="_blank" rel="noreferrer">打开</a>` : 'Host 内部'}</td>
  </tr>`).join('') || '<tr><td colspan="6">没有配置服务</td></tr>';
  byId('refresh-state').textContent = `更新于 ${new Date(catalog.checkedAt || Date.now()).toLocaleTimeString()}`;
}

async function refresh() {
  try {
    const response = await fetch('/api/services', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderCatalog(await response.json());
  } catch (error) {
    byId('refresh-state').textContent = `服务目录不可用：${error.message}`;
  }
}

byId('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 5000);
