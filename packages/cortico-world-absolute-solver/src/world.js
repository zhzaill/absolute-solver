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

  constructor({ cfg }) {
    this.cfg = cfg;
  }

  envPromptVars() {
    return {
      'absolute-solver.directoryUrl': directoryUrl(this.cfg),
      'absolute-solver.status': this.last.status === 'online'
        ? `${this.last.services.length} 项服务目录可读，最近检查 ${this.last.checkedAt || '未知'}`
        : this.last.error || '尚未读取服务目录',
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
    }];
  }

  console() {
    return {
      label: LABEL,
      config: [CONFIG_GROUP],
      badges: [{ label: '目录', value: directoryUrl(this.cfg) || '地址无效', tone: directoryUrl(this.cfg) ? 'on' : 'off' }],
      links: directoryUrl(this.cfg) ? [{ label: '打开局域网服务目录', href: directoryUrl(this.cfg), inheritTheme: true }] : [],
      promptDocs: [{
        key: 'worlds.absolute-solver.envPrompt',
        title: 'Absolute Solver · 环境提示',
        description: '服务目录地址和最近一次读取状态。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'absolute-solver.directoryUrl', description: '只读服务目录地址' },
          { name: 'absolute-solver.status', description: '最近一次目录读取状态' },
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
}
