import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerState } from "../state/models";
import {
  ContinueDuplicateError,
  ContinueInvalidStateError,
  ContinueProviderError,
  ContinueWorkflow,
  type ContinueAuditRecord,
  type ContinueInjectionInput,
  type ContinuePullRequestIdentity,
  type ContinueStatusRecord,
  type ContinueWorkerRecord,
} from "./index";

const identity: ContinuePullRequestIdentity = {
  repository: { owner: "acme", name: "farm", defaultBranch: "main" },
  number: 12,
  sourceBranch: "agent/dev-12",
  targetBranch: "main",
  headSha: "head-1",
};

class FakeState {
  readonly worker: ContinueWorkerRecord = {
    workerId: "worker-12",
    issueIdentifier: "DEV-12",
    state: "awaiting-review",
    workspacePath: "/workspaces/worker-12",
    branch: "agent/dev-12",
    containerId: "container-12",
    pullRequest: identity,
    pullRequestNumber: 12,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastTransitionAt: "2025-01-01T00:00:00.000Z",
  };
  readonly transitions: WorkerState[] = [];

  get(): ContinueWorkerRecord { return { ...this.worker }; }
  update(_workerId: string, patch: { readonly commitSha?: string }): ContinueWorkerRecord {
    Object.assign(this.worker, patch);
    return { ...this.worker };
  }
  transition(_workerId: string, state: WorkerState, options?: { readonly expectedState?: WorkerState }): ContinueWorkerRecord {
    if (options?.expectedState !== undefined && this.worker.state !== options.expectedState) throw new Error("state race");
    this.worker.state = state;
    this.transitions.push(state);
    return { ...this.worker };
  }
}

function setup(state: FakeState, calls: { inputs: ContinueInjectionInput[]; status: ContinueStatusRecord[]; audit: ContinueAuditRecord[] }) {
  return new ContinueWorkflow({
    state,
    now: () => "2025-01-02T00:00:00.000Z",
    createContinuationId: ({ reason }) => `continuation-${reason}`,
    injection: {
      inject: (input) => {
        calls.inputs.push(input);
        return { status: "completed", readyForReview: true, commitSha: "head-2" };
      },
    },
    pullRequest: {
      reconcile: ({ pullRequest }) => ({
        state: "open",
        headSha: pullRequest.headSha,
        ci: { state: "success", checks: [] },
      }),
    },
    status: { write: (record) => { calls.status.push(record); } },
    audit: { record: (record) => { calls.audit.push(record); } },
  });
}

test("continues answer, changes_requested, and retry using the exact persisted identity", async () => {
  for (const reason of ["answer", "changes_requested", "retry"] as const) {
    const state = new FakeState();
    if (reason === "retry") state.worker.state = "failed";
    const calls = { inputs: [], status: [], audit: [] } as {
      inputs: ContinueInjectionInput[];
      status: ContinueStatusRecord[];
      audit: ContinueAuditRecord[];
    };
    const result = await setup(state, calls).continue({ workerId: "worker-12", reason, instruction: `do ${reason}` });
    assert.equal(result.worker.state, "awaiting-review");
    assert.equal(calls.inputs.length, 1);
    assert.equal(calls.inputs[0]?.containerId, "container-12");
    assert.equal(calls.inputs[0]?.workspacePath, "/workspaces/worker-12");
    assert.equal(calls.inputs[0]?.branch, "agent/dev-12");
    assert.deepEqual(calls.inputs[0]?.pullRequest, identity);
    assert.equal(calls.inputs[0]?.preserveUncommittedWork, true);
    assert.deepEqual(state.transitions, reason === "retry" ? ["recovering", "running", "awaiting-review"] : ["running", "awaiting-review"]);
  }
});

test("redacts secrets and preserves uncommitted work in the Pi instruction boundary", async () => {
  const state = new FakeState();
  const calls = { inputs: [], status: [], audit: [] } as { inputs: ContinueInjectionInput[]; status: ContinueStatusRecord[]; audit: ContinueAuditRecord[] };
  await setup(state, calls).continue({
    workerId: "worker-12",
    reason: "changes_requested",
    instruction: "Fix token=super-secret and Bearer abc123; leave my uncommitted edits intact",
    sensitiveValues: ["super-secret"],
  });
  assert.equal(calls.inputs[0]?.instruction, "Fix token: [REDACTED] and Bearer [REDACTED]; leave my uncommitted edits intact");
  assert.equal(calls.inputs[0]?.preserveUncommittedWork, true);
  assert.equal(JSON.stringify(calls.audit).includes("super-secret"), false);
});

test("rejects invalid, completed, and duplicate continuations", async () => {
  const state = new FakeState();
  const calls = { inputs: [], status: [], audit: [] } as { inputs: ContinueInjectionInput[]; status: ContinueStatusRecord[]; audit: ContinueAuditRecord[] };
  const workflow = setup(state, calls);
  state.worker.state = "running";
  await assert.rejects(workflow.continue({ workerId: "worker-12", reason: "answer", instruction: "answer" }), ContinueInvalidStateError);
  state.worker.state = "destroyed";
  await assert.rejects(workflow.continue({ workerId: "worker-12", reason: "retry", instruction: "retry" }), ContinueInvalidStateError);
  state.worker.state = "awaiting-review";
  await workflow.continue({ workerId: "worker-12", reason: "answer", instruction: "same" });
  await assert.rejects(workflow.continue({ workerId: "worker-12", reason: "answer", instruction: "same" }), ContinueDuplicateError);
});

test("records provider failures and never loses the worker failure state", async () => {
  const state = new FakeState();
  const calls = { status: [] as ContinueStatusRecord[], audit: [] as ContinueAuditRecord[] };
  const workflow = new ContinueWorkflow({
    state,
    injection: { inject: async () => { throw new Error("provider token=do-not-store"); } },
    pullRequest: { reconcile: async () => undefined },
    status: { write: (record) => { calls.status.push(record); } },
    audit: { record: (record) => { calls.audit.push(record); } },
  });
  await assert.rejects(workflow.continue({ workerId: "worker-12", reason: "answer", instruction: "run", sensitiveValues: ["do-not-store"] }), ContinueProviderError);
  assert.equal(state.worker.state, "failed");
  assert.equal(calls.status.at(-1)?.outcome, "failed");
  assert.equal(JSON.stringify(calls.audit).includes("do-not-store"), false);
});
