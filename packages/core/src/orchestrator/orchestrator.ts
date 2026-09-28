import type { WorkerAgentRequest, WorkerAgentResult, WorkerAgentRun } from "../agent/worker-agent";
import type { PullRequest, Repository } from "../github/models";
import type { LinearIssue, LinearIssueStatusName } from "../linear/types";
import { canTransition, type WorkerInput, type WorkerRecord, type WorkerState } from "../state/models";
import type { WorkspaceMetadata, WorkspaceProvisionRequest } from "../workspace/provisioner";

/** The Linear operations needed by one worker run. */
export interface OrchestratorLinearPort {
  getIssue(identifier: string): Promise<LinearIssue | null>;
  setStatus(identifier: string, status: LinearIssueStatusName): Promise<LinearIssue>;
  /** Optional, because a host may choose another diagnostics sink. */
  addComment?(input: { readonly identifier: string; readonly body: string }): Promise<unknown>;
}

/** A deliberately small state seam, allowing an in-memory store in tests. */
export interface OrchestratorStatePort {
  get(workerId: string): WorkerRecord | undefined | Promise<WorkerRecord | undefined>;
  listByIssue(identifier: string): readonly WorkerRecord[] | Promise<readonly WorkerRecord[]>;
  create(input: WorkerInput): WorkerRecord | Promise<WorkerRecord>;
  transition(workerId: string, state: WorkerState, options?: {
    readonly actor?: string;
    readonly reason?: string;
    readonly expectedState?: WorkerState;
    readonly providerEvidence?: string;
  }): WorkerRecord | Promise<WorkerRecord>;
  update(workerId: string, patch: Partial<Omit<WorkerRecord, "workerId" | "state" | "createdAt" | "updatedAt" | "lastTransitionAt">>): WorkerRecord | Promise<WorkerRecord>;
}

export interface DockerProvisionRequest {
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly repository: Repository;
  readonly workspacePath: string;
}

export interface DockerProvisionResult {
  readonly containerId: string;
  readonly imageDigest?: string;
}

/** Docker policy remains in the Docker adapter; orchestration only sequences it. */
export interface OrchestratorDockerPort {
  provision(request: DockerProvisionRequest): Promise<DockerProvisionResult>;
}

export interface OrchestratorWorkspacePort {
  provision(request: WorkspaceProvisionRequest): Promise<WorkspaceMetadata>;
}

export interface OrchestratorTmuxPort {
  ensure(workerId: string, workspacePath: string): Promise<{ readonly sessionName: string }>;
}

export interface OrchestratorPullRequestPort {
  /** Implementations must detect an existing PR and reconcile a retry safely. */
  findOrCreate(input: {
    readonly repository: Repository;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly body?: string;
  }): Promise<PullRequest>;
}

/** Agent ports intentionally use the existing ticket-scoped Pi boundary. */
export interface OrchestratorAgentPort {
  start(request: WorkerAgentRequest): Promise<WorkerAgentRun>;
}

export interface OrchestratorClockPort {
  now(): string;
}

export interface WorkerOrchestratorDependencies {
  readonly linear: OrchestratorLinearPort;
  readonly state: OrchestratorStatePort;
  readonly docker: OrchestratorDockerPort;
  readonly workspace: OrchestratorWorkspacePort;
  readonly tmux: OrchestratorTmuxPort;
  readonly agent: OrchestratorAgentPort;
  readonly pullRequest: OrchestratorPullRequestPort;
  readonly clock?: OrchestratorClockPort;
}

export interface WorkerOrchestrationRequest {
  readonly issueIdentifier: string;
  readonly workerId?: string;
  readonly project?: string;
  readonly repository: Repository;
  readonly workspacePath: string;
  readonly definitionOfDone?: readonly string[];
  readonly securityRules?: readonly string[];
  readonly branchPrefix?: string;
  readonly timeoutMs?: number;
  readonly sensitiveValues?: readonly string[];
}

export interface WorkerOrchestrationResult {
  readonly worker: WorkerRecord;
  readonly issue: LinearIssue;
  readonly pullRequest?: PullRequest;
  readonly agent?: WorkerAgentResult;
  readonly resumed: boolean;
}

export class WorkerOrchestratorError extends Error {
  readonly workerId?: string;
  readonly phase: string;

  public constructor(phase: string, message: string, workerId?: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "WorkerOrchestratorError";
    this.phase = phase;
    this.workerId = workerId;
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    throw new WorkerOrchestratorError("validate", `${field} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function safeDiagnostic(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret.length > 0) text = text.replaceAll(secret, "[REDACTED]");
  text = text.replace(/\b(?:ghp|gho|ghs|ghu|github_pat|glpat|sk|xox[baprs])[-_][A-Za-z0-9_-]+/gu, "[REDACTED]");
  text = text.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]");
  text = text.replace(/([?&](?:token|access_token|api[_-]?key|password|secret)=)[^&\s]+/giu, "$1[REDACTED]");
  text = text.replace(/\b(token|access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
  return text.slice(0, 500);
}

function workerIdForIssue(identifier: string): string {
  const slug = identifier.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `worker-${slug || "issue"}`;
}

function repositoryText(repository: Repository): string {
  return repository.cloneUrl ?? `${repository.owner}/${repository.name}`;
}

function isTerminal(record: WorkerRecord): boolean {
  return record.state === "awaiting-review" || record.state === "destroyed";
}

function validateRequest(request: WorkerOrchestrationRequest): void {
  requiredText(request.issueIdentifier, "issueIdentifier");
  requiredText(request.workspacePath, "workspacePath");
  if (!request.repository || !requiredText(request.repository.owner, "repository.owner") || !requiredText(request.repository.name, "repository.name")) {
    throw new WorkerOrchestratorError("validate", "repository owner and name are required");
  }
  requiredText(request.repository.defaultBranch, "repository.defaultBranch");
}

/**
 * Sequences the happy path for exactly one Linear issue. All provider policy is
 * injected, so this class does not shell out, own credentials, or duplicate an
 * adapter's reconciliation logic.
 */
export class WorkerOrchestrator {
  readonly #dependencies: WorkerOrchestratorDependencies;
  readonly #inFlight = new Set<string>();

  public constructor(dependencies: WorkerOrchestratorDependencies) {
    if (!dependencies || typeof dependencies !== "object") throw new WorkerOrchestratorError("validate", "orchestrator dependencies are required");
    this.#dependencies = dependencies;
  }

  public async run(request: WorkerOrchestrationRequest): Promise<WorkerOrchestrationResult> {
    validateRequest(request);
    const identifier = request.issueIdentifier.trim();
    if (this.#inFlight.has(identifier)) throw new WorkerOrchestratorError("duplicate", `issue ${identifier} is already running`);
    this.#inFlight.add(identifier);
    try {
      return await this.#run(request, identifier);
    } finally {
      this.#inFlight.delete(identifier);
    }
  }

  /** Alias for hosts that name the operation start. */
  public start(request: WorkerOrchestrationRequest): Promise<WorkerOrchestrationResult> {
    return this.run(request);
  }

  async #run(request: WorkerOrchestrationRequest, identifier: string): Promise<WorkerOrchestrationResult> {
    const issue = await this.#dependencies.linear.getIssue(identifier);
    if (issue === null) throw new WorkerOrchestratorError("load-issue", `Linear issue ${identifier} was not found`);
    if (issue.identifier !== identifier) throw new WorkerOrchestratorError("validate-issue", "Linear returned a different issue identifier");

    const records = await this.#dependencies.state.listByIssue(identifier);
    if (records.length > 1) throw new WorkerOrchestratorError("duplicate", `issue ${identifier} has multiple workers`);
    let worker = records[0];
    if (worker?.state === "awaiting-review") {
      return { worker, issue, resumed: true };
    }
    if (worker?.state === "destroyed") {
      throw new WorkerOrchestratorError("duplicate", `issue ${identifier} already belongs to destroyed worker ${worker.workerId}`, worker.workerId);
    }
    if (issue.status.name !== "Todo" && worker === undefined) {
      throw new WorkerOrchestratorError("validate-issue", `issue ${identifier} must be Todo (was ${issue.status.name})`);
    }

    const workerId = worker?.workerId ?? request.workerId?.trim() ?? workerIdForIssue(identifier);
    if (worker === undefined) {
      const workerWithRequestedId = await this.#dependencies.state.get(workerId);
      if (workerWithRequestedId !== undefined) {
        if (workerWithRequestedId.issueIdentifier !== identifier) {
          throw new WorkerOrchestratorError("duplicate", `worker ${workerId} is assigned to another issue`, workerId);
        }
        worker = workerWithRequestedId;
      } else {
        worker = await this.#dependencies.state.create({
          workerId,
          issueIdentifier: identifier,
          project: request.project,
          repository: `${request.repository.owner}/${request.repository.name}`,
          state: "queued",
        });
      }
    } else if (worker.issueIdentifier !== identifier) {
      throw new WorkerOrchestratorError("duplicate", `worker ${worker.workerId} is assigned to another issue`, worker.workerId);
    }

    try {
      // A failed worker resumes through recovering; a stopped worker can be
      // provisioned directly. Every other non-terminal state follows its path.
      if (worker.state === "failed") worker = await this.#transition(worker, "recovering", "retrying failed worker");
      if (worker.state === "stopped") worker = await this.#transition(worker, "provisioning", "restarting stopped worker");
      if (worker.state === "queued") worker = await this.#transition(worker, "provisioning", "provisioning worker");
      await this.#dependencies.linear.setStatus(identifier, "In Progress");
      const docker = await this.#dependencies.docker.provision({
        workerId: worker.workerId,
        issueIdentifier: identifier,
        repository: request.repository,
        workspacePath: request.workspacePath,
      });
      worker = await this.#dependencies.state.update(worker.workerId, {
        imageDigest: docker.imageDigest,
        workspacePath: request.workspacePath,
      });
      const workspace = await this.#dependencies.workspace.provision({
        path: request.workspacePath,
        repository: request.repository,
        issueIdentifier: identifier,
        issueSlug: issue.title,
        branchPrefix: request.branchPrefix,
      });
      worker = await this.#dependencies.state.update(worker.workerId, {
        workspacePath: workspace.path,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
      });
      await this.#dependencies.tmux.ensure(worker.workerId, workspace.path);
      if (worker.state === "provisioning" || worker.state === "recovering") worker = await this.#transition(worker, "running", "worker resources ready");

      const agent = await this.#dependencies.agent.start({
        issue: { identifier, title: issue.title, ...(issue.description === undefined ? {} : { description: issue.description }) },
        repository: repositoryText(request.repository),
        branch: workspace.branch,
        definitionOfDone: request.definitionOfDone ?? ["Implement the requested ticket and leave the branch ready for review."],
        securityRules: request.securityRules ?? ["Do not expose credentials; do not merge protected branches."],
        workspacePath: workspace.path,
        timeoutMs: request.timeoutMs,
        sensitiveValues: request.sensitiveValues,
      });
      const agentResult = await agent.wait();
      if (agentResult.status !== "completed") throw new WorkerOrchestratorError("agent", agentResult.failure?.message ?? "Pi worker failed", worker.workerId);

      const pullRequest = await this.#dependencies.pullRequest.findOrCreate({
        repository: request.repository,
        sourceBranch: workspace.branch,
        targetBranch: request.repository.defaultBranch,
        title: `${identifier}: ${issue.title}`,
        body: issue.description,
      });
      worker = await this.#dependencies.state.update(worker.workerId, { pullRequestNumber: pullRequest.number });
      worker = await this.#transition(worker, "awaiting-review", "pull request ready for review", String(pullRequest.number));
      const reviewedIssue = await this.#dependencies.linear.setStatus(identifier, "In Review");
      return { worker, issue: reviewedIssue, pullRequest, agent: agentResult, resumed: false };
    } catch (error) {
      worker = await this.#attributeFailure(worker, error, request.sensitiveValues ?? []);
      throw new WorkerOrchestratorError("worker", safeDiagnostic(error, request.sensitiveValues), worker.workerId, { cause: error });
    }
  }

  async #transition(worker: WorkerRecord, state: WorkerState, reason: string, evidence?: string): Promise<WorkerRecord> {
    return this.#dependencies.state.transition(worker.workerId, state, { actor: "orchestrator", reason, providerEvidence: evidence });
  }

  async #attributeFailure(worker: WorkerRecord, error: unknown, secrets: readonly string[]): Promise<WorkerRecord> {
    const message = safeDiagnostic(error, secrets);
    let current = await this.#dependencies.state.update(worker.workerId, { lastError: message, reason: message });
    if (canTransition(current.state, "failed")) {
      current = await this.#dependencies.state.transition(current.workerId, "failed", { actor: "orchestrator", reason: message });
    }
    try {
      await this.#dependencies.linear.addComment?.({
        identifier: worker.issueIdentifier ?? worker.workerId,
        body: `Worker ${worker.workerId} failed safely during orchestration: ${message}`,
      });
    } catch {
      // Diagnostics must never hide the original provider failure.
    }
    return current;
  }
}

/** Factory spelling for dependency-injection containers. */
export function createWorkerOrchestrator(dependencies: WorkerOrchestratorDependencies): WorkerOrchestrator {
  return new WorkerOrchestrator(dependencies);
}
