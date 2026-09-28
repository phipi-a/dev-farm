import {
  asTimestamp,
  delayForAttempt,
  DEFAULT_RECOVERY_POLICY,
  type RecoveryClock,
  type RecoveryFailureClassification,
  type RecoveryFailureKind,
  type RecoveryPolicy,
  validateRecoveryPolicy,
} from "./models";

/** Optional structured error for adapters which know whether an operation can be retried. */
export class RecoveryError extends Error {
  readonly kind: RecoveryFailureKind;
  readonly retryable: boolean;

  public constructor(message: string, options: { readonly kind: RecoveryFailureKind; readonly retryable?: boolean; readonly cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "RecoveryError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? (options.kind !== "permanent");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classify provider failures without persisting their payloads or credentials. */
export function classifyRecoveryFailure(error: unknown): RecoveryFailureClassification {
  if (error instanceof RecoveryError) {
    return {
      kind: error.kind,
      recoverable: error.kind !== "permanent",
      retryable: error.retryable,
      reason: error.message,
    };
  }
  const message = errorMessage(error);
  const name = error instanceof Error ? error.name : "";
  const normalized = `${name} ${message}`.toLowerCase();
  if (normalized.includes("not found") || normalized.includes("missing")) {
    return { kind: "missing", recoverable: true, retryable: true, reason: message };
  }
  if (normalized.includes("stale")) {
    return { kind: "stale", recoverable: true, retryable: true, reason: message };
  }
  if (normalized.includes("exit") || normalized.includes("stopped")) {
    return { kind: "exited", recoverable: true, retryable: true, reason: message };
  }
  if (normalized.includes("timeout") || normalized.includes("temporar") || normalized.includes("unavailable")
    || normalized.includes("connection") || normalized.includes("network") || normalized.includes("rate limit")) {
    return { kind: "transient", recoverable: true, retryable: true, reason: message };
  }
  return { kind: "unknown", recoverable: false, retryable: false, reason: message };
}

export function isRecoverableFailure(error: unknown): boolean {
  return classifyRecoveryFailure(error).recoverable;
}

export function defaultRecoveryClock(): RecoveryClock {
  return {
    now: () => new Date(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

export interface RetryExecution<T> {
  readonly value: T;
  readonly attempts: number;
  readonly classifications: readonly RecoveryFailureClassification[];
}

/** Bounded retry with injectable time; permanent failures never consume another attempt. */
export async function retryRecovery<T>(
  operation: (attempt: number) => Promise<T>,
  options: { readonly policy?: Partial<RecoveryPolicy>; readonly clock?: RecoveryClock } = {},
): Promise<RetryExecution<T>> {
  const policy = validateRecoveryPolicy({ ...DEFAULT_RECOVERY_POLICY, ...options.policy });
  const clock = options.clock ?? defaultRecoveryClock();
  const classifications: RecoveryFailureClassification[] = [];
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt, classifications };
    } catch (error) {
      const classification = classifyRecoveryFailure(error);
      classifications.push(classification);
      if (!classification.retryable || attempt >= policy.maxAttempts) throw error;
      await clock.sleep(delayForAttempt(policy, attempt));
    }
  }
  throw new Error("recovery retry loop exhausted");
}

export function staleHeartbeat(
  heartbeatAt: string | Date | undefined,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (heartbeatAt === undefined) return true;
  return now.getTime() - Date.parse(asTimestamp(heartbeatAt)) > staleAfterMs;
}
