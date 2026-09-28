import type { WorkerRecord, WorkerState, WorkerTransition } from "../state/models";

export const BACKUP_FORMAT = "agent-farm.worker-snapshot" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;
export const BACKUP_INTEGRITY_ALGORITHM = "sha256" as const;

/** A key is supplied by the host; this package never reads credentials or environment variables. */
export interface SnapshotKeyPort {
  keyFor(snapshotId: string): Uint8Array;
}

/** Injectable authenticated encryption seam used by backup and restore. */
export interface SnapshotEncryptionPort {
  readonly algorithm: string;
  encrypt(input: Uint8Array, key: Uint8Array, associatedData: Uint8Array): SnapshotCiphertext;
  decrypt(input: SnapshotCiphertext, key: Uint8Array, associatedData: Uint8Array): Uint8Array;
}

export interface SnapshotCiphertext {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface SnapshotRetentionMetadata {
  /** A snapshot must not be deleted before this instant. */
  readonly retainUntil: string;
  /** Known-good snapshots are protected from automated deletion. */
  readonly knownGood: boolean;
  readonly deletionProtected: boolean;
}

/** Only redacted operational state is included in an encrypted snapshot. */
export interface RedactedWorkerSnapshot {
  readonly workerId: string;
  readonly issueIdentifier?: string;
  readonly project?: string;
  readonly repository?: string;
  readonly mappingVersion?: string;
  readonly state: WorkerState;
  readonly reason?: string;
  readonly branch?: string;
  readonly baseCommit?: string;
  readonly commitSha?: string;
  readonly imageDigest?: string;
  readonly pullRequestNumber?: number;
  readonly correlationId?: string;
  readonly snapshotId?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTransitionAt: string;
}

export interface RedactedTransitionSnapshot {
  readonly id: number;
  readonly workerId: string;
  readonly fromState: WorkerState | null;
  readonly toState: WorkerState;
  readonly actor: string;
  readonly reason?: string;
  readonly occurredAt: string;
}

export interface SnapshotPayload {
  readonly redacted: true;
  readonly worker: RedactedWorkerSnapshot;
  readonly history: readonly RedactedTransitionSnapshot[];
}

/** JSON-safe encrypted snapshot envelope. The payload and all metadata are integrity checked. */
export interface BackupSnapshot {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_FORMAT_VERSION;
  readonly schemaVersion: number;
  readonly snapshotId: string;
  readonly workerId: string;
  readonly createdAt: string;
  readonly retention: SnapshotRetentionMetadata;
  readonly encryption: SnapshotCiphertext & { readonly algorithm: string };
  readonly integrity: {
    readonly algorithm: typeof BACKUP_INTEGRITY_ALGORITHM;
    readonly digest: string;
  };
}

export interface CreateSnapshotOptions {
  readonly snapshotId?: string;
  readonly createdAt?: string | Date;
  readonly retentionDays?: number;
  readonly retainUntil?: string | Date;
  readonly knownGood?: boolean;
}

export interface RestoreSnapshotOptions {
  readonly actor?: string;
}

export interface SnapshotVerification {
  readonly snapshotId: string;
  readonly workerId: string;
  readonly schemaVersion: number;
  readonly payload: SnapshotPayload;
}

export class BackupError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "BackupError";
  }
}

export class SnapshotIntegrityError extends BackupError {
  public constructor(message = "snapshot integrity check failed") {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

export class SnapshotVersionError extends BackupError {
  public constructor(message: string) {
    super(message);
    this.name = "SnapshotVersionError";
  }
}

export class SnapshotRestoreError extends BackupError {
  public constructor(message: string) {
    super(message);
    this.name = "SnapshotRestoreError";
  }
}

export interface SnapshotWorkerSource {
  readonly schemaVersion: number;
  get(workerId: string): WorkerRecord | undefined;
  history(workerId: string): readonly WorkerTransition[];
}
