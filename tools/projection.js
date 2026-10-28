const statusNames = { online: '在线', offline: '离线', unknown: '未知' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function refresh() {
  const indicator = document.getElementById('refresh-state');
  try {
    const response = await fetch('/api/services', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    document.getElementById('host-name').textContent = catalog.host?.name || '未知 Host';
    document.getElementById('host-address').textContent = catalog.host?.address || 'LAN 地址未配置';
    document.getElementById('updated-at').textContent = `检查时间：${new Date(catalog.checkedAt).toLocaleTimeString()}`;
    document.getElementById('services').innerHTML = catalog.services.map((service) => {
      const status = statusNames[service.status] || statusNames.unknown;
      const capabilities = (service.capabilities || []).map(escapeHtml).join('、') || '未知';
      const link = service.interfaceUrl
        ? `<a href="${escapeHtml(service.interfaceUrl)}" target="_blank" rel="noreferrer">打开原服务</a>`
        : '<span class="subtle">无 LAN 投影入口</span>';
      const reachability = service.reachability === 'host-local' ? '仅 Host 本机可达' : service.reachability === 'lan' ? 'LAN 地址' : '可达范围未知';
      return `<tr><td><span class="service-name">${escapeHtml(service.name)}</span><span class="subtle">${escapeHtml(service.type)} · ${escapeHtml(service.id)}</span></td><td>${escapeHtml(service.host?.name)}<span class="subtle">${escapeHtml(service.address || '地址未知')}</span><span class="subtle">${reachability}</span></td><td><span class="state ${escapeHtml(service.status)}">${status}</span><span class="subtle">${service.latencyMs == null ? '无响应耗时' : `${service.latencyMs} ms`}</span></td><td>${escapeHtml(service.version || '未知')}</td><td>${capabilities}</td><td>${link}</td></tr>`;
    }).join('') || '<tr><td colspan="6">没有配置服务</td></tr>';
    indicator.textContent = '状态已更新';
  } catch (error) {
    indicator.textContent = `目录暂不可用：${error.message}`;
  }
}

refresh();
setInterval(refresh, 5000);
