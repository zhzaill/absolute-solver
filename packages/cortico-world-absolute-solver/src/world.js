import { fileURLToPath } from 'node:url';
import { CONFIG_GROUP, DEFAULTS, ID, LABEL } from './config.js';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function directoryUrl(cfg) {
  const raw = text(cfg?.directoryUrl) || DEFAULTS.directoryUrl;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function timeoutMs(cfg) {
  const value = Number(cfg?.requestTimeoutMs);
  return Number.isFinite(value) ? Math.min(10000, Math.max(250, Math.round(value))) : DEFAULTS.requestTimeoutMs;
}

async function readJson(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('目录响应过大');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || !Array.isArray(value.services)) throw new Error('目录响应格式无效');
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function summarize(catalog) {
  const services = catalog.services.map((service) => ({
    id: String(service.id ?? ''),
    name: String(service.name ?? service.id ?? 'unknown'),
    type: String(service.type ?? 'service'),
    status: ['online', 'offline', 'unknown'].includes(service.status) ? service.status : 'unknown',
    host: service.host?.name ? String(service.host.name) : 'unknown',
    address: service.address ? String(service.address) : null,
    reachability: service.reachability ? String(service.reachability) : 'unknown',
    version: service.version ? String(service.version) : 'unknown',
    capabilities: Array.isArray(service.capabilities) ? service.capabilities.map(String).slice(0, 20) : [],
  }));
  return {
    checkedAt: catalog.checkedAt || null,
    services,
  };
}

export class AbsoluteSolverWorld {
  id = ID;
  last = { status: 'unknown', checkedAt: null, error: null, services: [] };

  constructor({ cfg, secret }) {
    this.cfg = cfg;
    this.secret = secret || (name => name === 'SOLVER_PRESENCE_TOKEN' ? process.env.SOLVER_PRESENCE_TOKEN || '' : '');
    this.access = { last: null };
    this.visit = { last: null };
    this.localOutput = { hidden: false, audioMuted: false, savedOnDesktop: null, savedAutoPlay: null, lastError: null };
  }

  envPromptVars() {
    const projectionUrl = directoryUrl(this.cfg);
    return {
      'absolute-solver.projectionUrl': projectionUrl,
      'absolute-solver.directoryUrl': projectionUrl ? `${projectionUrl}/services` : '',
      'absolute-solver.status': this.last.status === 'online'
        ? `${this.last.services.length} 项服务目录可读，最近检查 ${this.last.checkedAt || '未知'}`
        : this.last.error || '尚未读取服务目录',
      'absolute-solver.access': this.access.last
        ? `最近访问 ${this.access.last.targetService || '服务'}@${this.access.last.targetHostId || this.cfg?.targetHostId || 'unknown'}：${this.access.last.status}，到期 ${this.access.last.expiresAtMs || 'unknown'}`
        : '当前没有已知的一次性访问请求。',
      'absolute-solver.environment': this.visit.last
        ? JSON.stringify(this.visit.last)
        : '尚未读取投影环境。',
    };
  }

  tools() {
    return [{
      name: 'solver_services',
      tags: ['read'],
      description: '读取 Absolute Solver 局域网服务目录的最新只读快照，返回 Cortico、Coo、ASR、LLM、TTS 等服务的实际在线状态、Host、地址、版本和能力。不会授予权限、执行动作或传输音频。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      handler: async () => this.readServices(),
    }, {
      name: 'solver_request_access',
      tags: ['act'],
      description: '向目标 Host 请求一次 TTS 或 ASR 网络访问许可。只提出请求，不提供凭据、不执行插件；需要目标机器本地用户确认。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        targetService: { type: 'string', enum: ['tts', 'asr'] },
        purpose: { type: 'string', maxLength: 240 },
        environmentId: { type: 'string', maxLength: 96 },
        ttlMs: { type: 'number', minimum: 1000, maximum: 120000 },
      }, required: ['targetService', 'purpose'] },
      handler: async (args) => this.requestAccess(args),
    }, {
      name: 'solver_access_status',
      tags: ['read'],
      description: '读取一次性访问许可的事实状态；不会返回 grant token。',
      parameters: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string', maxLength: 96 } }, required: ['requestId'] },
      handler: async ({ requestId }) => this.accessStatus(requestId),
    }, {
      name: 'solver_request_visit',
      tags: ['act'],
      description: '申请将当前 Coo 原生桌宠投影到已配置的目标 Host；目标 Host 本地确认后才会启动投影。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        purpose: { type: 'string', maxLength: 240 },
        environmentId: { type: 'string', maxLength: 96 },
        ttlMs: { type: 'number', minimum: 1000, maximum: 120000 },
      }, required: ['purpose'] },
      handler: async (args) => this.requestVisit(args),
    }, {
      name: 'solver_return_visit',
      tags: ['act'],
      description: '结束当前投影租约并请求 Coo 返回本机。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        visitId: { type: 'string', maxLength: 96 },
      } },
      handler: async (args) => this.returnVisit(args),
    }, {
      name: 'solver_environment',
      tags: ['read'],
      description: '读取当前 Coo 所在位置、投影租约、目标 Host 在线状态和最近一次服务目录快照。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.readEnvironment(),
    }];
  }

  webUi() {
    const projectionUrl = directoryUrl(this.cfg);
    return {
      label: LABEL,
      config: [CONFIG_GROUP],
      badges: [{ label: '投影网页', value: projectionUrl || '地址无效', tone: projectionUrl ? 'on' : 'off' }],
      links: projectionUrl ? [
        { label: '打开当前投影网页', href: projectionUrl, inheritTheme: true },
        { label: '打开服务目录', href: `${projectionUrl}/services`, inheritTheme: true },
      ] : [],
      promptDocs: [{
        key: 'worlds.absolute-solver.envPrompt',
        title: 'Absolute Solver · 投影与使用说明',
        description: '当前投影网页、服务目录地址、使用方式和最近一次目录状态。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'absolute-solver.projectionUrl', description: '当前 Coo 桌宠投影网页；可在同一可信 LAN 浏览器打开' },
          { name: 'absolute-solver.directoryUrl', description: '只读服务目录地址' },
          { name: 'absolute-solver.status', description: '最近一次目录读取状态' },
          { name: 'absolute-solver.access', description: '最近一次许可状态与过期时间' },
          { name: 'absolute-solver.environment', description: '当前 Coo 位置、投影、音频输出和目标 Host 事实' },
        ],
      }],
    };
  }

  async start() {
    await this.readServices();
  }

  async stop() {}

  async readServices() {
    const url = directoryUrl(this.cfg);
    if (!url) {
      this.last = { status: 'unknown', checkedAt: null, error: '服务目录地址无效', services: [] };
      return { text: this.last.error, failed: true };
    }
    try {
      const catalog = await readJson(`${url}/api/services`, timeoutMs(this.cfg));
      const summary = summarize(catalog);
      this.last = { status: 'online', checkedAt: summary.checkedAt, error: null, services: summary.services };
      return { text: JSON.stringify({ directoryUrl: url, ...summary }, null, 2) };
    } catch (error) {
      this.last = { status: 'offline', checkedAt: null, error: error instanceof Error ? error.message : String(error), services: [] };
      return { text: `Absolute Solver 服务目录不可读：${this.last.error}`, failed: true };
    }
  }

  accessConfig() {
    const hub = text(this.cfg?.accessHubUrl);
    const host = text(this.cfg?.targetHostId);
    const secretName = text(this.cfg?.accessTokenSecret) || DEFAULTS.accessTokenSecret;
    let token = '';
    try { token = text(this.secret(secretName)); } catch { token = ''; }
    let broker = '';
    let brokerToken = '';
    try {
      const parsed = new URL(text(this.cfg?.accessBrokerUrl));
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        broker = parsed.toString().replace(/\/$/, '');
      }
    } catch { broker = ''; }
    try { brokerToken = text(this.secret(text(this.cfg?.accessBrokerTokenSecret) || DEFAULTS.accessBrokerTokenSecret)); } catch { brokerToken = ''; }
    try { const parsed = new URL(hub); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('访问 Hub 地址无效'); return { hub: hub.replace(/\/$/, ''), host, token, broker, brokerToken }; } catch { return { hub: '', host, token, broker, brokerToken }; }
  }

  projectionConfig() {
    const rawHub = text(this.cfg?.projectionHubUrl) || text(this.cfg?.accessHubUrl);
    const host = text(this.cfg?.projectionTargetHostId) || text(this.cfg?.targetHostId);
    const source = text(this.cfg?.projectionSourceInstance) || 'coo-local';
    let hub = '';
    let token = '';
    try {
      const parsed = new URL(rawHub);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && ['/', ''].includes(parsed.pathname)) hub = parsed.toString().replace(/\/$/, '');
    } catch { hub = ''; }
    try { token = text(this.secret(text(this.cfg?.projectionTokenSecret) || DEFAULTS.projectionTokenSecret)); } catch { token = ''; }
    return { hub, host, source, token };
  }

  corticoWebUiUrl() {
    const raw = text(this.cfg?.corticoWebUiUrl) || DEFAULTS.corticoWebUiUrl;
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) return '';
      return parsed.toString().replace(/\/$/, '');
    } catch { return ''; }
  }

  async invokeCortico(provider, panel, method, args = []) {
    const base = this.corticoWebUiUrl();
    if (!base) throw new Error('本机 Cortico WebUI 地址无效');
    const endpoint = `${base}/api/webui/providers/${encodeURIComponent(provider)}/panels/${encodeURIComponent(panel)}/${encodeURIComponent(method)}`;
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs(this.cfg)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Cortico ${provider}.${panel}.${method} HTTP ${response.status}`);
    return data;
  }

  async setAudioAutoPlay(value) {
    const base = this.corticoWebUiUrl();
    if (!base) throw new Error('本机 Cortico WebUI 地址无效');
    const response = await fetch(`${base}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: 'world:audio-play', values: { 'worlds.audio-play.autoPlay': value } }),
      signal: AbortSignal.timeout(timeoutMs(this.cfg)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`本机音频策略 HTTP ${response.status}`);
    return data;
  }

  async readAudioAutoPlay() {
    const base = this.corticoWebUiUrl();
    if (!base) throw new Error('本机 Cortico WebUI 地址无效');
    const response = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(timeoutMs(this.cfg)) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`本机音频配置 HTTP ${response.status}`);
    const group = Array.isArray(data.groups) ? data.groups.find(item => item?.group?.id === 'world:audio-play') : null;
    return group?.values?.['worlds.audio-play.autoPlay'] !== false;
  }

  async syncLocalOutput(location) {
    const desiredRemote = location === 'remote';
    if (desiredRemote === this.localOutput.hidden && desiredRemote === this.localOutput.audioMuted && (!desiredRemote || this.localOutput.savedOnDesktop !== null)) return { ...this.localOutput };
    try {
      if (desiredRemote) {
        if (this.localOutput.savedOnDesktop === null) {
          const state = await this.invokeCortico('world:desktop-pet', 'pet', 'state');
          this.localOutput.savedOnDesktop = state?.onDesktop === true;
        }
        if (this.localOutput.savedAutoPlay === null) this.localOutput.savedAutoPlay = await this.readAudioAutoPlay();
        if (this.localOutput.savedOnDesktop) await this.invokeCortico('world:desktop-pet', 'pet', 'hideWindow');
        await this.setAudioAutoPlay(false);
        try { await this.invokeCortico('world:audio-play', 'queue', 'clear'); } catch { /* no current item is a valid clear result */ }
        this.localOutput.hidden = true;
        this.localOutput.audioMuted = true;
        this.localOutput.lastError = null;
      } else {
        const wasOnDesktop = this.localOutput.savedOnDesktop;
        const wasAutoPlay = this.localOutput.savedAutoPlay;
        if (wasOnDesktop) await this.invokeCortico('world:desktop-pet', 'pet', 'openWindow');
        if (wasAutoPlay !== null) await this.setAudioAutoPlay(wasAutoPlay);
        this.localOutput.hidden = wasOnDesktop === false;
        this.localOutput.audioMuted = wasAutoPlay === false;
        this.localOutput.savedOnDesktop = null;
        this.localOutput.savedAutoPlay = null;
        this.localOutput.lastError = null;
      }
    } catch (error) {
      this.localOutput.lastError = error instanceof Error ? error.message : String(error);
    }
    return { ...this.localOutput };
  }

  async requestVisit(args = {}) {
    const cfg = this.projectionConfig();
    const purpose = text(args.purpose);
    if (!cfg.hub || !cfg.host || !cfg.source || !cfg.token) return { failed: true, text: '投影许可未配置：需要 Hub、来源实例、目标 Host 和 secret。' };
    if (!purpose || purpose.length > 240) return { failed: true, text: '串门原因无效。' };
    const visitId = `coo-visit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const response = await fetch(`${cfg.hub}/projection/visit/request`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ visit_id: visitId, source_instance: cfg.source, purpose, target_host_id: cfg.host, projection_id: 'coo-pet', display_anchor: 'bottom', audio_mode: 'remote_active', environment_id: text(args.environmentId) || null, ttl_ms: Math.min(120000, Math.max(1000, Number(args.ttlMs) || 60000)) }),
        signal: AbortSignal.timeout(timeoutMs(this.cfg)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { failed: true, text: `串门请求失败：${data.error || `HTTP ${response.status}`}` };
      this.visit.last = { visitId: data.visit_id, status: data.status, currentLocation: 'local', targetHostId: cfg.host, expiresAtMs: data.expires_at_ms, lastTransition: 'requesting' };
      return { visitId: data.visit_id, status: data.status, targetHostId: cfg.host, expiresAtMs: data.expires_at_ms, text: '已向目标 Host 发出串门请求，等待该机器本地确认。' };
    } catch (error) {
      return { failed: true, text: `串门请求未送达：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async returnVisit(args = {}) {
    const cfg = this.projectionConfig();
    const visitId = text(args.visitId) || text(this.visit.last?.visitId);
    if (!cfg.hub || !cfg.token || !visitId) return { failed: true, text: '没有可结束的投影租约。' };
    try {
      const response = await fetch(`${cfg.hub}/projection/visit/return`, {
        method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ visit_id: visitId, source_instance: cfg.source, reason: 'persona_return' }),
        signal: AbortSignal.timeout(timeoutMs(this.cfg)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { failed: true, text: `返回请求失败：${data.error || `HTTP ${response.status}`}` };
      this.visit.last = { ...this.visit.last, visitId, status: 'returning', lastTransition: 'return_requested' };
      return { visitId, status: 'returning', text: '已请求结束投影；本机恢复以 Host 回报为准。' };
    } catch (error) {
      return { failed: true, text: `返回请求未送达：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async readEnvironment() {
    const cfg = this.projectionConfig();
    if (!cfg.hub || !cfg.token || !cfg.host) return { failed: true, text: '投影环境读取未配置。' };
    const headers = { authorization: `Bearer ${cfg.token}` };
    try {
      const [visitResponse, hostResponse] = await Promise.all([
        fetch(`${cfg.hub}/projection/visit/current?source_instance=${encodeURIComponent(cfg.source)}`, { headers, signal: AbortSignal.timeout(timeoutMs(this.cfg)) }),
        fetch(`${cfg.hub}/projection/host/state/${encodeURIComponent(cfg.host)}`, { headers, signal: AbortSignal.timeout(timeoutMs(this.cfg)) }),
      ]);
      const [visit, host] = await Promise.all([visitResponse.json(), hostResponse.json()]);
      if (!visitResponse.ok || !hostResponse.ok) throw new Error(visit.error || host.error || 'Hub 状态不可读');
      const environment = {
        current_location: visit.current_location || 'local',
        current_host_id: visit.current_location === 'remote' ? cfg.host : null,
        projection_status: visit.projection_status || visit.status || 'disconnected',
        display_anchor: visit.display_anchor || null,
        audio_output: visit.audio_output || 'local',
        visit_id: visit.visit_id || null,
        lease_expires_at: visit.expires_at_ms || null,
        last_transition: visit.last_transition || null,
        target_host: { host_id: host.host_id, online: host.online === true, projection_capable: host.projection_capable === true, projection_status: host.projection_status || 'disconnected' },
        projection_url: directoryUrl(this.cfg),
        services: this.last.services,
        services_checked_at: this.last.checkedAt,
        last_access: this.access.last,
        local_output: await this.syncLocalOutput(visit.current_location === 'remote' ? 'remote' : 'local'),
      };
      this.visit.last = environment;
      return environment;
    } catch (error) {
      return { failed: true, text: `投影环境不可读：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Tell the Coo-side broker that this exact request id may be spent.
   *
   * `cortico-world-tts` cannot attach a request id to the call it makes, so the
   * association has to be made here, at the only place that knows both the
   * approval and the route. If this registration fails we must not report a
   * usable approval to the model: a permission the tool cannot map to a call is
   * not a permission, it is a dangling grant that will expire confusingly.
   */
  async registerApproval({ requestId, service, expiresAtMs }) {
    const cfg = this.accessConfig();
    if (!cfg.broker) return { registered: false, reason: 'broker_not_configured' };
    if (!cfg.brokerToken) return { registered: false, reason: 'broker_secret_missing' };
    try {
      const response = await fetch(`${cfg.broker}/solver/approvals`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.brokerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, service, hostId: cfg.host, expiresAtMs }),
        signal: AbortSignal.timeout(timeoutMs(this.cfg)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { registered: false, reason: text(data.error) || `HTTP ${response.status}` };
      return { registered: true };
    } catch (error) {
      return { registered: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async requestAccess(args = {}) {
    const cfg = this.accessConfig();
    if (!cfg.hub || !cfg.host || !cfg.token) return { failed: true, text: '访问许可未配置：需要 Hub 地址、目标 Host 和 secret。' };
    const service = args.targetService === 'asr' ? 'asr' : args.targetService === 'tts' ? 'tts' : '';
    const purpose = text(args.purpose);
    if (!service || !purpose || purpose.length > 240) return { failed: true, text: '访问服务或原因无效。' };
    const requestId = `coo-access-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await fetch(`${cfg.hub}/access/request`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: requestId, source_instance: 'cortico', target_host_id: cfg.host, target_service: service, operation: service === 'tts' ? 'speech.synthesize' : 'audio.transcribe', purpose, environment_id: text(args.environmentId) || null, ttl_ms: Math.min(120000, Math.max(1000, Number(args.ttlMs) || 30000)) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { failed: true, text: `访问许可请求失败：${data.error || `HTTP ${response.status}`}` };
    const registration = await this.registerApproval({ requestId: data.request_id, service, expiresAtMs: data.expires_at_ms });
    this.access.last = { requestId: data.request_id, status: 'pending', spendable: registration.registered };
    if (!registration.registered) {
      // Leave the Hub request pending on purpose: it will expire on its own and
      // the operator is never asked to approve something that cannot be spent.
      return { requestId: data.request_id, status: 'pending', spendable: false, failed: true, text: `已向目标 Host 发出请求，但本机适配层未能登记该许可（${registration.reason}），因此它不会被使用；到期后自动失效。` };
    }
    return { requestId: data.request_id, status: 'pending', spendable: true, expiresAtMs: data.expires_at_ms, text: '已向目标 Host 发出一次访问请求，等待本地确认；确认后本机插件即可使用这一次。' };
  }

  async accessStatus(requestId) {
    const cfg = this.accessConfig();
    if (!cfg.hub || !cfg.token || !text(requestId)) return { failed: true, text: '访问许可状态未配置。' };
    const response = await fetch(`${cfg.hub}/access/state/${encodeURIComponent(text(requestId))}`, { headers: { authorization: `Bearer ${cfg.token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { failed: true, text: `访问许可状态不可读：${data.error || `HTTP ${response.status}`}` };
    const result = { requestId: data.request_id, status: data.status, targetHostId: data.target_host_id, targetService: data.target_service, operation: data.operation, expiresAtMs: data.expires_at_ms };
    this.access.last = result;
    return result;
  }
}
