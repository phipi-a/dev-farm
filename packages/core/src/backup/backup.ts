import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { WorkerStateStore } from "../state/store";
import {
  isWorkerState,
  type WorkerInput,
  type WorkerRecord,
  type WorkerTransition,
} from "../state/models";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_INTEGRITY_ALGORITHM,
  BackupError,
  SnapshotIntegrityError,
  SnapshotRestoreError,
  SnapshotVersionError,
  type BackupSnapshot,
  type CreateSnapshotOptions,
  type RedactedTransitionSnapshot,
  type RedactedWorkerSnapshot,
  type SnapshotCiphertext,
  type SnapshotEncryptionPort,
  type SnapshotKeyPort,
  type SnapshotPayload,
  type SnapshotVerification,
  type RestoreSnapshotOptions,
  type SnapshotRetentionMetadata,
} from "./models";

const DEFAULT_RETENTION_DAYS = 30;
const AES_GCM_ALGORITHM = "aes-256-gcm";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  // Snapshots intentionally contain no raw diagnostic output or credential-shaped values.
  return value
    .replace(
      /(bearer\s+|password\s*[=:]\s*|token\s*[=:]\s*|secret\s*[=:]\s*|api[_-]?key\s*[=:]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:gh[ps]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9-]+)\b/g,
      "[REDACTED]",
    );
}

function iso(value: string | Date | undefined, field: string): string {
  const result = value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString());
  if (typeof result !== "string" || Number.isNaN(Date.parse(result)))
    throw new BackupError(`${field} must be a valid timestamp`);
  return result;
}

function positiveInteger(value: number | undefined, field: string): number {
  const result = value ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new BackupError(`${field} must be a positive integer`);
  return result;
}

/** Stable JSON is used for integrity input and associated data. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function associatedData(
  snapshot: Pick<BackupSnapshot, "format" | "version" | "snapshotId" | "workerId">,
): Uint8Array {
  return bytes(
    stable({
      format: snapshot.format,
      version: snapshot.version,
      snapshotId: snapshot.snapshotId,
      workerId: snapshot.workerId,
    }),
  );
}

function withoutIntegrity(snapshot: BackupSnapshot): Omit<BackupSnapshot, "integrity"> {
  const { integrity: _integrity, ...unsigned } = snapshot;
  return unsigned;
}

function digest(snapshot: Omit<BackupSnapshot, "integrity">): string {
  return createHash("sha256").update(stable(snapshot)).digest("hex");
}

function redactedWorker(worker: WorkerRecord): RedactedWorkerSnapshot {
  return {
    workerId: worker.workerId,
    issueIdentifier: text(worker.issueIdentifier),
    project: text(worker.project),
    repository: text(worker.repository),
    mappingVersion: text(worker.mappingVersion),
    state: worker.state,
    reason: text(worker.reason),
    branch: text(worker.branch),
    baseCommit: text(worker.baseCommit),
    commitSha: text(worker.commitSha),
    imageDigest: text(worker.imageDigest),
    pullRequestNumber: worker.pullRequestNumber,
    correlationId: text(worker.correlationId),
    snapshotId: text(worker.snapshotId),
    lastError: text(worker.lastError),
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
    lastTransitionAt: worker.lastTransitionAt,
  };
}

function redactedTransition(transition: WorkerTransition): RedactedTransitionSnapshot {
  return {
    id: transition.id,
    workerId: transition.workerId,
    fromState: transition.fromState,
    toState: transition.toState,
    actor: text(transition.actor) ?? "unknown",
    reason: text(transition.reason),
    occurredAt: transition.occurredAt,
  };
}

function parseSnapshot(value: BackupSnapshot | string): BackupSnapshot {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed === null || typeof parsed !== "object")
      throw new Error("snapshot must be an object");
    return parsed as BackupSnapshot;
  } catch (error) {
    throw new SnapshotIntegrityError(
      `snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateEnvelope(snapshot: BackupSnapshot): void {
  if (snapshot.format !== BACKUP_FORMAT)
    throw new SnapshotVersionError(`unsupported snapshot format: ${String(snapshot.format)}`);
  if (snapshot.version !== BACKUP_FORMAT_VERSION)
    throw new SnapshotVersionError(`unsupported snapshot version: ${String(snapshot.version)}`);
  if (!Number.isSafeInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 1)
    throw new SnapshotVersionError("snapshot schema version is invalid");
  if (
    typeof snapshot.snapshotId !== "string" ||
    snapshot.snapshotId.length === 0 ||
    snapshot.snapshotId.includes("\u0000")
  )
    throw new SnapshotIntegrityError("snapshot ID is invalid");
  if (
    typeof snapshot.workerId !== "string" ||
    snapshot.workerId.length === 0 ||
    snapshot.workerId.includes("\u0000")
  )
    throw new SnapshotIntegrityError("worker ID is invalid");
  if (
    snapshot.integrity?.algorithm !== BACKUP_INTEGRITY_ALGORITHM ||
    typeof snapshot.integrity.digest !== "string"
  )
    throw new SnapshotIntegrityError("snapshot integrity metadata is invalid");
  if (
    typeof snapshot.encryption?.algorithm !== "string" ||
    typeof snapshot.encryption.nonce !== "string" ||
    typeof snapshot.encryption.ciphertext !== "string" ||
    typeof snapshot.encryption.tag !== "string"
  )
    throw new SnapshotIntegrityError("snapshot encryption metadata is invalid");
}

function validatePayload(payload: SnapshotPayload, snapshot: BackupSnapshot): void {
  if (payload?.redacted !== true || payload.worker?.workerId !== snapshot.workerId)
    throw new SnapshotIntegrityError("snapshot payload is invalid or belongs to another worker");
  if (!Array.isArray(payload.history) || payload.history.length === 0)
    throw new SnapshotIntegrityError("snapshot history is missing");
  if (payload.history[0]?.fromState !== null || payload.history[0]?.workerId !== snapshot.workerId)
    throw new SnapshotIntegrityError("snapshot history has no creation boundary");
  let state = payload.history[0].toState;
  if (!isWorkerState(state))
    throw new SnapshotIntegrityError("snapshot history contains an invalid state");
  for (const transition of payload.history.slice(1)) {
    if (
      !isWorkerState(transition.toState) ||
      (transition.fromState !== null && !isWorkerState(transition.fromState))
    )
      throw new SnapshotIntegrityError("snapshot history contains an invalid state");
    if (transition.workerId !== snapshot.workerId || transition.fromState !== state)
      throw new SnapshotIntegrityError("snapshot history is not a contiguous state chain");
    state = transition.toState;
  }
  if (state !== payload.worker.state)
    throw new SnapshotIntegrityError("snapshot state does not match its history");
}

class AesGcmEncryption implements SnapshotEncryptionPort {
  public readonly algorithm = AES_GCM_ALGORITHM;

  public encrypt(input: Uint8Array, key: Uint8Array, aad: Uint8Array): SnapshotCiphertext {
    if (key.byteLength !== 32) throw new BackupError("AES-256-GCM snapshot keys must be 32 bytes");
    const nonce = randomBytes(12);
    const cipher = createCipheriv(AES_GCM_ALGORITHM, key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    return {
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  }

  public decrypt(input: SnapshotCiphertext, key: Uint8Array, aad: Uint8Array): Uint8Array {
    if (key.byteLength !== 32) throw new BackupError("AES-256-GCM snapshot keys must be 32 bytes");
    const decipher = createDecipheriv(
      AES_GCM_ALGORITHM,
      key,
      Buffer.from(input.nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(input.tag, "base64url"));
    decipher.setAAD(aad);
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64url")),
      decipher.final(),
    ]);
  }
}

export interface BackupManagerOptions {
  readonly key?: Uint8Array;
  readonly keyPort?: SnapshotKeyPort;
  readonly encryption?: SnapshotEncryptionPort;
}

/** Creates and restores encrypted, redacted worker snapshots. */
export class BackupManager {
  readonly #source: WorkerStateStore;
  readonly #key: Uint8Array | undefined;
  readonly #keyPort: SnapshotKeyPort | undefined;
  readonly #encryption: SnapshotEncryptionPort;

  public constructor(source: WorkerStateStore, options: BackupManagerOptions) {
    this.#source = source;
    this.#key = options.key;
    this.#keyPort = options.keyPort;
    this.#encryption = options.encryption ?? new AesGcmEncryption();
    if (this.#key === undefined && this.#keyPort === undefined)
      throw new BackupError("a snapshot key or key port is required");
    if (this.#key !== undefined && this.#keyPort !== undefined)
      throw new BackupError("provide either a snapshot key or key port, not both");
  }

  private key(snapshotId: string): Uint8Array {
    const value = this.#key ?? this.#keyPort?.keyFor(snapshotId);
    if (!(value instanceof Uint8Array) || value.byteLength === 0)
      throw new BackupError("snapshot key port returned an invalid key");
    return value;
  }

  public create(workerId: string, options: CreateSnapshotOptions = {}): BackupSnapshot {
    const worker = this.#source.get(workerId);
    if (worker === undefined) throw new BackupError(`worker ${workerId} was not found`);
    const history = this.#source.history(workerId);
    if (history.length === 0) throw new BackupError(`worker ${workerId} has no state history`);
    const snapshotId = options.snapshotId ?? randomUUID();
    if (snapshotId.length === 0 || snapshotId.includes("\u0000"))
      throw new BackupError("snapshotId must be non-empty and contain no NUL");
    const createdAt = iso(options.createdAt, "createdAt");
    const retentionDays = positiveInteger(options.retentionDays, "retentionDays");
    const retainUntil =
      options.retainUntil === undefined
        ? new Date(Date.parse(createdAt) + retentionDays * 86_400_000).toISOString()
        : iso(options.retainUntil, "retainUntil");
    if (Date.parse(retainUntil) < Date.parse(createdAt))
      throw new BackupError("retainUntil must not precede createdAt");
    const knownGood = options.knownGood ?? true;
    const retention: SnapshotRetentionMetadata = {
      retainUntil,
      knownGood,
      deletionProtected: knownGood,
    };
    const payload: SnapshotPayload = {
      redacted: true,
      worker: redactedWorker(worker),
      history: history.map(redactedTransition),
    };
    const unsigned: Omit<BackupSnapshot, "integrity"> = {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      schemaVersion: this.#source.schemaVersion,
      snapshotId,
      workerId,
      createdAt,
      retention,
      encryption: {
        ...this.#encryption.encrypt(
          bytes(stable(payload)),
          this.key(snapshotId),
          associatedData({
            format: BACKUP_FORMAT,
            version: BACKUP_FORMAT_VERSION,
            snapshotId,
            workerId,
          }),
        ),
        algorithm: this.#encryption.algorithm,
      },
    };
    return {
      ...unsigned,
      integrity: { algorithm: BACKUP_INTEGRITY_ALGORITHM, digest: digest(unsigned) },
    };
  }

  /** Verifies the envelope, authenticates it, decrypts it, and validates the state chain. */
  public verify(snapshotValue: BackupSnapshot | string): SnapshotVerification {
    const snapshot = parseSnapshot(snapshotValue);
    validateEnvelope(snapshot);
    if (snapshot.schemaVersion !== this.#source.schemaVersion)
      throw new SnapshotVersionError(
        `snapshot schema ${snapshot.schemaVersion} does not match source schema ${this.#source.schemaVersion}`,
      );
    if (digest(withoutIntegrity(snapshot)) !== snapshot.integrity.digest)
      throw new SnapshotIntegrityError();
    let plaintext: Uint8Array;
    try {
      plaintext = this.#encryption.decrypt(
        snapshot.encryption,
        this.key(snapshot.snapshotId),
        associatedData(snapshot),
      );
    } catch (error) {
      throw new SnapshotIntegrityError(
        `snapshot decryption failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let payload: SnapshotPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext)) as SnapshotPayload;
    } catch (error) {
      throw new SnapshotIntegrityError(
        `snapshot payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    validatePayload(payload, snapshot);
    return {
      snapshotId: snapshot.snapshotId,
      workerId: snapshot.workerId,
      schemaVersion: snapshot.schemaVersion,
      payload,
    };
  }

  /** Restores only redacted lifecycle metadata into an empty target store. */
  public restore(
    snapshotValue: BackupSnapshot | string,
    target: WorkerStateStore,
    options: RestoreSnapshotOptions = {},
  ): WorkerRecord {
    const snapshot = parseSnapshot(snapshotValue);
    const verified = this.verify(snapshot);
    if (verified.schemaVersion !== target.schemaVersion)
      throw new SnapshotVersionError(
        `snapshot schema ${verified.schemaVersion} does not match target schema ${target.schemaVersion}`,
      );
    if (target.get(verified.workerId) !== undefined)
      throw new SnapshotRestoreError(`worker ${verified.workerId} already exists in target state`);
    const worker = verified.payload.worker;
    const first = verified.payload.history[0];
    const input: WorkerInput = {
      ...worker,
      state: first.toState,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      lastTransitionAt: first.occurredAt,
    };
    try {
      target.create(input);
      for (const transition of verified.payload.history.slice(1)) {
        target.transition(verified.workerId, transition.toState, {
          actor: options.actor ?? transition.actor,
          reason: transition.reason,
          at: transition.occurredAt,
          expectedState: transition.fromState ?? undefined,
        });
      }
      return target.get(verified.workerId) as WorkerRecord;
    } catch (error) {
      throw new SnapshotRestoreError(
        `could not restore worker ${verified.workerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public isDeletable(
    snapshotValue: BackupSnapshot | string,
    now: string | Date = new Date(),
  ): boolean {
    const snapshot = parseSnapshot(snapshotValue);
    this.verify(snapshot);
    return (
      !snapshot.retention.deletionProtected &&
      Date.parse(iso(now, "now")) >= Date.parse(snapshot.retention.retainUntil)
    );
  }

  public backup(workerId: string, options: CreateSnapshotOptions = {}): BackupSnapshot {
    return this.create(workerId, options);
  }
  public check(snapshot: BackupSnapshot | string): SnapshotVerification {
    return this.verify(snapshot);
  }
  /** Alias used by recovery callers; verification always precedes mutation. */
  public recover(
    snapshot: BackupSnapshot | string,
    target: WorkerStateStore,
    options: RestoreSnapshotOptions = {},
  ): WorkerRecord {
    return this.restore(snapshot, target, options);
  }
}

export const StateBackup = BackupManager;
export const SnapshotManager = BackupManager;

export function createBackupSnapshot(
  source: WorkerStateStore,
  workerId: string,
  options: BackupManagerOptions & CreateSnapshotOptions,
): BackupSnapshot {
  const { snapshotId, createdAt, retentionDays, retainUntil, knownGood, ...managerOptions } =
    options;
  return new BackupManager(source, managerOptions).create(workerId, {
    snapshotId,
    createdAt,
    retentionDays,
    retainUntil,
    knownGood,
  });
}
