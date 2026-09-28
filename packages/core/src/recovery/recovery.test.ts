import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequest, PullRequestRef } from "../github/models";
import type { CreatePullRequestInput } from "../github/transports";
import { WorkerStateStore } from "../state";
import {
  RecoveryCoordinator,
  RecoveryError,
  type GitHubReconciliationPort,
  type LinearReconciliationPort,
  type RecoveryClock,
  type WorkerHealthPort,
  type WorkerResumePort,
} from "./index";

class FakeClock implements RecoveryClock {
  readonly sleeps: number[] = [];
  current = new Date("2025-01-01T00:10:00.000Z");
  now(): Date { return new Date(this.current); }
  async sleep(milliseconds: number): Promise<void> { this.sleeps.push(milliseconds); }
}

function worker(store: WorkerStateStore, overrides: Record<string, unknown> = {}): void {
  store.create({
    workerId: "worker-a",
    issueIdentifier: "DEV-16",
    repository: "acme/dev-farm",
    branch: "agent/dev-16",
    commitSha: "commit-1",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastTransitionAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  });
  store.transition("worker-a", "provisioning", { at: "2025-01-01T00:00:00.000Z" });
  store.transition("worker-a", "running", { at: "2025-01-01T00:00:00.000Z" });
}

test("detects a missing worker and resumes it exactly once", async () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  const clock = new FakeClock();
  worker(store);
  let resumes = 0;
  const health: WorkerHealthPort = {
    async heartbeat(record) { return { workerId: record.workerId, status: "missing", observedAt: clock.now() }; },
  };
  const resume: WorkerResumePort = {
    async resume(record) { resumes += 1; return { workerId: record.workerId, processId: 9 }; },
  };
  const result = await new RecoveryCoordinator(store, { health, resume }, { clock, policy: { staleAfterMs: 1 } }).reconcile("worker-a");
  assert.equal(result.status, "resumed");
  assert.equal(resumes, 1);
  assert.equal(store.get("worker-a")?.state, "running");
  assert.equal(store.get("worker-a")?.lastError, undefined);
  store.close();
});

test("detects a stale heartbeat and does not persist provider error details", async () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  const clock = new FakeClock();
  worker(store);
  const health: WorkerHealthPort = {
    async heartbeat(record) {
      return { workerId: record.workerId, status: "healthy", observedAt: clock.now(), heartbeatAt: "2025-01-01T00:00:00.000Z" };
    },
  };
  const resume: WorkerResumePort = {
    async resume() { throw new Error("provider credential=do-not-store"); },
  };
  const result = await new RecoveryCoordinator(store, { health, resume }, { clock, policy: { staleAfterMs: 1, maxAttempts: 1 } }).reconcile("worker-a");
  assert.equal(result.status, "failed");
  assert.equal(store.get("worker-a")?.lastError, "recovery unknown");
  assert.equal(store.get("worker-a")?.lastError?.includes("do-not-store"), false);
  store.close();
});

test("classifies transient failures and uses bounded deterministic backoff", async () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  const clock = new FakeClock();
  worker(store);
  let probes = 0;
  const health: WorkerHealthPort = {
    async heartbeat(record) {
      probes += 1;
      if (probes < 3) throw new RecoveryError("temporary runtime unavailable", { kind: "transient" });
      return { workerId: record.workerId, status: "healthy", observedAt: clock.now(), heartbeatAt: clock.now() };
    },
  };
  const result = await new RecoveryCoordinator(store, { health }, {
    clock,
    policy: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 15, multiplier: 2 },
  }).reconcile("worker-a");
  assert.equal(result.status, "healthy");
  assert.deepEqual(clock.sleeps, [10, 15]);
  assert.equal(probes, 3);
  store.close();
});

test("discovers an accepted PR after timeout instead of creating a duplicate", async () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  const clock = new FakeClock();
  worker(store);
  const pullRequests: PullRequest[] = [];
  let creates = 0;
  const github: GitHubReconciliationPort = {
    async findPullRequest(ref: PullRequestRef) {
      return pullRequests.find((pr) => pr.sourceBranch === ref.sourceBranch);
    },
    async createPullRequest(input: CreatePullRequestInput) {
      creates += 1;
      const pullRequest: PullRequest = {
        repository: input.repository,
        number: 42,
        title: input.title,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: "open",
      };
      pullRequests.push(pullRequest);
      throw new Error("request timeout after acceptance");
    },
  };
  const health: WorkerHealthPort = {
    async heartbeat(record) { return { workerId: record.workerId, status: "healthy", observedAt: clock.now(), heartbeatAt: clock.now() }; },
  };
  const coordinator = new RecoveryCoordinator(store, { health, github }, { clock });
  assert.equal((await coordinator.reconcile("worker-a")).pullRequestNumber, 42);
  assert.equal((await coordinator.reconcile("worker-a")).pullRequestNumber, 42);
  assert.equal(creates, 1);
  assert.equal(store.get("worker-a")?.pullRequestNumber, 42);
  store.close();
});

test("reconciles Linear only when the target status differs", async () => {
  const store = new WorkerStateStore({ path: ":memory:" });
  const clock = new FakeClock();
  worker(store, { commitSha: undefined });
  let updates = 0;
  const linear: LinearReconciliationPort = {
    async getIssue(identifier) { return { id: "issue-1", identifier, title: "Recovery", status: { id: "todo", name: "Todo" } }; },
    async updateIssue(input) { updates += 1; return { id: "issue-1", identifier: input.identifier, title: "Recovery", status: { id: "progress", name: input.status } }; },
  };
  const health: WorkerHealthPort = {
    async heartbeat(record) { return { workerId: record.workerId, status: "healthy", observedAt: clock.now(), heartbeatAt: clock.now() }; },
  };
  await new RecoveryCoordinator(store, { health, linear }, { clock }).reconcile("worker-a");
  assert.equal(updates, 1);
  store.close();
});
