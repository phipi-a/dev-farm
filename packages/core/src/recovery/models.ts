/** A clock is injected so recovery decisions and retry delays are deterministic in tests. */
export interface RecoveryClock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export type WorkerHealthStatus = "healthy" | "stale" | "exited" | "missing" | "unknown";

/** Observation returned by a worker runtime heartbeat probe. */
export interface WorkerHeartbeat {
  readonly workerId: string;
  readonly status: WorkerHealthStatus;
  readonly observedAt: string | Date;
  readonly heartbeatAt?: string | Date;
  readonly reason?: string;
  readonly containerId?: string;
  readonly processId?: number;
}

export type RecoveryFailureKind =
  | "transient"
  | "stale"
  | "exited"
  | "missing"
  | "permanent"
  | "unknown";

export interface RecoveryFailureClassification {
  readonly kind: RecoveryFailureKind;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly reason: string;
}

export interface RecoveryPolicy {
  /** Maximum number of attempts, including the first attempt. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  /** Worker records older than this without a heartbeat are stale. */
  readonly staleAfterMs: number;
}

export interface RecoveryAttempt {
  readonly attempt: number;
  readonly delayMs: number;
  readonly classification?: RecoveryFailureClassification;
}

export interface RecoveryResult {
  readonly workerId: string;
  readonly status: "healthy" | "resumed" | "failed" | "skipped";
  readonly classification?: RecoveryFailureClassification;
  readonly attempts: readonly RecoveryAttempt[];
  readonly pullRequestNumber?: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  multiplier: 2,
  staleAfterMs: 5 * 60_000,
});

export function asTimestamp(value: string | Date): string {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError("recovery timestamps must be valid dates");
  }
  return timestamp;
}

export function delayForAttempt(policy: RecoveryPolicy, attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError("attempt must be a positive integer");
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * Math.pow(policy.multiplier, attempt - 1));
}

export function validateRecoveryPolicy(policy: RecoveryPolicy): RecoveryPolicy {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new TypeError("maxAttempts must be positive");
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0) throw new TypeError("initialDelayMs must be non-negative");
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs) throw new TypeError("maxDelayMs must bound initialDelayMs");
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) throw new TypeError("multiplier must be at least one");
  if (!Number.isFinite(policy.staleAfterMs) || policy.staleAfterMs < 0) throw new TypeError("staleAfterMs must be non-negative");
  return { ...policy };
}
