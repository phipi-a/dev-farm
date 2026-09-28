import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerAgentRequest, WorkerAgentResult, WorkerAgentRun } from "../agent/worker-agent";
import type { PullRequest, Repository } from "../github/models";
import type { LinearIssue, LinearIssueStatusName } from "../linear/types";
import { canTransition, type WorkerInput, type WorkerRecord, type WorkerState } from "../state/models";
import type {
  DockerProvisionRequest,
  DockerProvisionResult,
  OrchestratorAgentPort,
  OrchestratorDockerPort,
  OrchestratorLinearPort,
  OrchestratorPullRequestPort,
  OrchestratorStatePort,
  OrchestratorTmuxPort,
  OrchestratorWorkspacePort,
  WorkerOrchestrationRequest,
} from "./orchestrator";
import { WorkerOrchestrator } from "./orchestrator";

const repository: Repository = { owner: "acme", name: "app", defaultBranch: "main", cloneUrl: "https://example.test/acme/app.git" };
const issue: LinearIssue = { id: "issue-id", identifier: "DEV-11", title: "Build orchestrator", status: { id: "todo", name: "Todo" } };
const pullRequest: PullRequest = { repository, number: 42, title: "DEV-11: Build orchestrator", sourceBranch: "dev-11-build-orchestrator", targetBranch: "main", state: "open" };

class FakeState implements OrchestratorStatePort {
  readonly records: WorkerRecord[] = [];
  #sequence = 0;
  listByIssue(identifier: string): readonly WorkerRecord[] { return this.records.filter((record) => record.issueIdentifier === identifier); }
  get(workerId: string): WorkerRecord | undefined { return this.records.find((record) => record.workerId === workerId); }
  create(input: WorkerInput): WorkerRecord {
    const at = `2025-01-01T00:00:0${this.#sequence++}.000Z`;
    const record: WorkerRecord = { workerId: input.workerId, issueIdentifier: input.issueIdentifier, project: input.project, repository: input.repository, state: input.state ?? "queued", createdAt: at, updatedAt: at, lastTransitionAt: at };
    this.records.push(record);
    return record;
  }
  update(workerId: string, patch: Partial<Omit<WorkerRecord, "workerId" | "state" | "createdAt" | "updatedAt" | "lastTransitionAt">>): WorkerRecord {
    const current = this.get(workerId);
    assert.ok(current);
    Object.assign(current, patch, { updatedAt: `2025-01-01T00:00:0${this.#sequence++}.000Z` });
    return current;
  }
  transition(workerId: string, state: WorkerState, options: { readonly reason?: string; readonly providerEvidence?: string } = {}): WorkerRecord {
    const current = this.get(workerId);
    assert.ok(current);
    assert.ok(canTransition(current.state, state), `${current.state} -> ${state}`);
    Object.assign(current, { state, reason: options.reason, updatedAt: `2025-01-01T00:00:0${this.#sequence++}.000Z`, lastTransitionAt: `2025-01-01T00:00:0${this.#sequence++}.000Z` });
    return current;
  }
}

class Fakes {
  readonly state = new FakeState();
  readonly calls: string[] = [];
  readonly linear: OrchestratorLinearPort = {
    getIssue: async () => issue,
    setStatus: async (_identifier: string, status: LinearIssueStatusName) => {
      this.calls.push(`linear:${status}`);
      return { ...issue, status: { ...issue.status, name: status } };
    },
    addComment: async () => { this.calls.push("linear:comment"); },
  };
  readonly docker: OrchestratorDockerPort = {
    provision: async (_request: DockerProvisionRequest): Promise<DockerProvisionResult> => { this.calls.push("docker"); return { containerId: "container" }; },
  };
  readonly workspace: OrchestratorWorkspacePort = {
    provision: async () => { this.calls.push("workspace"); return { path: "/tmp/dev-11", repository, branch: "dev-11-build-orchestrator", baseCommit: "abc123" }; },
  };
  readonly tmux: OrchestratorTmuxPort = { ensure: async () => { this.calls.push("tmux"); return { sessionName: "worker" }; } };
  readonly pullRequest: OrchestratorPullRequestPort = { findOrCreate: async () => { this.calls.push("pr"); return pullRequest; } };
  readonly agent: OrchestratorAgentPort = {
    start: async (_request: WorkerAgentRequest): Promise<WorkerAgentRun> => {
      this.calls.push("agent:start");
      const result: WorkerAgentResult = { workerId: "worker-dev-11", issueIdentifier: "DEV-11", status: "completed", signals: [{ type: "heartbeat", at: 1 }] };
      return { workerId: result.workerId, issueIdentifier: result.issueIdentifier, prompt: "prompt", signals: result.signals, wait: async () => result, abort: async () => result };
    },
  };
  orchestrator(): WorkerOrchestrator { return new WorkerOrchestrator({ linear: this.linear, state: this.state, docker: this.docker, workspace: this.workspace, tmux: this.tmux, agent: this.agent, pullRequest: this.pullRequest }); }
  request(): WorkerOrchestrationRequest { return { issueIdentifier: "DEV-11", repository, workspacePath: "/tmp/dev-11" }; }
}

test("runs the happy path and returns worker details with collected agent signals", async () => {
  const fakes = new Fakes();
  const result = await fakes.orchestrator().run(fakes.request());
  assert.equal(result.worker.state, "awaiting-review");
  assert.equal(result.worker.pullRequestNumber, 42);
  assert.equal(result.agent?.signals[0]?.type, "heartbeat");
  assert.deepEqual(fakes.calls, ["linear:In Progress", "docker", "workspace", "tmux", "agent:start", "pr", "linear:In Review"]);
});

test("a completed worker can be repeated without provisioning or mutating Linear", async () => {
  const fakes = new Fakes();
  const orchestrator = fakes.orchestrator();
  await orchestrator.run(fakes.request());
  fakes.calls.length = 0;
  const repeated = await orchestrator.run(fakes.request());
  assert.equal(repeated.resumed, true);
  assert.deepEqual(fakes.calls, []);
});

test("attributes provider failures to failed state and emits a safe diagnostic", async () => {
  const fakes = new Fakes();
  fakes.workspace.provision = async () => { throw new Error("token=secret-value workspace unavailable"); };
  await assert.rejects(fakes.orchestrator().run(fakes.request()), /workspace unavailable/);
  const worker = fakes.state.records[0];
  assert.equal(worker?.state, "failed");
  assert.equal(worker?.lastError, "token=[REDACTED] workspace unavailable");
  assert.equal(fakes.calls.at(-1), "linear:comment");
});

test("rejects duplicate workers for one issue", async () => {
  const fakes = new Fakes();
  fakes.state.create({ workerId: "first", issueIdentifier: "DEV-11", state: "queued" });
  fakes.state.create({ workerId: "second", issueIdentifier: "DEV-11", state: "queued" });
  await assert.rejects(fakes.orchestrator().run(fakes.request()), /multiple workers/);
  assert.deepEqual(fakes.calls, []);
});
