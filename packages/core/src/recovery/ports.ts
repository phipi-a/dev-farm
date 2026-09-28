import type { DockerContainerInspection, DockerClientPort } from "../docker/docker";
import type { CreatePullRequestInput, GitHubTransport } from "../github/transports";
import type { PullRequest, PullRequestRef } from "../github/models";
import type { LinearIssue, LinearIssueStatusName, LinearIssueUpdateInput } from "../linear/types";
import type { LinearTransport } from "../linear/transport";
import type { WorkerRecord } from "../state/models";
import type { WorkerHeartbeat } from "./models";

/** Runtime health and heartbeat probe. Implementations must not return secrets. */
export interface WorkerHealthPort {
  heartbeat(worker: WorkerRecord): Promise<WorkerHeartbeat>;
}

/** Explicit heartbeat spelling for hosts that keep health and heartbeat seams separate. */
export type WorkerHeartbeatPort = WorkerHealthPort;

/** Idempotent runtime resume operation. A resume must use the worker identity as its lock key. */
export interface WorkerResumePort {
  resume(worker: WorkerRecord): Promise<{ readonly workerId: string; readonly processId?: number; readonly containerId?: string }>;
}

export interface DockerRecoveryPort extends WorkerHealthPort, WorkerResumePort {}

/** GitHub operations needed to discover an existing PR before creating one. */
export interface GitHubReconciliationPort {
  findPullRequest(ref: PullRequestRef): Promise<PullRequest | undefined>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  getPullRequest?(repository: PullRequest["repository"], number: number): Promise<PullRequest | undefined>;
}

/** Linear operations needed to reconcile issue state without embedding API credentials. */
export interface LinearReconciliationPort {
  getIssue(identifier: string): Promise<LinearIssue | null>;
  updateIssue(input: LinearIssueUpdateInput): Promise<LinearIssue>;
}

export interface RecoveryPorts {
  readonly health: WorkerHealthPort;
  readonly resume?: WorkerResumePort;
  readonly github?: GitHubReconciliationPort;
  readonly linear?: LinearReconciliationPort;
}

/** Injectable provider boundary used by the SQLite recovery coordinator. */
export type ReconciliationPort = RecoveryPorts;

/** Adapter around the existing Docker port; labels are the only persisted identity. */
export class DockerHealthPort implements DockerRecoveryPort {
  readonly #client: DockerClientPort;
  readonly #labelKey: string;

  public constructor(client: DockerClientPort, options: { readonly labelNamespace?: string } = {}) {
    if (client === null || typeof client !== "object") throw new TypeError("a Docker client is required");
    this.#client = client;
    this.#labelKey = `${options.labelNamespace ?? "dev-farm"}/worker-id`;
  }

  public async heartbeat(worker: WorkerRecord): Promise<WorkerHeartbeat> {
    const containers = await this.#client.listContainers({ labels: { [this.#labelKey]: worker.workerId }, all: true });
    const observedAt = new Date();
    if (containers.length === 0) return { workerId: worker.workerId, status: "missing", observedAt, reason: "worker container is missing" };
    if (containers.length > 1) return { workerId: worker.workerId, status: "unknown", observedAt, reason: "multiple worker containers found" };
    const container = containers[0];
    return {
      workerId: worker.workerId,
      status: container.state.running ? "healthy" : "exited",
      observedAt,
      containerId: container.id,
      reason: container.state.running ? undefined : `container exited${container.state.exitCode === undefined ? "" : ` (${container.state.exitCode})`}`,
    };
  }

  public async resume(worker: WorkerRecord): Promise<{ readonly workerId: string; readonly containerId?: string }> {
    const containers = await this.#client.listContainers({ labels: { [this.#labelKey]: worker.workerId }, all: true });
    if (containers.length === 0) throw new Error(`worker container missing: ${worker.workerId}`);
    if (containers.length > 1) throw new Error(`multiple worker containers found: ${worker.workerId}`);
    const container: DockerContainerInspection = containers[0];
    if (!container.state.running) await this.#client.startContainer(container.id);
    return { workerId: worker.workerId, containerId: container.id };
  }
}

/** Minimal convenience adapters preserve the injected transport seams and do not store credentials. */
export function githubReconciliationPort(transport: GitHubTransport): GitHubReconciliationPort {
  return {
    findPullRequest: (ref) => transport.findPullRequest(ref),
    createPullRequest: (input) => transport.createPullRequest(input),
  };
}

export function linearReconciliationPort(transport: LinearTransport): LinearReconciliationPort {
  return {
    getIssue: (identifier) => transport.getIssue(identifier),
    updateIssue: (input) => transport.updateIssue(input),
  };
}

export type LinearTargetStatus = Extract<LinearIssueStatusName, "In Progress" | "In Review" | "Done" | "Todo">;
