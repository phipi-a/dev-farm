import assert from "node:assert/strict";
import test from "node:test";
import type { CiStatus, Repository } from "../github/models";
import {
  createMergeWorkflow,
  MergeGateError,
  MergeProviderError,
  type MergeAuditRecord,
  type MergeInspection,
  type MergeProviderPort,
  type MergeRequest,
} from "./index";

const repository: Repository = { owner: "acme", name: "widget", defaultBranch: "main" };

function inspection(overrides: Partial<MergeInspection> = {}): MergeInspection {
  const ci: CiStatus = { state: "success", checks: [], ...overrides.ci };
  return {
    state: "open",
    ci,
    reviewState: "approved",
    mergeable: true,
    ...overrides,
  };
}

class FakeProvider implements MergeProviderPort {
  readonly calls: string[] = [];
  current: MergeInspection = inspection();
  result: "merged" | "already-merged" = "merged";
  failure: Error | undefined;

  inspect(): MergeInspection {
    this.calls.push("inspect");
    if (this.failure !== undefined) throw this.failure;
    return this.current;
  }

  merge(): { state: "merged" | "already-merged" } {
    this.calls.push("merge");
    return { state: this.result };
  }
}

function request(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    workerId: "worker-1",
    repository,
    pullRequestNumber: 7,
    caller: "operator",
    confirmation: true,
    issueIdentifier: "DEV-19",
    ...overrides,
  };
}

async function rejectsGate(action: () => Promise<unknown>, gate: MergeGateError["gate"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof MergeGateError && error.gate === gate);
}

test("does not inspect or merge without explicit confirmation", async () => {
  const provider = new FakeProvider();
  const workflow = createMergeWorkflow({ provider });

  await rejectsGate(() => workflow.merge(request({ confirmation: false, confirmed: false })), "confirmation");
  assert.deepEqual(provider.calls, []);

  await rejectsGate(() => workflow.merge(request({ caller: "worker", confirmation: true })), "caller");
  assert.deepEqual(provider.calls, []);
});

test("requires successful CI, approved review, and confirmed conflict-free status", async () => {
  for (const [gate, current] of [
    ["ci", inspection({ ci: { state: "failure", checks: [] } })],
    ["review", inspection({ reviewState: "changes_requested" })],
    ["conflict", inspection({ mergeable: false })],
    ["conflict", inspection({ mergeable: undefined })],
  ] as const) {
    const provider = new FakeProvider();
    provider.current = current;
    await rejectsGate(() => createMergeWorkflow({ provider }).merge(request()), gate);
    assert.deepEqual(provider.calls, ["inspect"]);
  }
});

test("already-merged PRs are idempotent and still converge projections", async () => {
  const provider = new FakeProvider();
  provider.current = inspection({ state: "merged" });
  const calls: string[] = [];
  const result = await createMergeWorkflow({
    provider,
    linear: { setDone: () => { calls.push("linear"); } },
    baseline: { refresh: () => { calls.push("baseline"); } },
    cleanup: { cleanup: () => { calls.push("cleanup"); } },
  }).merge(request());

  assert.equal(result.outcome, "already-merged");
  assert.deepEqual(provider.calls, ["inspect"]);
  assert.deepEqual(calls, ["linear", "baseline", "cleanup"]);
  assert.equal(result.linear.state, "done");
});

test("sets Linear Done only after provider success, then invokes callbacks", async () => {
  const provider = new FakeProvider();
  const calls: string[] = [];
  const result = await createMergeWorkflow({
    provider,
    linear: { setDone: () => { calls.push("linear"); } },
    baseline: { refresh: () => { calls.push("baseline"); } },
    cleanup: { cleanup: () => { calls.push("cleanup"); } },
  }).merge(request());

  assert.deepEqual(provider.calls, ["inspect", "merge"]);
  assert.deepEqual(calls, ["linear", "baseline", "cleanup"]);
  assert.equal(result.outcome, "merged");
  assert.equal(result.linear.state, "done");
  assert.equal(result.baselineRefresh.state, "done");
  assert.equal(result.workerCleanup.state, "done");
});

test("reports callback failures but still attempts both callbacks without deleting provider resources", async () => {
  const provider = new FakeProvider();
  const calls: string[] = [];
  const result = await createMergeWorkflow({
    provider,
    baseline: { refresh: () => { calls.push("baseline"); throw new Error("refresh unavailable"); } },
    cleanup: { cleanup: () => { calls.push("cleanup"); throw new Error("cleanup unavailable"); } },
  }).merge(request());

  assert.deepEqual(calls, ["baseline", "cleanup"]);
  assert.equal(result.baselineRefresh.state, "failed");
  assert.equal(result.workerCleanup.state, "failed");
  assert.equal(result.warnings.length, 2);
  assert.equal(provider.calls.filter((call) => call === "merge").length, 1);
});

test("audits safe results and redacts provider secrets", async () => {
  const provider = new FakeProvider();
  provider.failure = new Error("Bearer ghp_super-secret-token");
  const audit: MergeAuditRecord[] = [];
  const workflow = createMergeWorkflow({ provider, audit: { record: (record) => { audit.push(record); } } });

  await assert.rejects(
    workflow.merge(request({ sensitiveValues: ["super-secret-token"] })),
    (error: unknown) => error instanceof MergeProviderError && !error.message.includes("ghp_super-secret-token"),
  );
  assert.equal(audit.length, 1);
  assert.ok(JSON.stringify(audit).includes("[REDACTED]"));
  assert.ok(!JSON.stringify(audit).includes("super-secret-token"));
});
