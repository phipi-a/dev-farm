import assert from "node:assert/strict";
import test from "node:test";
import type { LinearIssue, LinearIssueStatusName } from "../linear/types.ts";
import {
  ParallelCoordinator,
  type ParallelCoordinatorEvent,
  type ParallelWorkerStartRequest,
} from "./parallel.ts";

function issue(
  identifier: string,
  status: LinearIssueStatusName = "Todo",
  teamId = "team-dev",
): LinearIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Issue ${identifier}`,
    teamId,
    status: { id: status.toLowerCase(), name: status },
  };
}

class FakeWorkers {
  readonly starts: ParallelWorkerStartRequest[] = [];
  active = 0;
  peak = 0;
  readonly failures = new Set<string>();
  readonly #delayMs: number;

  constructor(delayMs = 1) {
    this.#delayMs = delayMs;
  }

  async start(request: ParallelWorkerStartRequest): Promise<string> {
    this.starts.push(request);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    this.active -= 1;
    if (this.failures.has(request.issue.identifier))
      throw new Error(`failed ${request.issue.identifier}`);
    return `completed:${request.issue.identifier}`;
  }
}

test("starts three eligible issues in parallel and emits a summary", async () => {
  const workers = new FakeWorkers(5);
  const events: ParallelCoordinatorEvent<string>[] = [];
  const coordinator = new ParallelCoordinator<string>(
    {
      issues: { listIssues: async () => [issue("DEV-1"), issue("DEV-2"), issue("DEV-3")] },
      worker: workers,
      onEvent: (event) => {
        events.push(event);
      },
    },
    { maxConcurrency: 3, resourceLimits: { memoryBytes: 100, cpuCount: 2, pidsLimit: 50 } },
  );

  const result = await coordinator.run({ teamId: "team-dev" });
  assert.equal(workers.peak, 3);
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.deepEqual(result.summary, {
    discovered: 3,
    selected: 3,
    skipped: 0,
    started: 3,
    succeeded: 3,
    failed: 0,
  });
  assert.equal(events.at(-1)?.type, "summary");
  assert.deepEqual(
    workers.starts.map((start) => start.resourceLimits),
    [
      { memoryBytes: 100, cpuCount: 2, pidsLimit: 50 },
      { memoryBytes: 100, cpuCount: 2, pidsLimit: 50 },
      { memoryBytes: 100, cpuCount: 2, pidsLimit: 50 },
    ],
  );
  assert.equal(new Set(workers.starts.map((start) => start.operationId)).size, 3);
});

test("selects by team and skips non-Todo issues", async () => {
  const workers = new FakeWorkers();
  const coordinator = new ParallelCoordinator(
    {
      issues: {
        listIssues: async () => [
          issue("DEV-1"),
          issue("DEV-2", "In Progress"),
          issue("DEV-3", "In Review"),
          issue("DEV-4", "Done"),
          issue("DEV-5", "Todo", "other-team"),
        ],
      },
      worker: workers,
    },
    { maxConcurrency: 2 },
  );

  const result = await coordinator.run({ teamId: "team-dev" });
  assert.deepEqual(
    workers.starts.map((start) => start.issue.identifier),
    ["DEV-1"],
  );
  assert.deepEqual(
    result.skipped.map((entry) => [entry.issue.identifier, entry.reason]),
    [
      ["DEV-2", "not-todo"],
      ["DEV-3", "not-todo"],
      ["DEV-4", "not-todo"],
      ["DEV-5", "not-in-team"],
    ],
  );
});

test("passes optional issue IDs to discovery and excludes unrequested tickets", async () => {
  const workers = new FakeWorkers();
  let requested: readonly string[] | undefined;
  const coordinator = new ParallelCoordinator(
    {
      issues: {
        listIssues: async (input) => {
          requested = input.issueIdentifiers;
          return [issue("DEV-1"), issue("DEV-2")];
        },
      },
      worker: workers,
    },
    { maxConcurrency: 2 },
  );

  const result = await coordinator.run({ teamId: "team-dev", issueIdentifiers: ["DEV-1"] });
  assert.deepEqual(requested, ["DEV-1"]);
  assert.deepEqual(
    result.selected.map((entry) => entry.identifier),
    ["DEV-1"],
  );
  assert.deepEqual(
    result.skipped.map((entry) => [entry.issue.identifier, entry.reason]),
    [["DEV-2", "not-requested"]],
  );
});

test("isolates failures and continues scheduling other issues", async () => {
  const workers = new FakeWorkers();
  workers.failures.add("DEV-2");
  const coordinator = new ParallelCoordinator<string>(
    {
      issues: { listIssues: async () => [issue("DEV-1"), issue("DEV-2"), issue("DEV-3")] },
      worker: workers,
    },
    { maxConcurrency: 2 },
  );

  const result = await coordinator.run({ teamId: "team-dev" });
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["succeeded", "failed", "succeeded"],
  );
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.succeeded, 2);
});

test("never exceeds the configured concurrency and is repeatable", async () => {
  const workers = new FakeWorkers(3);
  const coordinator = new ParallelCoordinator(
    {
      issues: { listIssues: async () => [issue("DEV-1"), issue("DEV-2"), issue("DEV-3")] },
      worker: workers,
    },
    { maxConcurrency: 1 },
  );

  const first = await coordinator.run({ teamId: "team-dev" });
  const second = await coordinator.run({ teamId: "team-dev" });
  assert.equal(workers.peak, 1);
  assert.equal(workers.starts.length, 6);
  assert.deepEqual(
    first.results.map((entry) => entry.operationId),
    second.results.map((entry) => entry.operationId),
  );
});
