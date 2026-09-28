import type { PullRequest, Repository } from "../github/models";
import type { WorkerRecord, WorkerState } from "../state/models";

export type MaybePromise<T> = T | Promise<T>;

/** The provider-independent state needed to continue one reviewed worker. */
export interface ReviewSnapshot {
  readonly snapshotId: string;
  readonly workerId: string;
  readonly containerId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly pullRequestNumber: number;
  readonly repository: Repository;
  readonly headSha?: string;
  readonly issueIdentifier?: string;
  readonly createdAt: string;
}

export interface ReviewReadyRequest {
  readonly workerId: string;
  readonly containerId: string;
  readonly pullRequest: PullRequest;
  readonly sensitiveValues?: readonly string[];
}

export interface ReviewStatePort {
  get(workerId: string): MaybePromise<WorkerRecord | undefined>;
  update(workerId: string, patch: Partial<Omit<WorkerRecord, "workerId" | "state" | "createdAt" | "updatedAt" | "lastTransitionAt">>): MaybePromise<WorkerRecord>;
  transition(workerId: string, state: WorkerState, options?: {
    readonly actor?: string;
    readonly reason?: string;
    readonly expectedState?: WorkerState;
    readonly providerEvidence?: string;
  }): MaybePromise<WorkerRecord>;
}

export interface ReviewSnapshotPort {
  save(snapshot: ReviewSnapshot): MaybePromise<ReviewSnapshot>;
  get(snapshotId: string): MaybePromise<ReviewSnapshot | undefined>;
}

export interface ReviewDecision {
  readonly workerId: string;
  readonly pullRequestNumber: number;
  readonly state: "changes_requested";
  readonly instructions: string;
  readonly recordedAt: string;
}

/** Records a review decision without granting merge authority. */
export interface ReviewDecisionPort {
  /** Canonical spelling for recording a provider changes_requested event. */
  changesRequested?(input: {
    readonly workerId: string;
    readonly repository: Repository;
    readonly pullRequestNumber: number;
    readonly instructions: string;
  }): MaybePromise<ReviewDecision | void>;
  /** Compatibility spelling for adapters that name this a record operation. */
  recordChangesRequested?(input: {
    readonly workerId: string;
    readonly repository: Repository;
    readonly pullRequestNumber: number;
    readonly instructions: string;
  }): MaybePromise<ReviewDecision | void>;
}

export interface ReviewContinueInput {
  readonly snapshot: ReviewSnapshot;
  readonly instructions: string;
}

export interface ReviewContinueResult {
  /** True when the continued worker has produced a new reviewable PR head. */
  readonly readyForReview?: boolean;
  /** A continue port must never merge; this flag is rejected defensively. */
  readonly merged?: boolean;
}

/** Resumes the existing worker resources; implementations must not provision replacements. */
export interface ReviewContinuePort {
  /** Canonical spelling; this receives the saved resource identity verbatim. */
  continue?(input: ReviewContinueInput): MaybePromise<ReviewContinueResult | void>;
  /** Compatibility spelling for hosts that call continuation resume. */
  resume?(input: ReviewContinueInput): MaybePromise<ReviewContinueResult | void>;
}

export interface ReviewChangesRequest {
  readonly workerId: string;
  readonly instructions: string;
  readonly sensitiveValues?: readonly string[];
}

export interface ReviewChangesResult {
  readonly worker: WorkerRecord;
  readonly snapshot: ReviewSnapshot;
  readonly decision: ReviewDecision;
  readonly continued: boolean;
  readonly readyForReview: boolean;
}

export interface ReviewWorkflowDependencies {
  readonly state: ReviewStatePort;
  readonly continuePort: ReviewContinuePort;
  readonly decisionPort?: ReviewDecisionPort;
  readonly snapshots?: ReviewSnapshotPort;
  readonly now?: () => string;
  readonly createSnapshotId?: (input: ReviewReadyRequest & { readonly worker: WorkerRecord }) => string;
}

export class ReviewWorkflowError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ReviewWorkflowError";
  }
}

export class ReviewValidationError extends ReviewWorkflowError {
  public constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

export class ReviewWorkerNotFoundError extends ReviewWorkflowError {
  public constructor(workerId: string) {
    super(`worker ${workerId} was not found`);
    this.name = "ReviewWorkerNotFoundError";
  }
}

export class ReviewInvalidStateError extends ReviewWorkflowError {
  public constructor(workerId: string, state: WorkerState, expected: string) {
    super(`worker ${workerId} is ${state}; expected ${expected}`);
    this.name = "ReviewInvalidStateError";
  }
}

export class AutomaticMergeRejectedError extends ReviewWorkflowError {
  public constructor() {
    super("automatic merge is not permitted by the review workflow");
    this.name = "AutomaticMergeRejectedError";
  }
}
