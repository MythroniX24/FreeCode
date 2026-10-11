/**
 * Command module barrel.
 *
 * Each module registers its `Command`s on the passed `program`, so `index.ts`
 * stays a thin list and the whole surface is enumerable for help.
 */

export {
  buildAuthCommands,
  runLogin,
  runStatus,
  runList as runAuthList,
  runLogout,
} from './auth.js';
export { buildConfigCommands, runSet } from './config.js';
export { buildDoctorCommand, runDoctor } from './doctor.js';
export {
  buildModelCommands,
  runRefresh as runModelRefresh,
  runList as runModelList,
  runWhich,
} from './models.js';
export {
  buildProviderCommands,
  runList as runProviderList,
  runAdd,
  runCheck,
} from './providers.js';
export { buildRunCommand, runTask, makeApprover, nonInteractiveApprover } from './run.js';
