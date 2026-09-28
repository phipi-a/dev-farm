import type { ContinueInjectionPort, ContinuePullRequestIdentity, ContinueWorkerResult, MaybePromise } from "../continue/models";

export const WAITING_FOR_INPUT_STATE = "waiting_for_input" as const;
export type QuestionWorkerState =
  | "queued"
  | "provisioning"
  | "running"
  | "awaiting-review"
  | "paused"
  | "recovering"
  | "stopped"
  | "failed"
  | "destroyed"
  | "completed"
  | typeof WAITING_FOR_INPUT_STATE;

/** The provider identity required to resume the exact worker resources. */
export interface QuestionWorkerRecord {
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly state: QuestionWorkerState;
  readonly containerId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly pullRequest: ContinuePullRequestIdentity;
  readonly pullRequestNumber?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastTransitionAt?: string;
}

export interface QuestionTransitionOptions {
  readonly actor?: string;
  readonly reason?: string;
  readonly expectedState?: QuestionWorkerState;
  readonly providerEvidence?: string;
}

/** State is injected so this workflow can run against SQLite, a CLI, or a fake. */
export interface QuestionStatePort {
  get(workerId: string): MaybePromise<QuestionWorkerRecord | undefined>;
  transition(workerId: string, state: QuestionWorkerState, options?: QuestionTransitionOptions): MaybePromise<QuestionWorkerRecord>;
}

export type QuestionStatus = "unanswered" | "answered";

/** Only redacted, bounded question metadata may be persisted. */
export interface QuestionRecord {
  readonly questionId: string;
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly question: string;
  readonly askedAt: string;
  readonly status: QuestionStatus;
  readonly answer?: string;
  readonly answeredAt?: string;
}

export interface QuestionMetadataPort {
  get(workerId: string): MaybePromise<QuestionRecord | undefined>;
  save(record: QuestionRecord): MaybePromise<QuestionRecord>;
}

/** Narrow Linear seam; credentials and transport concerns remain outside the workflow. */
export interface QuestionLinearPort {
  addComment(input: { readonly identifier: string; readonly body: string }): MaybePromise<unknown>;
}

/** Existing continuation seam. It receives the saved container/workspace/branch/PR identity verbatim. */
export type QuestionContinuePort = Pick<ContinueInjectionPort, "inject">;

export interface QuestionSignal {
  readonly type: "worker_question";
  readonly question: string;
}

/** Compatibility name for hosts that call the event a worker question. */
export type WorkerQuestionSignal = QuestionSignal;

export interface QuestionRequest {
  readonly workerId: string;
  readonly signal: unknown;
  readonly sensitiveValues?: readonly string[];
}

export interface QuestionAnswerRequest {
  readonly workerId: string;
  readonly answer: string;
  readonly sensitiveValues?: readonly string[];
}

export interface QuestionResult {
  readonly worker: QuestionWorkerRecord;
  readonly question: QuestionRecord;
  readonly commentBody: string;
}

export interface QuestionAnswerResult {
  readonly worker: QuestionWorkerRecord;
  readonly question: QuestionRecord;
  readonly answer: string;
  readonly continued: ContinueWorkerResult;
}

/** Response boundary usable by a CLI, Pi host, tmux host, or HTTP adapter. */
export interface QuestionResponsePort {
  answer(request: QuestionAnswerRequest): Promise<QuestionAnswerResult>;
}

/** Compatibility name for response adapters. */
export type QuestionAnswerPort = QuestionResponsePort;

export interface QuestionWorkflowDependencies {
  readonly state: QuestionStatePort;
  readonly questions: QuestionMetadataPort;
  readonly linear: QuestionLinearPort;
  readonly continuePort: QuestionContinuePort;
  readonly now?: () => string;
  readonly createQuestionId?: (input: { readonly worker: QuestionWorkerRecord; readonly askedAt: string; readonly question: string }) => string;
}

export class QuestionWorkflowError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "QuestionWorkflowError";
  }
}

export class QuestionValidationError extends QuestionWorkflowError {
  public constructor(message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

export class QuestionSignalError extends QuestionValidationError {
  public constructor(message: string) {
    super(message);
    this.name = "QuestionSignalError";
  }
}

export class QuestionWorkerNotFoundError extends QuestionWorkflowError {
  public constructor(workerId: string) {
    super(`worker ${workerId} was not found`);
    this.name = "QuestionWorkerNotFoundError";
  }
}

export class QuestionInvalidStateError extends QuestionWorkflowError {
  public constructor(workerId: string, state: QuestionWorkerState, expected: string) {
    super(`worker ${workerId} is ${state}; expected ${expected}`);
    this.name = "QuestionInvalidStateError";
  }
}

export class QuestionPendingError extends QuestionWorkflowError {
  public constructor(workerId: string) {
    super(`worker ${workerId} is waiting for an answer`);
    this.name = "QuestionPendingError";
  }
}

export class QuestionDuplicateAnswerError extends QuestionWorkflowError {
  public constructor(workerId: string) {
    super(`worker ${workerId} already has an answer`);
    this.name = "QuestionDuplicateAnswerError";
  }
}

export class QuestionProviderError extends QuestionWorkflowError {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "QuestionProviderError";
  }
}
