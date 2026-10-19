export { startLitestream, startLitestreamAll, stopLitestream } from './sidecar.js'
export type { LitestreamOptions } from './config.js'
export {
  ensureService,
  registerDatabase,
  serviceStatus,
  stopService,
  unregisterDatabase,
} from './client.js'
export type { RegisterResult } from './client.js'
export type { DatabaseStatus, Health, ServiceStatus } from './serve.js'
export { restoreDatabase } from './restore.js'
export type { RestoreOptions } from './restore.js'
export { loadLitestreamEnv } from './env.js'
