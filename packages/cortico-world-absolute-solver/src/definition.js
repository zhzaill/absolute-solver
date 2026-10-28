import { DEFAULTS, ID, LABEL } from './config.js';
import { AbsoluteSolverWorld } from './world.js';

export const ABSOLUTE_SOLVER = {
  id: ID,
  label: LABEL,
  defaults: () => structuredClone(DEFAULTS),
  preflight: ({ cfg }) => {
    if (!cfg.directoryUrl) throw new Error('Absolute Solver 服务目录地址为空');
  },
  create: (ctx) => new AbsoluteSolverWorld({ cfg: ctx.cfg }),
};

export default ABSOLUTE_SOLVER;
