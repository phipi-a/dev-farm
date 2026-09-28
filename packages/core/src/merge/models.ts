import type {
  CheckStatus,
  CiStatus,
  PullRequest,
  PullRequestReviewState,
  PullRequestState,
  Repository,
} from "../github/models";

export type MaybePromise<T> = T | Promise<T>;

/** The only actors allowed to request a merge. Workers never hold merge authority. */
export type MergeCaller = "operator" | "controller" | "worker";

/** A confirmation supplied by the caller, not inferred from review or CI state. */
export type MergeConfirmation = boolean | string;

export interface MergeRequest {
  readonly workerId: string;
  readonly repository: Repository;
  readonly pullRequestNumber: number;
  readonly caller: MergeCaller;
  /** Either true or a non-empty confirmation token is accepted. */
  readonly confirmation?: MergeConfirmation;
  /** Explicit aliases are useful to adapters that keep confirmation separate. */
  readonly confirmed?: boolean;
  readonly confirmationToken?: string;
  readonly issueIdentifier?: string;
  readonly sensitiveValues?: readonly string[];
}

export interface MergePullRequestRef {
  readonly repository: Repository;
  readonly number: number;
}

/** A provider snapshot. All values must describe the same current PR head. */
export interface MergeInspection {
  readonly state: PullRequestState;
  readonly ci: CiStatus;
  readonly reviewState?: PullRequestReviewState;
  readonly headSha?: string;
  /** `undefined` is treated as unknown and is not safe to merge. */
  readonly mergeable?: boolean;
  readonly checks?: readonly CheckStatus[];
}

export interface MergeProviderPort {
  inspect(input: MergePullRequestRef): MaybePromise<MergeInspection>;
  merge(input: MergeProviderMergeInput): MaybePromise<MergeProviderResult>;
}

export interface MergeProviderMergeInput extends MergePullRequestRef {
  /** Passed for provider-side audit correlation; it is not worker authority. */
  readonly workerId: string;
}

export interface MergeProviderResult {
  readonly state: "merged" | "already-merged";
  readonly pullRequest?: PullRequest;
}

export interface MergeLinearInput {
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly pullRequestNumber: number;
}

/** The Linear adapter is intentionally narrower than the general Linear client. */
export interface MergeLinearPort {
  setDone(input: MergeLinearInput): MaybePromise<void>;
}

export interface MergeLifecycleInput extends MergePullRequestRef {
  readonly workerId: string;
  readonly outcome: "merged" | "already-merged";
}

export interface MergeBaselinePort {
  refresh(input: MergeLifecycleInput): MaybePromise<void>;
}

export interface MergeCleanupPort {
  cleanup(input: MergeLifecycleInput): MaybePromise<void>;
}

export type MergeAuditOutcome = "started" | "blocked" | "succeeded" | "failed" | "observed";

/** Safe audit facts. Confirmation values, credentials, and provider errors are never included. */
export interface MergeAuditRecord {
  readonly action: string;
  readonly outcome: MergeAuditOutcome;
  readonly workerId: string;
  readonly pullRequestNumber: number;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface MergeAuditPort {
  record(input: MergeAuditRecord): MaybePromise<void>;
}

export type MergeSideEffectState = "done" | "skipped" | "failed";

export interface MergeSideEffectResult {
  readonly state: MergeSideEffectState;
  readonly diagnostic?: string;
}

export interface MergeResult {
  readonly outcome: "merged" | "already-merged";
  readonly pullRequestState: "merged";
  readonly linear: MergeSideEffectResult;
  readonly baselineRefresh: MergeSideEffectResult;
  readonly workerCleanup: MergeSideEffectResult;
  readonly warnings: readonly string[];
  readonly audit: readonly MergeAuditRecord[];
}

export class MergeWorkflowError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MergeWorkflowError";
  }
}

export type MergeGate = "caller" | "confirmation" | "pull-request" | "ci" | "review" | "conflict";

export class MergeGateError extends MergeWorkflowError {
  public readonly gate: MergeGate;

  public constructor(gate: MergeGate, message: string) {
    super(message);
    this.name = "MergeGateError";
    this.gate = gate;
  }
}

export class MergeProviderError extends MergeWorkflowError {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MergeProviderError";
  }
}

export class MergeValidationError extends MergeWorkflowError {
  public constructor(message: string) {
    super(message);
    this.name = "MergeValidationError";
  }
}
