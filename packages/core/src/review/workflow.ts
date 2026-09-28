import type { PullRequest, Repository } from "../github/models";
import type { WorkerRecord } from "../state/models";
import {
  AutomaticMergeRejectedError,
  ReviewInvalidStateError,
  ReviewValidationError,
  ReviewWorkerNotFoundError,
  ReviewWorkflowError,
  type ReviewChangesRequest,
  type ReviewChangesResult,
  type ReviewContinueResult,
  type ReviewDecision,
  type ReviewReadyRequest,
  type ReviewSnapshot,
  type ReviewSnapshotPort,
  type ReviewStatePort,
  type ReviewWorkflowDependencies,
} from "./models";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new ReviewValidationError(`${field} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ReviewValidationError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function repository(value: unknown): Repository {
  if (value === null || typeof value !== "object") throw new ReviewValidationError("pull request repository is required");
  const input = value as Repository;
  const owner = requiredText(input.owner, "repository.owner");
  const name = requiredText(input.name, "repository.name");
  const defaultBranch = requiredText(input.defaultBranch, "repository.defaultBranch");
  return {
    owner,
    name,
    defaultBranch,
    ...(input.cloneUrl === undefined ? {} : { cloneUrl: requiredText(input.cloneUrl, "repository.cloneUrl") }),
    ...(input.webUrl === undefined ? {} : { webUrl: requiredText(input.webUrl, "repository.webUrl") }),
  };
}

/** Redacts caller-provided and common credential forms from review text. */
export function redactReviewText(value: string, sensitiveValues: readonly string[] = []): string {
  let result = value;
  for (const secret of sensitiveValues) {
    if (typeof secret === "string" && secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat)[-_][A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+/gu, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:token|access_token|api[_-]?key|password|secret)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\b(token|access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1: [REDACTED]");
}

/** Produces bounded diagnostics that are safe to put in state or comments. */
export function safeReviewDiagnostic(error: unknown, sensitiveValues: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactReviewText(message, sensitiveValues).slice(0, 500);
}

class MemorySnapshotPort implements ReviewSnapshotPort {
  readonly #snapshots = new Map<string, ReviewSnapshot>();

  save(snapshot: ReviewSnapshot): ReviewSnapshot {
    const existing = this.#snapshots.get(snapshot.snapshotId);
    if (existing !== undefined) return existing;
    this.#snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  get(snapshotId: string): ReviewSnapshot | undefined {
    return this.#snapshots.get(snapshotId);
  }
}

function defaultSnapshotId(input: ReviewReadyRequest & { readonly worker: WorkerRecord }): string {
  const head = input.pullRequest.headSha ?? "head";
  return `review-${input.worker.workerId}-${input.pullRequest.number}-${head}`.replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function validatePullRequest(input: PullRequest, worker: WorkerRecord): PullRequest {
  if (input === null || typeof input !== "object") throw new ReviewValidationError("pull request is required");
  const number = positiveInteger(input.number, "pull request number");
  if (input.state !== "open") throw new ReviewValidationError("pull request must be open for review");
  const sourceBranch = requiredText(input.sourceBranch, "pull request source branch");
  const targetBranch = requiredText(input.targetBranch, "pull request target branch");
  if (targetBranch !== input.repository.defaultBranch) {
    throw new ReviewValidationError("pull request target branch does not match the repository default branch");
  }
  if (sourceBranch !== worker.branch) {
    throw new ReviewValidationError("pull request source branch does not match the worker branch");
  }
  return {
    ...input,
    repository: repository(input.repository),
    number,
    sourceBranch,
    targetBranch,
  };
}

function samePullRequest(snapshot: ReviewSnapshot, request: ReviewReadyRequest, pullRequest: PullRequest): boolean {
  return snapshot.pullRequestNumber === pullRequest.number
    && snapshot.workerId === request.workerId
    && snapshot.containerId === request.containerId
    && snapshot.branch === pullRequest.sourceBranch
    && snapshot.repository.owner === pullRequest.repository.owner
    && snapshot.repository.name === pullRequest.repository.name
    && (pullRequest.headSha === undefined || snapshot.headSha === pullRequest.headSha);
}

/**
 * Coordinates the human-review boundary. It only records review decisions and
 * resumes the exact saved resources supplied by the continue port; it has no
 * merge capability.
 */
export class ReviewWorkflow {
  readonly #state: ReviewStatePort;
  readonly #continuePort: ReviewWorkflowDependencies["continuePort"];
  readonly #decisionPort: ReviewWorkflowDependencies["decisionPort"];
  readonly #snapshots: ReviewSnapshotPort;
  readonly #now: () => string;
  readonly #createSnapshotId: NonNullable<ReviewWorkflowDependencies["createSnapshotId"]>;
  readonly #decisions = new Map<string, ReviewDecision>();

  public constructor(dependencies: ReviewWorkflowDependencies) {
    if (dependencies === null || typeof dependencies !== "object") {
      throw new ReviewValidationError("review workflow dependencies are required");
    }
    if (dependencies.state === undefined || dependencies.continuePort === undefined
      || (dependencies.continuePort.continue === undefined && dependencies.continuePort.resume === undefined)) {
      throw new ReviewValidationError("review state and continue ports are required");
    }
    this.#state = dependencies.state;
    this.#continuePort = dependencies.continuePort;
    this.#decisionPort = dependencies.decisionPort;
    this.#snapshots = dependencies.snapshots ?? new MemorySnapshotPort();
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#createSnapshotId = dependencies.createSnapshotId ?? defaultSnapshotId;
  }

  /** Creates (or returns) a snapshot after an open PR is ready for review. */
  public async readyForReview(request: ReviewReadyRequest): Promise<{ readonly worker: WorkerRecord; readonly snapshot: ReviewSnapshot }> {
    const workerId = requiredText(request?.workerId, "workerId");
    const worker = await this.#worker(workerId);
    const pullRequest = validatePullRequest(request.pullRequest, worker);
    const containerId = requiredText(request.containerId, "containerId");
    if (worker.state === "awaiting-review") {
      const existing = await this.#snapshotFor(worker);
      if (!samePullRequest(existing, request, pullRequest)) throw new ReviewInvalidStateError(workerId, worker.state, "the existing pull request snapshot");
      return { worker, snapshot: existing };
    }
    if (worker.state !== "running") throw new ReviewInvalidStateError(workerId, worker.state, "running or awaiting-review");
    const workspacePath = requiredText(worker.workspacePath, "worker workspacePath");
    const branch = requiredText(worker.branch, "worker branch");
    const snapshotId = requiredText(this.#createSnapshotId({ ...request, pullRequest, worker }), "snapshotId");
    const snapshot: ReviewSnapshot = {
      snapshotId,
      workerId,
      containerId,
      workspacePath,
      branch,
      pullRequestNumber: pullRequest.number,
      repository: pullRequest.repository,
      ...(pullRequest.headSha === undefined ? {} : { headSha: pullRequest.headSha }),
      ...(worker.issueIdentifier === undefined ? {} : { issueIdentifier: worker.issueIdentifier }),
      createdAt: requiredText(this.#now(), "createdAt"),
    };
    const saved = await this.#snapshots.save(snapshot);
    if (!samePullRequest(saved, { ...request, pullRequest }, pullRequest)
      || saved.containerId !== containerId || saved.workspacePath !== workspacePath) {
      throw new ReviewWorkflowError(`review snapshot ${saved.snapshotId} does not match the ready pull request`);
    }
    await this.#state.update(workerId, {
      pullRequestNumber: pullRequest.number,
      snapshotId: saved.snapshotId,
      branch,
      workspacePath,
    });
    const reviewed = await this.#state.transition(workerId, "awaiting-review", {
      actor: "review-workflow",
      reason: "pull request ready for review",
      providerEvidence: String(pullRequest.number),
      expectedState: "running",
    });
    return { worker: reviewed, snapshot: saved };
  }

  /** Alias for hosts that call this operation markReadyForReview. */
  public markReadyForReview(request: ReviewReadyRequest): ReturnType<ReviewWorkflow["readyForReview"]> {
    return this.readyForReview(request);
  }

  /** Records changes_requested and resumes the same worker for correction. */
  public async requestChanges(request: ReviewChangesRequest): Promise<ReviewChangesResult> {
    const workerId = requiredText(request?.workerId, "workerId");
    const instructions = redactReviewText(requiredText(request?.instructions, "instructions"), request.sensitiveValues);
    const worker = await this.#worker(workerId);
    if (worker.state !== "awaiting-review") throw new ReviewInvalidStateError(workerId, worker.state, "awaiting-review");
    const snapshot = await this.#snapshotFor(worker);
    const key = `${snapshot.snapshotId}\u0000${instructions}`;
    const existing = this.#decisions.get(key);
    if (existing !== undefined) {
      const current = await this.#worker(workerId);
      return { worker: current, snapshot, decision: existing, continued: false, readyForReview: current.state === "awaiting-review" };
    }
    const decision: ReviewDecision = {
      workerId,
      pullRequestNumber: snapshot.pullRequestNumber,
      state: "changes_requested",
      instructions,
      recordedAt: requiredText(this.#now(), "recordedAt"),
    };
    try {
      const decisionInput = {
        workerId,
        repository: snapshot.repository,
        pullRequestNumber: snapshot.pullRequestNumber,
        instructions,
      };
      if (this.#decisionPort?.changesRequested !== undefined) {
        await this.#decisionPort.changesRequested(decisionInput);
      } else {
        await this.#decisionPort?.recordChangesRequested?.(decisionInput);
      }
    } catch (error) {
      throw new ReviewWorkflowError(`could not record review decision: ${safeReviewDiagnostic(error, request.sensitiveValues)}`, { cause: error });
    }
    this.#decisions.set(key, decision);
    await this.#state.transition(workerId, "running", {
      actor: "review-workflow",
      reason: "review changes requested",
      providerEvidence: String(snapshot.pullRequestNumber),
      expectedState: "awaiting-review",
    });
    let continued: ReviewContinueResult | void;
    try {
      const continuationInput = { snapshot, instructions };
      continued = this.#continuePort.continue === undefined
        ? await this.#continuePort.resume?.(continuationInput)
        : await this.#continuePort.continue(continuationInput);
    } catch (error) {
      throw new ReviewWorkflowError(`could not continue worker: ${safeReviewDiagnostic(error, request.sensitiveValues)}`, { cause: error });
    }
    if (continued?.merged === true) throw new AutomaticMergeRejectedError();
    let current = await this.#worker(workerId);
    const ready = continued?.readyForReview !== false;
    if (ready) {
      current = await this.#state.transition(workerId, "awaiting-review", {
        actor: "review-workflow",
        reason: "worker produced a new reviewable change",
        providerEvidence: String(snapshot.pullRequestNumber),
        expectedState: "running",
      });
    }
    return { worker: current, snapshot, decision, continued: true, readyForReview: ready };
  }

  /** Alias for callers that model a provider webhook as changesRequested. */
  public changesRequested(request: ReviewChangesRequest): ReturnType<ReviewWorkflow["requestChanges"]> {
    return this.requestChanges(request);
  }

  /** Explicitly reject merge attempts; review never grants merge authority. */
  public merge(): never {
    throw new AutomaticMergeRejectedError();
  }

  async #worker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.#state.get(workerId);
    if (worker === undefined) throw new ReviewWorkerNotFoundError(workerId);
    return worker;
  }

  async #snapshotFor(worker: WorkerRecord): Promise<ReviewSnapshot> {
    const snapshotId = requiredText(worker.snapshotId, "worker snapshotId");
    const snapshot = await this.#snapshots.get(snapshotId);
    if (snapshot === undefined) throw new ReviewWorkflowError(`review snapshot ${snapshotId} was not found`);
    if (snapshot.workerId !== worker.workerId) throw new ReviewWorkflowError("review snapshot belongs to a different worker");
    return snapshot;
  }
}

export function createReviewWorkflow(dependencies: ReviewWorkflowDependencies): ReviewWorkflow {
  return new ReviewWorkflow(dependencies);
}
