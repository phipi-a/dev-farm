import { canTransition } from "../state/models";
import type { WorkerState } from "../state/models";
import {
  ContinueDuplicateError,
  ContinueInvalidStateError,
  ContinueProviderError,
  ContinueValidationError,
  ContinueWorkerNotFoundError,
  ContinueWorkflowError,
  type ContinueAuditRecord,
  type ContinuePullRequestIdentity,
  type ContinueReason,
  type ContinueRequest,
  type ContinueResult,
  type ContinueStatusRecord,
  type ContinueWorkerRecord,
  type ContinueWorkerResult,
  type ContinueWorkflowDependencies,
} from "./models";

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new ContinueValidationError(`${field} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function diagnostic(error: unknown, sensitiveValues: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactContinueText(message, sensitiveValues).slice(0, 300);
}

/** Redacts caller-provided and common credential forms before Pi or audit use. */
export function redactContinueText(value: string, sensitiveValues: readonly string[] = []): string {
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

function pullRequest(value: unknown): ContinuePullRequestIdentity {
  if (value === null || typeof value !== "object") throw new ContinueValidationError("pull request identity is required");
  const input = value as ContinuePullRequestIdentity;
  if (!Number.isSafeInteger(input.number) || input.number < 1) throw new ContinueValidationError("pull request number must be positive");
  if (input.repository === null || typeof input.repository !== "object") throw new ContinueValidationError("pull request repository is required");
  const repository = input.repository;
  const checkedRepository = {
    owner: text(repository.owner, "pull request repository owner"),
    name: text(repository.name, "pull request repository name"),
    defaultBranch: text(repository.defaultBranch, "pull request repository default branch"),
    ...(repository.cloneUrl === undefined ? {} : { cloneUrl: text(repository.cloneUrl, "pull request repository clone URL") }),
    ...(repository.webUrl === undefined ? {} : { webUrl: text(repository.webUrl, "pull request repository web URL") }),
  };
  return {
    repository: checkedRepository,
    number: input.number,
    sourceBranch: text(input.sourceBranch, "pull request source branch"),
    targetBranch: text(input.targetBranch, "pull request target branch"),
    ...(input.headSha === undefined ? {} : { headSha: text(input.headSha, "pull request head SHA") }),
  };
}

function sameRepository(left: ContinuePullRequestIdentity["repository"], right: ContinuePullRequestIdentity["repository"]): boolean {
  return left.owner === right.owner
    && left.name === right.name
    && left.defaultBranch === right.defaultBranch
    && left.cloneUrl === right.cloneUrl
    && left.webUrl === right.webUrl;
}

function validateIdentity(worker: ContinueWorkerRecord): ContinueWorkerRecord {
  const containerId = text(worker.containerId, "worker containerId");
  const workspacePath = text(worker.workspacePath, "worker workspacePath");
  const branch = text(worker.branch, "worker branch");
  const identity = pullRequest(worker.pullRequest);
  if (worker.pullRequestNumber !== undefined && worker.pullRequestNumber !== identity.number) {
    throw new ContinueValidationError("pull request identity does not match persisted pull request number");
  }
  if (identity.sourceBranch !== branch) throw new ContinueValidationError("pull request source branch does not match persisted worker branch");
  if (identity.targetBranch !== identity.repository.defaultBranch) throw new ContinueValidationError("pull request target branch does not match repository default branch");
  return { ...worker, containerId, workspacePath, branch, pullRequest: identity };
}

function allowedStates(reason: ContinueReason): readonly WorkerState[] {
  return reason === "retry" ? ["failed", "paused", "stopped"] : ["awaiting-review"];
}

function transitionReason(reason: ContinueReason): string {
  return `ticket continuation: ${reason}`;
}

function defaultContinuationId(input: ContinueRequest & { readonly worker: ContinueWorkerRecord }): string {
  return `continue-${input.worker.workerId}-${input.reason}-${input.instruction ?? input.instructions ?? ""}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .slice(0, 180);
}

function safeResult(value: unknown): ContinueWorkerResult {
  if (value === null || typeof value !== "object") throw new ContinueProviderError("Pi returned an invalid worker result");
  const result = value as ContinueWorkerResult;
  if (result.status !== "completed" && result.status !== "failed") throw new ContinueProviderError("Pi returned an invalid worker result status");
  if (result.readyForReview !== undefined && typeof result.readyForReview !== "boolean") throw new ContinueProviderError("Pi returned an invalid review readiness");
  if (result.commitSha !== undefined && !/^[A-Za-z0-9._-]{1,200}$/u.test(result.commitSha)) {
    throw new ContinueProviderError("Pi returned an invalid commit identity");
  }
  return {
    status: result.status,
    ...(result.readyForReview === undefined ? {} : { readyForReview: result.readyForReview }),
    ...(result.commitSha === undefined ? {} : { commitSha: result.commitSha }),
    ...(result.evidence === undefined ? {} : { evidence: redactContinueText(String(result.evidence)).slice(0, 300) }),
  };
}

/** Coordinates a continuation without provisioning, branch creation, or merge authority. */
export class ContinueWorkflow {
  readonly #dependencies: ContinueWorkflowDependencies;
  readonly #active = new Set<string>();
  readonly #completed = new Set<string>();
  readonly #createContinuationId: NonNullable<ContinueWorkflowDependencies["createContinuationId"]>;

  public constructor(dependencies: ContinueWorkflowDependencies) {
    if (dependencies === null || typeof dependencies !== "object") throw new ContinueValidationError("continue workflow dependencies are required");
    if (dependencies.state === undefined || dependencies.injection === undefined || dependencies.pullRequest === undefined) {
      throw new ContinueValidationError("state, injection, and pull request ports are required");
    }
    this.#dependencies = dependencies;
    this.#createContinuationId = dependencies.createContinuationId ?? defaultContinuationId;
  }

  public async continue(request: ContinueRequest): Promise<ContinueResult> {
    const workerId = text(request?.workerId, "workerId");
    const reason = request?.reason;
    if (reason !== "answer" && reason !== "changes_requested" && reason !== "retry") {
      throw new ContinueValidationError("reason must be answer, changes_requested, or retry");
    }
    const sensitiveValues = request.sensitiveValues ?? [];
    if (!Array.isArray(sensitiveValues) || sensitiveValues.some((value) => typeof value !== "string")) {
      throw new ContinueValidationError("sensitiveValues must be a list of strings");
    }
    const rawInstruction = request.instruction ?? request.instructions;
    const instruction = redactContinueText(text(rawInstruction, "instruction"), sensitiveValues);
    const loaded = await this.#dependencies.state.get(workerId);
    if (loaded === undefined) throw new ContinueWorkerNotFoundError(workerId);
    const worker = validateIdentity(loaded);
    const expectedStates = allowedStates(reason);
    if (!expectedStates.includes(worker.state)) throw new ContinueInvalidStateError(workerId, worker.state, expectedStates.join(" or "));
    const continuationId = text(this.#createContinuationId({ ...request, instruction, worker }), "continuationId");
    const key = `${workerId}\u0000${reason}\u0000${instruction}`;
    if (this.#active.has(key) || this.#completed.has(key)) throw new ContinueDuplicateError(workerId);
    this.#active.add(key);
    try {
      let running = worker;
      if (running.state !== "running") {
        if (canTransition(running.state, "running")) {
          running = await this.#dependencies.state.transition(workerId, "running", {
            actor: "continue-workflow", reason: transitionReason(reason), expectedState: running.state,
          });
        } else if (canTransition(running.state, "recovering")) {
          running = await this.#dependencies.state.transition(workerId, "recovering", {
            actor: "continue-workflow", reason: transitionReason(reason), expectedState: running.state,
          });
          running = await this.#dependencies.state.transition(workerId, "running", {
            actor: "continue-workflow", reason: transitionReason(reason), expectedState: running.state,
          });
        } else {
          throw new ContinueInvalidStateError(workerId, running.state, "a resumable worker state");
        }
      }
      await this.#writeStatus({ continuationId, workerId, reason, outcome: "started", state: running.state, message: "continuation started" });
      const input = {
        workerId,
        containerId: worker.containerId,
        workspacePath: worker.workspacePath as string,
        branch: worker.branch as string,
        pullRequest: worker.pullRequest,
        reason,
        instruction,
        preserveUncommittedWork: true as const,
      };
      let result: ContinueWorkerResult;
      try {
        result = safeResult(await this.#dependencies.injection.inject(input));
      } catch (error) {
        await this.#fail(workerId, reason, continuationId, diagnostic(error, sensitiveValues));
        throw error instanceof ContinueWorkflowError ? error : new ContinueProviderError(`Pi continuation failed: ${diagnostic(error, sensitiveValues)}`, { cause: error });
      }
      let current: ContinueWorkerRecord;
      if (result.commitSha !== undefined) current = await this.#dependencies.state.update(workerId, { commitSha: result.commitSha });
      else current = running;
      const target: WorkerState = result.status === "failed" ? "failed" : result.readyForReview === false ? "running" : "awaiting-review";
      if (current.state !== target) {
        if (!canTransition(current.state, target)) throw new ContinueProviderError(`cannot record continuation result as ${target}`);
        current = await this.#dependencies.state.transition(workerId, target, {
          actor: "continue-workflow", reason: result.status === "failed" ? "continued worker failed" : "continued worker completed",
          expectedState: current.state, providerEvidence: result.commitSha,
        });
      }
      let pullRequestStatus: ContinueResult["pullRequestStatus"];
      try {
        const reconciled = await this.#dependencies.pullRequest.reconcile({ workerId, pullRequest: worker.pullRequest, result });
        pullRequestStatus = reconciled === undefined ? undefined : reconciled;
      } catch (error) {
        await this.#fail(workerId, reason, continuationId, diagnostic(error, sensitiveValues));
        throw new ContinueProviderError(`pull request reconciliation failed: ${diagnostic(error, sensitiveValues)}`, { cause: error });
      }
      this.#completed.add(key);
      await this.#writeStatus({ continuationId, workerId, reason, outcome: result.status === "failed" ? "failed" : "succeeded", state: current.state, message: result.status === "failed" ? "continued worker failed" : "continuation reconciled" });
      await this.#writeAudit({ continuationId, workerId, reason, outcome: result.status === "failed" ? "failed" : "succeeded", state: current.state, details: { pullRequestNumber: worker.pullRequest.number, result: result.status } });
      return { continuationId, worker: current, result, ...(pullRequestStatus === undefined ? {} : { pullRequestStatus }), instruction };
    } finally {
      this.#active.delete(key);
    }
  }

  /** Alias used by callers that name the operation continueTicket. */
  public continueTicket(request: ContinueRequest): Promise<ContinueResult> {
    return this.continue(request);
  }

  async #fail(workerId: string, reason: ContinueReason, continuationId: string, message: string): Promise<void> {
    const current = await this.#dependencies.state.get(workerId);
    let state = current?.state ?? "failed";
    if (current !== undefined && current.state !== "failed" && canTransition(current.state, "failed")) {
      const failed = await this.#dependencies.state.transition(workerId, "failed", { actor: "continue-workflow", reason: "continuation failed", expectedState: current.state });
      state = failed.state;
    }
    await this.#writeStatus({ continuationId, workerId, reason, outcome: "failed", state, message: "continuation failed" });
    await this.#writeAudit({ continuationId, workerId, reason, outcome: "failed", state, details: { error: message } });
  }

  async #writeStatus(record: ContinueStatusRecord): Promise<void> {
    try { await this.#dependencies.status?.write(record); } catch { /* status is observational and must not hide the primary result */ }
  }

  async #writeAudit(record: ContinueAuditRecord): Promise<void> {
    try { await this.#dependencies.audit?.record(record); } catch { /* audit is observational and must not hide the primary result */ }
  }
}

export function createContinueWorkflow(dependencies: ContinueWorkflowDependencies): ContinueWorkflow {
  return new ContinueWorkflow(dependencies);
}
