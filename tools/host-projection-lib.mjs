const SAFE_STATES = new Set(['online', 'offline', 'unknown']);

export function safeAddress(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isLoopback(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

export function publicService(service, host, result, checkedAt) {
  const status = SAFE_STATES.has(result.status) ? result.status : 'unknown';
  const baseUrl = safeAddress(service.baseUrl);
  const interfaceUrl = safeAddress(service.interfaceUrl);
  return {
    id: String(service.id),
    name: String(service.name),
    type: String(service.type || 'service'),
    host: { id: host.id, name: host.name, address: host.address || null },
    address: baseUrl,
    reachability: baseUrl ? (isLoopback(baseUrl) ? 'host-local' : 'lan') : 'unknown',
    status,
    version: service.version || null,
    capabilities: Array.isArray(service.capabilities) ? service.capabilities.map(String) : [],
    interfaceUrl: status === 'online' && interfaceUrl && !isLoopback(interfaceUrl) ? interfaceUrl : null,
    checkedAt,
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
  };
}

export async function probeService(service, fetchImpl = fetch, now = () => Date.now()) {
  const baseUrl = safeAddress(service.baseUrl);
  if (!baseUrl || typeof service.healthPath !== 'string' || !service.healthPath.startsWith('/') || service.healthPath.startsWith('//')) {
    return { status: 'unknown', latencyMs: null };
  }
  const started = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, Math.min(service.timeoutMs || 1200, 5000)));
  try {
    const response = await fetchImpl(new URL(service.healthPath, `${baseUrl}/`), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    return { status: response.ok || response.status === 405 ? 'online' : 'offline', latencyMs: Math.max(0, now() - started) };
  } catch {
    return { status: 'offline', latencyMs: Math.max(0, now() - started) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildCatalog(config, fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  const services = await Promise.all((config.services || []).map(async (service) => {
    const result = await probeService(service, fetchImpl);
    return publicService(service, config.host || { id: 'unknown', name: 'Unknown host' }, result, checkedAt);
  }));
  return { schema: 1, host: config.host || { id: 'unknown', name: 'Unknown host' }, checkedAt, services };
}
