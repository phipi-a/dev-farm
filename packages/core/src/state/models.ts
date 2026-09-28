/** Lifecycle states persisted for each isolated worker. */
export const WORKER_STATES = [
  "queued",
  "provisioning",
  "running",
  "awaiting-review",
  "paused",
  "recovering",
  "stopped",
  "failed",
  "destroyed",
] as const;

export type WorkerState = (typeof WORKER_STATES)[number];

/** Data retained for restart, status, and recovery without storing credentials. */
export interface WorkerRecord {
  readonly workerId: string;
  readonly issueIdentifier?: string;
  readonly project?: string;
  readonly repository?: string;
  readonly mappingVersion?: string;
  readonly state: WorkerState;
  readonly reason?: string;
  readonly processId?: number;
  readonly sessionName?: string;
  readonly workspacePath?: string;
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

/** Fields accepted when creating a worker. State is queued unless supplied. */
export type WorkerInput = Omit<WorkerRecord, "createdAt" | "updatedAt" | "lastTransitionAt" | "state"> & {
  readonly state?: WorkerState;
  readonly createdAt?: string | Date;
  readonly updatedAt?: string | Date;
  readonly lastTransitionAt?: string | Date;
};

export interface WorkerTransition {
  readonly id: number;
  readonly workerId: string;
  readonly fromState: WorkerState | null;
  readonly toState: WorkerState;
  readonly actor: string;
  readonly reason?: string;
  readonly providerEvidence?: string;
  readonly occurredAt: string;
}

export interface TransitionOptions {
  readonly actor?: string;
  readonly reason?: string;
  readonly providerEvidence?: string;
  readonly expectedState?: WorkerState;
  readonly at?: string | Date;
}

export interface WorkerListFilter {
  readonly states?: readonly WorkerState[];
  readonly project?: string;
  readonly issueIdentifier?: string;
}

export interface RecoveryRecord extends WorkerRecord {
  /** True when the record is in a state which needs reconciliation after restart. */
  readonly recoveryRequired: true;
}

export const RECOVERY_STATES: readonly WorkerState[] = [
  "provisioning",
  "running",
  "awaiting-review",
  "paused",
  "recovering",
  "stopped",
] as const;

export function isWorkerState(value: unknown): value is WorkerState {
  return typeof value === "string" && (WORKER_STATES as readonly string[]).includes(value);
}

/** State transitions allowed by the worker lifecycle contract. */
export const VALID_TRANSITIONS: Readonly<Record<WorkerState, readonly WorkerState[]>> = {
  queued: ["provisioning", "failed", "destroyed"],
  provisioning: ["running", "failed", "recovering", "stopped"],
  running: ["awaiting-review", "paused", "recovering", "stopped", "failed"],
  "awaiting-review": ["running", "paused", "recovering", "stopped", "failed"],
  paused: ["running", "recovering", "stopped", "destroyed"],
  recovering: ["running", "paused", "stopped", "failed"],
  stopped: ["provisioning", "recovering", "destroyed"],
  failed: ["recovering", "destroyed"],
  destroyed: [],
};

export function canTransition(from: WorkerState, to: WorkerState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
