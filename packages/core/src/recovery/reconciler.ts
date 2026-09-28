import type { PullRequestRef } from "../github/models";
import type { CreatePullRequestInput } from "../github/transports";
import type { WorkerStateStore } from "../state/store";
import { canTransition, type WorkerRecord, type WorkerState } from "../state/models";
import {
  asTimestamp,
  delayForAttempt,
  type RecoveryAttempt,
  type RecoveryClock,
  type RecoveryFailureClassification,
  type RecoveryPolicy,
  type RecoveryResult,
  type WorkerHeartbeat,
  DEFAULT_RECOVERY_POLICY,
  validateRecoveryPolicy,
} from "./models";
import {
  classifyRecoveryFailure,
  defaultRecoveryClock,
  staleHeartbeat,
} from "./policy";
import type { GitHubReconciliationPort, LinearReconciliationPort, RecoveryPorts, WorkerResumePort } from "./ports";

export interface PullRequestRecoveryOptions {
  readonly ref?: (worker: WorkerRecord) => PullRequestRef | undefined;
  readonly title?: (worker: WorkerRecord) => string;
  readonly body?: (worker: WorkerRecord) => string | undefined;
}

export interface RecoveryCoordinatorOptions {
  readonly policy?: Partial<RecoveryPolicy>;
  readonly clock?: RecoveryClock;
  readonly pullRequest?: PullRequestRecoveryOptions;
  readonly linearStatus?: "In Progress" | "In Review" | "Done" | "Todo";
}

function mergePolicy(overrides: Partial<RecoveryPolicy> | undefined): RecoveryPolicy {
  return validateRecoveryPolicy({ ...DEFAULT_RECOVERY_POLICY, ...(overrides ?? {}) });
}

function genericReason(classification: RecoveryFailureClassification): string {
  return `recovery ${classification.kind}`;
}

function workerRef(worker: WorkerRecord): PullRequestRef | undefined {
  if (worker.repository === undefined || worker.branch === undefined) return undefined;
  const separator = worker.repository.indexOf("/");
  if (separator <= 0 || separator === worker.repository.length - 1) return undefined;
  return {
    repository: {
      owner: worker.repository.slice(0, separator),
      name: worker.repository.slice(separator + 1),
      defaultBranch: "main",
    },
    sourceBranch: worker.branch,
    targetBranch: "main",
  };
}

function classificationForHeartbeat(heartbeat: WorkerHeartbeat): RecoveryFailureClassification | undefined {
  if (heartbeat.status === "healthy") return undefined;
  const kind = heartbeat.status === "unknown" ? "unknown" : heartbeat.status;
  return {
    kind,
    recoverable: kind !== "unknown",
    retryable: kind !== "unknown",
    reason: heartbeat.reason ?? `worker is ${heartbeat.status}`,
  };
}

/**
 * Reconciles persisted SQLite worker records against runtime and provider ports.
 * Runtime identity is always the persisted worker id; no credentials or provider
 * response bodies are written to state.
 */
export class RecoveryCoordinator {
  readonly #store: WorkerStateStore;
  readonly #ports: RecoveryPorts;
  readonly #policy: RecoveryPolicy;
  readonly #clock: RecoveryClock;
  readonly #pullRequest: PullRequestRecoveryOptions;
  readonly #linearStatus: RecoveryCoordinatorOptions["linearStatus"];
  readonly #active = new Set<string>();

  public constructor(store: WorkerStateStore, ports: RecoveryPorts, options: RecoveryCoordinatorOptions = {}) {
    if (store === null || typeof store !== "object") throw new TypeError("a worker state store is required");
    if (ports === null || typeof ports !== "object" || ports.health === undefined) throw new TypeError("a health port is required");
    this.#store = store;
    this.#ports = ports;
    this.#policy = mergePolicy(options.policy);
    this.#clock = options.clock ?? defaultRecoveryClock();
    this.#pullRequest = options.pullRequest ?? {};
    this.#linearStatus = options.linearStatus ?? "In Progress";
  }

  public async reconcileAll(): Promise<readonly RecoveryResult[]> {
    const results: RecoveryResult[] = [];
    for (const worker of this.#store.listRecovery()) results.push(await this.reconcile(worker.workerId));
    return results;
  }

  public async reconcile(workerId: string): Promise<RecoveryResult> {
    if (this.#active.has(workerId)) {
      return { workerId, status: "skipped", attempts: [] };
    }
    this.#active.add(workerId);
    try {
      const worker = this.#store.getRecoveryState(workerId);
      if (worker === undefined) return { workerId, status: "skipped", attempts: [] };
      return await this.reconcileRecord(worker);
    } finally {
      this.#active.delete(workerId);
    }
  }

  private async reconcileRecord(worker: WorkerRecord): Promise<RecoveryResult> {
    const attempts: RecoveryAttempt[] = [];
    let heartbeat: WorkerHeartbeat;
    try {
      heartbeat = await this.#probe(worker, attempts);
    } catch (error) {
      const classification = classifyRecoveryFailure(error);
      this.recordFailure(worker, classification);
      return { workerId: worker.workerId, status: "failed", classification, attempts };
    }

    let classification = classificationForHeartbeat(heartbeat);
    const heartbeatTime = heartbeat.heartbeatAt ?? worker.updatedAt;
    if (classification === undefined && staleHeartbeat(heartbeatTime, this.#clock.now(), this.#policy.staleAfterMs)) {
      classification = { kind: "stale", recoverable: true, retryable: true, reason: "worker heartbeat is stale" };
    }

    if (classification !== undefined) {
      if (!classification.recoverable || this.#ports.resume === undefined && !this.isResumableHealthPort()) {
        this.recordFailure(worker, classification);
        return { workerId: worker.workerId, status: "failed", classification, attempts };
      }
      const resumed = await this.resume(worker, classification, attempts);
      if (!resumed) return { workerId: worker.workerId, status: "failed", classification, attempts };
      worker = this.#store.get(worker.workerId) ?? worker;
    } else if (worker.state === "recovering") {
      // A healthy worker that survived a coordinator restart still needs its
      // lifecycle transaction completed before provider reconciliation.
      this.transition(worker, "running", "heartbeat healthy");
      worker = this.#store.get(worker.workerId) ?? worker;
    }

    const pullRequestNumber = await this.reconcileProviders(worker, attempts);
    return { workerId: worker.workerId, status: classification === undefined ? "healthy" : "resumed", attempts, pullRequestNumber };
  }

  private isResumableHealthPort(): boolean {
    return typeof (this.#ports.health as unknown as WorkerResumePort).resume === "function";
  }

  async #probe(worker: WorkerRecord, attempts: RecoveryAttempt[]): Promise<WorkerHeartbeat> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.#policy.maxAttempts; attempt += 1) {
      try {
        const heartbeat = await this.#ports.health.heartbeat(worker);
        attempts.push({ attempt, delayMs: 0 });
        return heartbeat;
      } catch (error) {
        last = error;
        const classification = classifyRecoveryFailure(error);
        attempts.push({ attempt, delayMs: attempt >= this.#policy.maxAttempts ? 0 : delayForAttempt(this.#policy, attempt), classification });
        if (!classification.retryable || attempt >= this.#policy.maxAttempts) throw error;
        await this.#clock.sleep(delayForAttempt(this.#policy, attempt));
      }
    }
    throw last ?? new Error("health probe failed");
  }

  private async resume(worker: WorkerRecord, classification: RecoveryFailureClassification, attempts: RecoveryAttempt[]): Promise<boolean> {
    let current = this.#store.get(worker.workerId) ?? worker;
    if (current.state !== "recovering") {
      if (!canTransition(current.state, "recovering")) {
        this.recordFailure(current, classification);
        return false;
      }
      current = this.transition(current, "recovering", genericReason(classification));
    }
    const resumePort = this.#ports.resume ?? (this.isResumableHealthPort() ? this.#ports.health as unknown as WorkerResumePort : undefined);
    if (resumePort === undefined) return false;
    let last: unknown;
    for (let attempt = 1; attempt <= this.#policy.maxAttempts; attempt += 1) {
      try {
        const result = await resumePort.resume(current);
        attempts.push({ attempt, delayMs: 0 });
        if (result.processId !== undefined || result.containerId !== undefined) {
          this.#store.update(current.workerId, {
            processId: result.processId,
          });
        }
        this.transition(current, "running", "worker resumed");
        return true;
      } catch (error) {
        last = error;
        const next = classifyRecoveryFailure(error);
        attempts.push({ attempt, delayMs: attempt >= this.#policy.maxAttempts ? 0 : delayForAttempt(this.#policy, attempt), classification: next });
        if (!next.retryable || attempt >= this.#policy.maxAttempts) {
          this.recordFailure(current, next);
          break;
        }
        await this.#clock.sleep(delayForAttempt(this.#policy, attempt));
      }
    }
    void last;
    return false;
  }

  private transition(worker: WorkerRecord, state: WorkerState, reason: string): WorkerRecord {
    return this.#store.transition(worker.workerId, state, {
      actor: "recovery",
      reason,
      at: asTimestamp(this.#clock.now()),
      expectedState: worker.state,
    });
  }

  private recordFailure(worker: WorkerRecord, classification: RecoveryFailureClassification): void {
    // Keep only a bounded, typed reason in SQLite. Provider errors may contain
    // credentials or response bodies and must never be persisted.
    const reason = genericReason(classification);
    const current = this.#store.get(worker.workerId) ?? worker;
    if (canTransition(current.state, "failed")) {
      this.#store.transition(current.workerId, "failed", { actor: "recovery", reason, at: asTimestamp(this.#clock.now()), expectedState: current.state });
    }
    this.#store.update(current.workerId, { reason, lastError: reason });
  }

  private async reconcileProviders(worker: WorkerRecord, attempts: RecoveryAttempt[]): Promise<number | undefined> {
    let number: number | undefined;
    if (this.#ports.github !== undefined) {
      try {
        number = await this.reconcilePullRequest(worker, this.#ports.github);
      } catch (error) {
        const classification = classifyRecoveryFailure(error);
        attempts.push({ attempt: 1, delayMs: 0, classification });
        // Provider reconciliation is recoverable independently of a healthy
        // runtime; leave the worker running for the next reconciliation pass.
      }
    }
    if (this.#ports.linear !== undefined && worker.issueIdentifier !== undefined) {
      try {
        await this.reconcileLinear(worker, this.#ports.linear);
      } catch (error) {
        attempts.push({ attempt: 1, delayMs: 0, classification: classifyRecoveryFailure(error) });
      }
    }
    return number;
  }

  private async reconcilePullRequest(worker: WorkerRecord, github: GitHubReconciliationPort): Promise<number | undefined> {
    if (worker.pullRequestNumber !== undefined) {
      if (github.getPullRequest !== undefined && worker.repository !== undefined) {
        const customRef = this.#pullRequest.ref?.(worker);
        const repository = customRef?.repository ?? workerRef(worker)?.repository;
        if (repository !== undefined) await github.getPullRequest(repository, worker.pullRequestNumber);
      }
      return worker.pullRequestNumber;
    }
    if (worker.commitSha === undefined) return undefined;
    const ref = this.#pullRequest.ref?.(worker) ?? workerRef(worker);
    if (ref === undefined) return undefined;
    const existing = await github.findPullRequest(ref);
    if (existing !== undefined) {
      this.#store.update(worker.workerId, { pullRequestNumber: existing.number });
      return existing.number;
    }
    const input: CreatePullRequestInput = {
      ...ref,
      title: this.#pullRequest.title?.(worker) ?? `${worker.issueIdentifier ?? worker.workerId}: worker changes`,
      body: this.#pullRequest.body?.(worker),
    };
    try {
      const created = await github.createPullRequest(input);
      this.#store.update(worker.workerId, { pullRequestNumber: created.number });
      return created.number;
    } catch (error) {
      // A timeout can happen after GitHub accepted the create. Discover by
      // branch before allowing a future pass to create another PR.
      const accepted = await github.findPullRequest(ref);
      if (accepted === undefined) throw error;
      this.#store.update(worker.workerId, { pullRequestNumber: accepted.number });
      return accepted.number;
    }
  }

  private async reconcileLinear(worker: WorkerRecord, linear: LinearReconciliationPort): Promise<void> {
    const issue = await linear.getIssue(worker.issueIdentifier as string);
    if (issue === null || issue.status.name === this.#linearStatus) return;
    await linear.updateIssue({ identifier: issue.identifier, issueId: issue.id, status: this.#linearStatus as "In Progress" | "In Review" | "Done" | "Todo" });
  }
}

/** Alias emphasizing the reconciliation role for hosts that prefer that name. */
export const RecoveryReconciler = RecoveryCoordinator;
