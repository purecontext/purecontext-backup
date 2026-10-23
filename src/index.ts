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
export type { SnapshotsSummary } from './serve.js'
export type { Keep, RestoreCheck, SnapshotFile, SnapshotStatus } from './snapshot.js'
export { selectKept, verifyDatabase } from './snapshot.js'
export { backupProblems, readStatusFile } from './status-file.js'
export type { BackupProblems, StatusFile } from './status-file.js'
