export const ID = 'absolute-solver';
export const LABEL = 'Absolute Solver 服务目录';

export const DEFAULTS = {
  enabled: false,
  directoryUrl: 'http://127.0.0.1:18110',
  requestTimeoutMs: 3000,
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
        description: '例如 http://192.168.1.178:18110；只读目录，不是 Hub 控制入口。',
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
    },
  },
};
