import type { WorkerAgentRequest, WorkerAgentResult, WorkerAgentRun } from "../agent/worker-agent";
import type { PullRequest, Repository } from "../github/models";
import type { LinearIssue, LinearIssueStatusName } from "../linear/types";
import {
  WorkerOrchestrator,
  type OrchestratorAgentPort,
  type OrchestratorDockerPort,
  type OrchestratorLinearPort,
  type OrchestratorPullRequestPort,
  type OrchestratorStatePort,
  type OrchestratorTmuxPort,
  type OrchestratorWorkspacePort,
} from "../orchestrator/orchestrator";
import { canTransition, type WorkerInput, type WorkerRecord, type WorkerState } from "../state/models";
import type { WorkspaceMetadata } from "../workspace/provisioner";

export type DogfoodInteraction = "none" | "question" | "review";

export interface DogfoodTicket {
  readonly issueIdentifier: string;
  readonly title: string;
  readonly interaction: DogfoodInteraction;
  /** Only one ticket may be selected for the explicit merge assertion. */
  readonly merge?: boolean;
}

export interface DogfoodScenarioOptions {
  readonly tickets?: readonly DogfoodTicket[];
  /** Live providers are intentionally not part of this credential-free harness. */
  readonly enableLiveProviders?: boolean;
}

export interface DogfoodLinearPort extends OrchestratorLinearPort {
  snapshot(): readonly LinearIssue[];
}

export interface DogfoodStatePort extends OrchestratorStatePort {
  get(workerId: string): WorkerRecord | undefined;
  snapshot(): readonly WorkerRecord[];
}

export interface DogfoodDockerPort extends OrchestratorDockerPort {
  cleanup(workerId: string, containerId: string): Promise<void>;
  activeWorkerIds(): readonly string[];
}

export interface DogfoodWorkspacePort extends OrchestratorWorkspacePort {}

export interface DogfoodTmuxPort extends OrchestratorTmuxPort {
  cleanup(workerId: string): Promise<void>;
  activeWorkerIds(): readonly string[];
}

export interface DogfoodAgentPort extends OrchestratorAgentPort {
  continueRun(request: WorkerAgentRequest & { readonly workerId: string }): Promise<WorkerAgentResult>;
  runs(): readonly DogfoodAgentRunRecord[];
}

export interface DogfoodPullRequestPort extends OrchestratorPullRequestPort {
  merge(input: { readonly repository: Repository; readonly number: number; readonly workerId: string }): Promise<PullRequest>;
  cleanupBranch(input: { readonly repository: Repository; readonly sourceBranch: string; readonly workerId: string }): Promise<void>;
  snapshot(): readonly PullRequest[];
  mergeCount(): number;
}

export interface DogfoodClockPort {
  now(): string;
}

export interface DogfoodPorts {
  readonly linear: DogfoodLinearPort;
  readonly state: DogfoodStatePort;
  readonly docker: DogfoodDockerPort;
  readonly workspace: DogfoodWorkspacePort;
  readonly tmux: DogfoodTmuxPort;
  readonly agent: DogfoodAgentPort;
  readonly pullRequest: DogfoodPullRequestPort;
  readonly clock: DogfoodClockPort;
}

export interface DogfoodAgentRunRecord {
  readonly kind: "start" | "continue";
  readonly workerId: string;
  readonly issueIdentifier: string;
  readonly workspacePath: string;
  readonly branch: string;
}

export interface DogfoodWorkerProjection {
  readonly issueIdentifier: string;
  readonly workerId: string;
  readonly interaction: DogfoodInteraction;
  readonly finalState: WorkerState;
  readonly linearStatus: LinearIssueStatusName;
  readonly pullRequestNumber: number;
  readonly pullRequestState: PullRequest["state"];
  readonly dockerCleaned: boolean;
  readonly tmuxCleaned: boolean;
}

export interface DogfoodScenarioReport {
  readonly execution: {
    readonly mode: "fake";
    readonly liveProvidersSkipped: true;
    readonly reason: string;
  };
  readonly workers: readonly DogfoodWorkerProjection[];
  readonly agentRuns: readonly DogfoodAgentRunRecord[];
  readonly calls: readonly string[];
  readonly assertions: {
    readonly workerIsolation: true;
    readonly sameWorkerQuestionAndReview: true;
    readonly exactlyOneExplicitMerge: true;
    readonly cleanup: true;
    readonly consistentProjections: true;
  };
}

export class DogfoodScenarioError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DogfoodScenarioError";
  }
}

const repository: Repository = {
  owner: "dogfood",
  name: "dummy-repository",
  defaultBranch: "main",
  cloneUrl: "https://example.invalid/dogfood/dummy-repository.git",
};

const defaultTickets: readonly DogfoodTicket[] = [
  { issueIdentifier: "DEV-28-A", title: "Dogfood ticket A", interaction: "none" },
  { issueIdentifier: "DEV-28-B", title: "Dogfood ticket B", interaction: "question" },
  { issueIdentifier: "DEV-28-C", title: "Dogfood ticket C", interaction: "review", merge: true },
];

function workerIdFor(identifier: string): string {
  return `worker-${identifier.toLowerCase()}`;
}

function issueFor(ticket: DogfoodTicket): LinearIssue {
  return {
    id: `issue-${ticket.issueIdentifier}`,
    identifier: ticket.issueIdentifier,
    title: ticket.title,
    description: `Implement the deterministic ${ticket.issueIdentifier} dogfood change.`,
    status: { id: `status-${ticket.issueIdentifier}`, name: "Todo" },
  };
}

function requireWorker(state: DogfoodStatePort, workerId: string): WorkerRecord {
  const worker = state.get(workerId);
  if (worker === undefined) throw new DogfoodScenarioError(`worker ${workerId} is missing`);
  return worker;
}

function requireIssue(linear: DogfoodLinearPort, identifier: string): LinearIssue {
  const issue = linear.snapshot().find((candidate) => candidate.identifier === identifier);
  if (issue === undefined) throw new DogfoodScenarioError(`issue ${identifier} is missing`);
  return issue;
}

/**
 * Runs three tickets through the real single-worker orchestrator with every
 * external boundary injected. The continuation and cleanup steps are kept in
 * this harness because those operations intentionally have no provider policy
 * in WorkerOrchestrator.
 */
export async function runDogfoodScenario(
  ports: DogfoodPorts,
  options: DogfoodScenarioOptions = {},
): Promise<DogfoodScenarioReport> {
  if (options.enableLiveProviders === true) {
    throw new DogfoodScenarioError(
      "live provider execution is disabled; inject explicit providers outside the credential-free harness",
    );
  }
  const tickets = options.tickets ?? defaultTickets;
  if (tickets.length !== 3) throw new DogfoodScenarioError("the dogfood scenario requires exactly three tickets");
  if (tickets.filter((ticket) => ticket.merge === true).length !== 1) {
    throw new DogfoodScenarioError("the dogfood scenario requires exactly one merge ticket");
  }

  for (const ticket of tickets) {
    const existing = ports.linear.snapshot().find((issue) => issue.identifier === ticket.issueIdentifier);
    if (existing === undefined) {
      throw new DogfoodScenarioError(`injected Linear port does not contain ${ticket.issueIdentifier}`);
    }
  }

  const calls: string[] = [];
  const orchestrator = new WorkerOrchestrator({
    linear: ports.linear,
    state: ports.state,
    docker: ports.docker,
    workspace: ports.workspace,
    tmux: ports.tmux,
    agent: ports.agent,
    pullRequest: ports.pullRequest,
    clock: ports.clock,
  });

  const results = await Promise.all(tickets.map(async (ticket) => {
    const workerId = workerIdFor(ticket.issueIdentifier);
    const result = await orchestrator.run({
      issueIdentifier: ticket.issueIdentifier,
      workerId,
      project: "DEV-28-dogfood",
      repository,
      workspacePath: `/dogfood/workspaces/${ticket.issueIdentifier.toLowerCase()}`,
      definitionOfDone: ["Make the dummy change and leave a reviewable branch."],
      securityRules: ["Use no credentials and do not merge from the worker."],
    });
    calls.push(`${ticket.issueIdentifier}:provisioned`);
    return { ticket, workerId, result };
  }));

  for (const { ticket, workerId, result } of results) {
    let worker = requireWorker(ports.state, workerId);
    if (worker.state !== "awaiting-review" || result.worker.workerId !== workerId) {
      throw new DogfoodScenarioError(`${ticket.issueIdentifier} did not reach awaiting-review on its original worker`);
    }
    const issue = requireIssue(ports.linear, ticket.issueIdentifier);
    const branch = worker.branch;
    const workspacePath = worker.workspacePath;
    if (branch === undefined || workspacePath === undefined) {
      throw new DogfoodScenarioError(`${workerId} has incomplete workspace projection`);
    }

    if (ticket.interaction === "question") {
      worker = await ports.state.transition(workerId, "paused", { actor: "dogfood", reason: "worker asked a question" });
      await ports.linear.addComment?.({ identifier: ticket.issueIdentifier, body: "Question answered by deterministic fixture." });
      worker = await ports.state.transition(workerId, "running", { actor: "dogfood", reason: "question answered" });
      await ports.linear.setStatus(ticket.issueIdentifier, "In Progress");
      await ports.agent.continueRun({
        workerId,
        issue: { identifier: issue.identifier, title: issue.title, description: issue.description },
        repository: `${repository.owner}/${repository.name}`,
        branch,
        workspacePath,
        definitionOfDone: ["Continue after the question answer."],
        securityRules: ["Use no credentials."],
      });
      worker = await ports.state.transition(workerId, "awaiting-review", { actor: "dogfood", reason: "question follow-up ready" });
      await ports.linear.setStatus(ticket.issueIdentifier, "In Review");
      calls.push(`${ticket.issueIdentifier}:question-continued`);
    }

    if (ticket.interaction === "review") {
      worker = await ports.state.transition(workerId, "running", { actor: "dogfood", reason: "review requested changes" });
      await ports.linear.setStatus(ticket.issueIdentifier, "In Progress");
      await ports.linear.addComment?.({ identifier: ticket.issueIdentifier, body: "Review requested changes; continuing the same worker." });
      await ports.agent.continueRun({
        workerId,
        issue: { identifier: issue.identifier, title: issue.title, description: issue.description },
        repository: `${repository.owner}/${repository.name}`,
        branch,
        workspacePath,
        definitionOfDone: ["Address review feedback on the existing branch."],
        securityRules: ["Use no credentials."],
      });
      worker = await ports.state.transition(workerId, "awaiting-review", { actor: "dogfood", reason: "review follow-up ready" });
      await ports.linear.setStatus(ticket.issueIdentifier, "In Review");
      calls.push(`${ticket.issueIdentifier}:review-continued`);
    }

    if (ticket.merge === true) {
      const pullRequestNumber = worker.pullRequestNumber;
      if (pullRequestNumber === undefined) throw new DogfoodScenarioError(`${workerId} has no pull request to merge`);
      await ports.pullRequest.merge({ repository, number: pullRequestNumber, workerId });
      await ports.linear.setStatus(ticket.issueIdentifier, "Done");
      calls.push(`${ticket.issueIdentifier}:merged`);
    }
  }

  const projections: DogfoodWorkerProjection[] = [];
  for (const ticket of tickets) {
    const workerId = workerIdFor(ticket.issueIdentifier);
    let worker = requireWorker(ports.state, workerId);
    const dockerWasActive = ports.docker.activeWorkerIds().includes(workerId);
    const tmuxWasActive = ports.tmux.activeWorkerIds().includes(workerId);
    const issue = requireIssue(ports.linear, ticket.issueIdentifier);
    const sourceBranch = worker.branch;
    const pullRequestNumber = worker.pullRequestNumber;
    if (pullRequestNumber === undefined || sourceBranch === undefined) {
      throw new DogfoodScenarioError(`${workerId} cannot be cleaned without provider projections`);
    }
    if (worker.state !== "awaiting-review") throw new DogfoodScenarioError(`${workerId} cannot be cleaned from ${worker.state}`);

    worker = await ports.state.transition(workerId, "stopped", { actor: "dogfood", reason: "scenario cleanup" });
    await ports.docker.cleanup(workerId, `container-${workerId}`);
    await ports.tmux.cleanup(workerId);
    await ports.pullRequest.cleanupBranch({ repository, sourceBranch, workerId });
    worker = await ports.state.transition(workerId, "destroyed", { actor: "dogfood", reason: "scenario cleanup complete" });
    const pullRequest = ports.pullRequest.snapshot().find((candidate) => candidate.number === pullRequestNumber);
    if (pullRequest === undefined) throw new DogfoodScenarioError(`${workerId} pull request projection disappeared`);
    const finalIssue = requireIssue(ports.linear, ticket.issueIdentifier);
    projections.push({
      issueIdentifier: ticket.issueIdentifier,
      workerId,
      interaction: ticket.interaction,
      finalState: worker.state,
      linearStatus: finalIssue.status.name as LinearIssueStatusName,
      pullRequestNumber,
      pullRequestState: pullRequest.state,
      dockerCleaned: dockerWasActive && !ports.docker.activeWorkerIds().includes(workerId),
      tmuxCleaned: tmuxWasActive && !ports.tmux.activeWorkerIds().includes(workerId),
    });
    calls.push(`${ticket.issueIdentifier}:cleaned`);
  }

  const agentRuns = ports.agent.runs();
  const workerIds = projections.map((projection) => projection.workerId);
  const uniqueWorkers = new Set(workerIds);
  const uniqueWorkspaces = new Set(ports.state.snapshot().map((worker) => worker.workspacePath).filter((path): path is string => path !== undefined));
  const uniqueBranches = new Set(ports.state.snapshot().map((worker) => worker.branch).filter((branch): branch is string => branch !== undefined));
  const isolation = uniqueWorkers.size === 3 && uniqueWorkspaces.size === 3 && uniqueBranches.size === 3 &&
    agentRuns.every((run) => run.workerId === workerIdFor(run.issueIdentifier));
  if (!isolation) throw new DogfoodScenarioError("worker isolation projection is inconsistent");

  const interactions = tickets.filter((ticket) => ticket.interaction !== "none");
  const sameWorker = interactions.every((ticket) => {
    const workerId = workerIdFor(ticket.issueIdentifier);
    return agentRuns.filter((run) => run.workerId === workerId).every((run) => run.issueIdentifier === ticket.issueIdentifier) &&
      agentRuns.filter((run) => run.workerId === workerId).some((run) => run.kind === "continue");
  });
  if (!sameWorker || ports.pullRequest.mergeCount() !== 1) throw new DogfoodScenarioError("continuations or explicit merge were not deterministic");

  const cleanup = projections.every((projection) => projection.finalState === "destroyed" && projection.dockerCleaned && projection.tmuxCleaned) &&
    ports.docker.activeWorkerIds().length === 0 && ports.tmux.activeWorkerIds().length === 0;
  if (!cleanup) throw new DogfoodScenarioError("resource cleanup projection is incomplete");

  const consistent = projections.every((projection) =>
    projection.linearStatus === (projection.pullRequestState === "merged" ? "Done" : "In Review"),
  );
  if (!consistent) throw new DogfoodScenarioError("Linear, GitHub, Docker, and state projections disagree");

  return {
    execution: {
      mode: "fake",
      liveProvidersSkipped: true,
      reason: "credential-free deterministic ports are injected; real Docker/provider execution requires an explicit host integration",
    },
    workers: projections,
    agentRuns,
    calls,
    assertions: {
      workerIsolation: true,
      sameWorkerQuestionAndReview: true,
      exactlyOneExplicitMerge: true,
      cleanup: true,
      consistentProjections: true,
    },
  };
}

/** Deterministic clock used by the fake ports; it never reads wall time. */
export class FakeDogfoodClock implements DogfoodClockPort {
  #tick = 0;
  public now(): string {
    const value = `2025-01-01T00:00:${String(this.#tick++).padStart(2, "0")}.000Z`;
    return value;
  }
}

export class FakeDogfoodLinear implements DogfoodLinearPort {
  readonly #issues = new Map<string, LinearIssue>();
  readonly statusCalls: Array<{ identifier: string; status: LinearIssueStatusName }> = [];
  readonly comments: Array<{ identifier: string; body: string }> = [];
  public constructor(tickets: readonly DogfoodTicket[] = defaultTickets) {
    for (const ticket of tickets) this.#issues.set(ticket.issueIdentifier, issueFor(ticket));
  }
  public snapshot(): readonly LinearIssue[] { return [...this.#issues.values()]; }
  public async getIssue(identifier: string): Promise<LinearIssue | null> { return this.#issues.get(identifier) ?? null; }
  public async setStatus(identifier: string, status: LinearIssueStatusName): Promise<LinearIssue> {
    const issue = this.#issues.get(identifier);
    if (issue === undefined) throw new DogfoodScenarioError(`unknown fake Linear issue ${identifier}`);
    const updated = { ...issue, status: { ...issue.status, name: status } };
    this.#issues.set(identifier, updated);
    this.statusCalls.push({ identifier, status });
    return updated;
  }
  public async addComment(input: { readonly identifier: string; readonly body: string }): Promise<void> {
    this.comments.push(input);
  }
}

export class FakeDogfoodState implements DogfoodStatePort {
  readonly #records = new Map<string, WorkerRecord>();
  readonly #clock: DogfoodClockPort;
  public constructor(clock: DogfoodClockPort = new FakeDogfoodClock()) { this.#clock = clock; }
  public snapshot(): readonly WorkerRecord[] { return [...this.#records.values()]; }
  public get(workerId: string): WorkerRecord | undefined { return this.#records.get(workerId); }
  public listByIssue(identifier: string): readonly WorkerRecord[] { return this.snapshot().filter((worker) => worker.issueIdentifier === identifier); }
  public create(input: WorkerInput): WorkerRecord {
    if (this.#records.has(input.workerId)) throw new DogfoodScenarioError(`duplicate fake SQLite worker ${input.workerId}`);
    const at = this.#clock.now();
    const record: WorkerRecord = { ...input, state: input.state ?? "queued", createdAt: at, updatedAt: at, lastTransitionAt: at };
    this.#records.set(record.workerId, record);
    return record;
  }
  public update(workerId: string, patch: Partial<Omit<WorkerRecord, "workerId" | "state" | "createdAt" | "updatedAt" | "lastTransitionAt">>): WorkerRecord {
    const current = requireWorker(this, workerId);
    const updated = { ...current, ...patch, updatedAt: this.#clock.now() };
    this.#records.set(workerId, updated);
    return updated;
  }
  public transition(workerId: string, state: WorkerState, options: { readonly expectedState?: WorkerState; readonly reason?: string } = {}): WorkerRecord {
    const current = requireWorker(this, workerId);
    if (options.expectedState !== undefined && current.state !== options.expectedState) throw new DogfoodScenarioError(`unexpected fake SQLite state for ${workerId}`);
    if (!canTransition(current.state, state)) throw new DogfoodScenarioError(`invalid fake SQLite transition ${current.state} -> ${state}`);
    const at = this.#clock.now();
    const updated = { ...current, state, reason: options.reason, updatedAt: at, lastTransitionAt: at };
    this.#records.set(workerId, updated);
    return updated;
  }
}

export class FakeDogfoodDocker implements DogfoodDockerPort {
  readonly #active = new Map<string, string>();
  readonly provisionCalls: string[] = [];
  readonly cleanupCalls: string[] = [];
  public async provision(request: { readonly workerId: string }): Promise<{ readonly containerId: string; readonly imageDigest: string }> {
    const containerId = `container-${request.workerId}`;
    this.#active.set(request.workerId, containerId);
    this.provisionCalls.push(request.workerId);
    return { containerId, imageDigest: `sha256:${request.workerId}` };
  }
  public async cleanup(workerId: string, containerId: string): Promise<void> {
    if (this.#active.get(workerId) !== containerId) throw new DogfoodScenarioError(`wrong container cleanup for ${workerId}`);
    this.#active.delete(workerId);
    this.cleanupCalls.push(workerId);
  }
  public activeWorkerIds(): readonly string[] { return [...this.#active.keys()]; }
}

export class FakeDogfoodWorkspace implements DogfoodWorkspacePort {
  public async provision(request: { readonly path: string; readonly repository: Repository; readonly issueIdentifier: string }): Promise<WorkspaceMetadata> {
    return { path: request.path, repository: request.repository, branch: `dogfood/${request.issueIdentifier.toLowerCase()}`, baseCommit: "base-dogfood" };
  }
}

export class FakeDogfoodTmux implements DogfoodTmuxPort {
  readonly #active = new Set<string>();
  readonly cleanupCalls: string[] = [];
  public async ensure(workerId: string): Promise<{ readonly sessionName: string }> {
    this.#active.add(workerId);
    return { sessionName: `session-${workerId}` };
  }
  public async cleanup(workerId: string): Promise<void> {
    this.#active.delete(workerId);
    this.cleanupCalls.push(workerId);
  }
  public activeWorkerIds(): readonly string[] { return [...this.#active]; }
}

export class FakeDogfoodAgent implements DogfoodAgentPort {
  readonly #runs: DogfoodAgentRunRecord[] = [];
  public runs(): readonly DogfoodAgentRunRecord[] { return [...this.#runs]; }
  public async start(request: WorkerAgentRequest): Promise<WorkerAgentRun> {
    const issueIdentifier = request.issue.identifier;
    this.#runs.push({ kind: "start", workerId: workerIdFor(issueIdentifier), issueIdentifier, workspacePath: request.workspacePath, branch: request.branch });
    const result: WorkerAgentResult = { workerId: workerIdFor(issueIdentifier), issueIdentifier, status: "completed", signals: [{ type: "heartbeat", at: 1 }] };
    return { workerId: result.workerId, issueIdentifier, prompt: `fake prompt for ${issueIdentifier}`, signals: result.signals, wait: async () => result, abort: async () => result };
  }
  public async continueRun(request: WorkerAgentRequest & { readonly workerId: string }): Promise<WorkerAgentResult> {
    if (request.workerId !== workerIdFor(request.issue.identifier)) throw new DogfoodScenarioError(`agent continued on the wrong worker for ${request.issue.identifier}`);
    this.#runs.push({ kind: "continue", workerId: request.workerId, issueIdentifier: request.issue.identifier, workspacePath: request.workspacePath, branch: request.branch });
    return { workerId: request.workerId, issueIdentifier: request.issue.identifier, status: "completed", signals: [{ type: "heartbeat", at: 2 }] };
  }
}

export class FakeDogfoodGitHub implements DogfoodPullRequestPort {
  readonly #pullRequests: PullRequest[] = [];
  readonly #cleanedBranches = new Set<string>();
  readonly createCalls: string[] = [];
  readonly mergeCalls: string[] = [];
  public async findOrCreate(input: { readonly repository: Repository; readonly sourceBranch: string; readonly targetBranch: string; readonly title: string; readonly body?: string }): Promise<PullRequest> {
    const existing = this.#pullRequests.find((candidate) => candidate.sourceBranch === input.sourceBranch && candidate.targetBranch === input.targetBranch);
    if (existing !== undefined) return existing;
    const pullRequest: PullRequest = { repository: input.repository, number: this.#pullRequests.length + 1, title: input.title, body: input.body, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, state: "open", reviewState: "pending" };
    this.#pullRequests.push(pullRequest);
    this.createCalls.push(input.sourceBranch);
    return pullRequest;
  }
  public async merge(input: { readonly repository: Repository; readonly number: number; readonly workerId: string }): Promise<PullRequest> {
    if (this.mergeCalls.length > 0) throw new DogfoodScenarioError("fake GitHub received more than one explicit merge");
    const pullRequest = this.#pullRequests.find((candidate) => candidate.number === input.number);
    if (pullRequest === undefined) throw new DogfoodScenarioError(`fake GitHub PR ${input.number} is missing`);
    Object.assign(pullRequest, { state: "merged" as const, reviewState: "approved" as const });
    this.mergeCalls.push(input.workerId);
    return pullRequest;
  }
  public async cleanupBranch(input: { readonly repository: Repository; readonly sourceBranch: string; readonly workerId: string }): Promise<void> {
    this.#cleanedBranches.add(input.sourceBranch);
  }
  public snapshot(): readonly PullRequest[] { return this.#pullRequests.map((pullRequest) => ({ ...pullRequest })); }
  public mergeCount(): number { return this.mergeCalls.length; }
}

export function createCredentialFreeDogfoodPorts(): DogfoodPorts {
  const clock = new FakeDogfoodClock();
  return {
    clock,
    linear: new FakeDogfoodLinear(),
    state: new FakeDogfoodState(clock),
    docker: new FakeDogfoodDocker(),
    workspace: new FakeDogfoodWorkspace(),
    tmux: new FakeDogfoodTmux(),
    agent: new FakeDogfoodAgent(),
    pullRequest: new FakeDogfoodGitHub(),
  };
}

export function runCredentialFreeDogfoodScenario(options: DogfoodScenarioOptions = {}): Promise<DogfoodScenarioReport> {
  const ports = createCredentialFreeDogfoodPorts();
  return runDogfoodScenario(ports, options);
}
