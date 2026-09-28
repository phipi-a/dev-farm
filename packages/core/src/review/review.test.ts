import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequest } from "../github/models";
import type { WorkerRecord, WorkerState } from "../state/models";
import {
  AutomaticMergeRejectedError,
  ReviewInvalidStateError,
  ReviewWorkflow,
  redactReviewText,
  type ReviewDecision,
  type ReviewSnapshot,
} from "./index";

class FakeState {
  readonly worker: WorkerRecord;
  readonly transitions: WorkerState[] = [];

  public constructor() {
    this.worker = {
      workerId: "worker-a",
      issueIdentifier: "DEV-18",
      state: "running",
      workspacePath: "/workspaces/worker-a",
      branch: "agent/dev-18",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastTransitionAt: "2025-01-01T00:00:00.000Z",
    };
  }

  get(): WorkerRecord { return this.worker; }
  update(_workerId: string, patch: Partial<WorkerRecord>): WorkerRecord {
    Object.assign(this.worker, patch);
    return this.worker;
  }
  transition(_workerId: string, state: WorkerState, options?: { readonly expectedState?: WorkerState }): WorkerRecord {
    if (options?.expectedState !== undefined && this.worker.state !== options.expectedState) {
      throw new Error(`expected ${options.expectedState}`);
    }
    this.worker.state = state;
    this.transitions.push(state);
    return this.worker;
  }
}

const pullRequest = (headSha = "sha-1"): PullRequest => ({
  repository: { owner: "org", name: "repo", defaultBranch: "main" },
  number: 18,
  title: "DEV-18",
  sourceBranch: "agent/dev-18",
  targetBranch: "main",
  state: "open",
  headSha,
});

function workflow(fake: FakeState, calls: { decisions: ReviewDecision[]; continuations: ReviewSnapshot[] }) {
  return new ReviewWorkflow({
    state: fake,
    now: () => "2025-01-02T00:00:00.000Z",
    createSnapshotId: () => "snapshot-18",
    decisionPort: {
      changesRequested: (input) => {
        calls.decisions.push({
          workerId: input.workerId,
          pullRequestNumber: input.pullRequestNumber,
          state: "changes_requested",
          instructions: input.instructions,
          recordedAt: "2025-01-02T00:00:00.000Z",
        });
      },
    },
    continuePort: {
      continue: ({ snapshot }) => {
        calls.continuations.push(snapshot);
        return { readyForReview: true };
      },
    },
  });
}

test("creates an idempotent ready-for-review snapshot and transitions after PR readiness", async () => {
  const state = new FakeState();
  const calls = { decisions: [], continuations: [] } as { decisions: ReviewDecision[]; continuations: ReviewSnapshot[] };
  const review = workflow(state, calls);

  const first = await review.readyForReview({ workerId: "worker-a", containerId: "container-a", pullRequest: pullRequest() });
  const second = await review.readyForReview({ workerId: "worker-a", containerId: "container-a", pullRequest: pullRequest() });

  assert.equal(first.worker.state, "awaiting-review");
  assert.equal(first.snapshot.snapshotId, "snapshot-18");
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.deepEqual(state.transitions, ["awaiting-review"]);
});

test("records redacted changes, continues the same resources, and returns to review", async () => {
  const state = new FakeState();
  const calls = { decisions: [], continuations: [] } as { decisions: ReviewDecision[]; continuations: ReviewSnapshot[] };
  const review = workflow(state, calls);
  const ready = await review.readyForReview({ workerId: "worker-a", containerId: "container-a", pullRequest: pullRequest() });

  const result = await review.requestChanges({
    workerId: "worker-a",
    instructions: "Fix the token=super-secret issue",
    sensitiveValues: ["super-secret"],
  });

  assert.equal(result.decision.state, "changes_requested");
  assert.equal(result.decision.instructions, "Fix the token: [REDACTED] issue");
  assert.equal(calls.decisions.length, 1);
  assert.equal(calls.continuations[0], ready.snapshot);
  assert.equal(calls.continuations[0]?.containerId, "container-a");
  assert.equal(result.worker.state, "awaiting-review");
  assert.deepEqual(state.transitions, ["awaiting-review", "running", "awaiting-review"]);
});

test("protects invalid states and rejects automatic merge", async () => {
  const state = new FakeState();
  const calls = { decisions: [], continuations: [] } as { decisions: ReviewDecision[]; continuations: ReviewSnapshot[] };
  const review = workflow(state, calls);

  await assert.rejects(
    review.requestChanges({ workerId: "worker-a", instructions: "no snapshot yet" }),
    ReviewInvalidStateError,
  );
  assert.throws(() => review.merge(), AutomaticMergeRejectedError);
  assert.equal(redactReviewText("Bearer abc token=xyz"), "Bearer [REDACTED] token: [REDACTED]");
});
