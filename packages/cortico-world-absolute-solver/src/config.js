export const ID = 'absolute-solver';
export const LABEL = 'Absolute Solver 服务目录';

export const DEFAULTS = {
  enabled: false,
  directoryUrl: 'http://127.0.0.1:18111',
  requestTimeoutMs: 3000,
  accessHubUrl: '',
  targetHostId: '',
  accessTokenSecret: 'SOLVER_PRESENCE_TOKEN',
  accessBrokerUrl: '',
  accessBrokerTokenSecret: 'SOLVER_BROKER_TOKEN',
};

export const CONFIG_GROUP = {
  id: 'world:absolute-solver',
  owner: 'world:absolute-solver',
  schema: {
    type: 'object',
    title: 'Absolute Solver',
    description: '局域网服务目录地址与只读探测设置。',
    properties: {
      'worlds.absolute-solver.directoryUrl': {
        type: 'string',
        title: '服务目录地址',
        description: '填写 Host 投影服务根地址，例如 http://192.168.1.178:18111；根路径是 Coo 桌宠投影页，/services 是只读服务目录。',
        format: 'uri',
        'x-hot': true,
      },
      'worlds.absolute-solver.requestTimeoutMs': {
        type: 'number',
        title: '探测超时（毫秒）',
        description: '读取目录状态的最大等待时间。',
        minimum: 250,
        maximum: 10000,
        'x-hot': true,
      },
      'worlds.absolute-solver.accessHubUrl': { type: 'string', title: '访问许可 Hub 地址', description: '仅用于一次性 TTS/ASR 访问请求；密钥从 Cortico secret 读取。', format: 'uri', 'x-hot': true },
      'worlds.absolute-solver.targetHostId': { type: 'string', title: '目标 Host', description: '已接入并在线的目标机器 Host ID。', 'x-hot': true },
      'worlds.absolute-solver.accessTokenSecret': { type: 'string', title: '许可密钥名称', description: '从 Cortico secret 读取的 Hub 访问密钥名称。', 'x-hot': true },
      'worlds.absolute-solver.accessBrokerUrl': { type: 'string', title: '本机许可登记地址', description: 'Coo 侧适配层地址，例如 http://127.0.0.1:18081。Coo TTS 插件的 baseUrl 指向这里；请求获批后由该适配层把这一次许可与插件调用关联。留空则不登记，许可不可用。', format: 'uri', 'x-hot': true },
      'worlds.absolute-solver.accessBrokerTokenSecret': { type: 'string', title: '登记密钥名称', description: '从 Cortico secret 读取的本地适配层密钥名称。', 'x-hot': true },
    },
  },
};
