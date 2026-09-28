import type { PullRequest, PullRequestStatus, Repository } from "../github/models";
import type { WorkerRecord, WorkerState } from "../state/models";

export type MaybePromise<T> = T | Promise<T>;
export type ContinueReason = "answer" | "changes_requested" | "retry";

/** The provider identity saved when the worker and its pull request were created. */
export interface ContinuePullRequestIdentity {
  readonly repository: Repository;
  readonly number: number;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha?: string;
}

/** State plus the immutable runtime/provider identity used for a continuation. */
export interface ContinueWorkerRecord extends WorkerRecord {
  readonly containerId: string;
  readonly pullRequest: ContinuePullRequestIdentity;
}

/** Narrow state seam. Implementations must return the persisted identity, not a new allocation. */
export interface ContinueStatePort {
  get(workerId: string): MaybePromise<ContinueWorkerRecord | undefined>;
  update(workerId: string, patch: Partial<Omit<WorkerRecord, "workerId" | "state" | "createdAt" | "updatedAt" | "lastTransitionAt">>): MaybePromise<ContinueWorkerRecord>;
  transition(workerId: string, state: WorkerState, options?: {
    readonly actor?: string;
    readonly reason?: string;
    readonly expectedState?: WorkerState;
    readonly providerEvidence?: string;
  }): MaybePromise<ContinueWorkerRecord>;
}

export interface ContinueRequest {
  readonly workerId: string;
  readonly reason: ContinueReason;
  /** The answer or review instruction sent to Pi. `instructions` is a compatibility alias. */
  readonly instruction?: string;
  readonly instructions?: string;
  readonly sensitiveValues?: readonly string[];
}

/** Exact identity passed to the existing Pi/tmux boundary. */
export interface ContinueInjectionInput {
  readonly workerId: string;
  readonly containerId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly pullRequest: ContinuePullRequestIdentity;
  readonly reason: ContinueReason;
  readonly instruction: string;
  readonly preserveUncommittedWork: true;
}

export interface ContinueWorkerResult {
  readonly status: "completed" | "failed";
  readonly readyForReview?: boolean;
  readonly commitSha?: string;
  /** Safe, bounded provider evidence only; secrets and raw output are not accepted. */
  readonly evidence?: string;
}

/** Existing Pi/tmux boundary; it never provisions, branches, or merges. */
export interface ContinueInjectionPort {
  inject(input: ContinueInjectionInput): MaybePromise<ContinueWorkerResult>;
}

export type ContinueOutcome = "started" | "succeeded" | "failed";

export interface ContinueStatusRecord {
  readonly continuationId: string;
  readonly workerId: string;
  readonly reason: ContinueReason;
  readonly outcome: ContinueOutcome;
  readonly state: WorkerState;
  readonly message: string;
}

/** Writes only bounded lifecycle facts; callers must not persist raw provider output. */
export interface ContinueStatusPort {
  write(input: ContinueStatusRecord): MaybePromise<void>;
}

export interface ContinueAuditRecord {
  readonly continuationId: string;
  readonly workerId: string;
  readonly reason: ContinueReason;
  readonly outcome: ContinueOutcome;
  readonly state: WorkerState;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface ContinueAuditPort {
  record(input: ContinueAuditRecord): MaybePromise<void>;
}

/** Reconciles an existing PR after the injected worker has finished. */
export interface ContinuePullRequestPort {
  reconcile(input: {
    readonly workerId: string;
    readonly pullRequest: ContinuePullRequestIdentity;
    readonly result: ContinueWorkerResult;
  }): MaybePromise<PullRequestStatus | PullRequest | void>;
}

export interface ContinueWorkflowDependencies {
  readonly state: ContinueStatePort;
  readonly injection: ContinueInjectionPort;
  readonly status?: ContinueStatusPort;
  readonly audit?: ContinueAuditPort;
  readonly pullRequest: ContinuePullRequestPort;
  readonly now?: () => string;
  readonly createContinuationId?: (input: ContinueRequest & { readonly worker: ContinueWorkerRecord }) => string;
}

export interface ContinueResult {
  readonly continuationId: string;
  readonly worker: ContinueWorkerRecord;
  readonly result: ContinueWorkerResult;
  readonly pullRequestStatus?: PullRequestStatus | PullRequest;
  readonly instruction: string;
}

export class ContinueWorkflowError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ContinueWorkflowError";
  }
}

export class ContinueValidationError extends ContinueWorkflowError {
  public constructor(message: string) {
    super(message);
    this.name = "ContinueValidationError";
  }
}

export class ContinueWorkerNotFoundError extends ContinueWorkflowError {
  public constructor(workerId: string) {
    super(`worker ${workerId} was not found`);
    this.name = "ContinueWorkerNotFoundError";
  }
}

export class ContinueInvalidStateError extends ContinueWorkflowError {
  public constructor(workerId: string, state: WorkerState, expected: string) {
    super(`worker ${workerId} is ${state}; expected ${expected}`);
    this.name = "ContinueInvalidStateError";
  }
}

export class ContinueDuplicateError extends ContinueWorkflowError {
  public constructor(workerId: string) {
    super(`worker ${workerId} already has this continuation`);
    this.name = "ContinueDuplicateError";
  }
}

export class ContinueProviderError extends ContinueWorkflowError {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ContinueProviderError";
  }
}
