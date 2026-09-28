import type { WorkerStateStore } from "../state/store";
import type { WorkerRecord } from "../state/models";
import { BackupManager, type BackupManagerOptions } from "./backup";
import type { BackupSnapshot, CreateSnapshotOptions, RestoreSnapshotOptions } from "./models";

/** Explicit recovery facade that keeps snapshot verification before state mutation. */
export class StateRecoveryService {
  readonly #backups: BackupManager;

  public constructor(source: WorkerStateStore, options: BackupManagerOptions) {
    this.#backups = new BackupManager(source, options);
  }

  public restore(
    snapshot: BackupSnapshot | string,
    target: WorkerStateStore,
    options: RestoreSnapshotOptions = {},
  ): WorkerRecord {
    return this.#backups.restore(snapshot, target, options);
  }

  public recover(
    snapshot: BackupSnapshot | string,
    target: WorkerStateStore,
    options: RestoreSnapshotOptions = {},
  ): WorkerRecord {
    return this.restore(snapshot, target, options);
  }

  public snapshot(workerId: string, options: CreateSnapshotOptions = {}): BackupSnapshot {
    return this.#backups.create(workerId, options);
  }

  public verify(snapshot: BackupSnapshot | string) {
    return this.#backups.verify(snapshot);
  }
}

export const RecoverySnapshotService = StateRecoveryService;
