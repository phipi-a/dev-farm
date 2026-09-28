import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CiStatus, PullRequestStatus } from "./models";

test("represents review and required-check state for the current head", () => {
  const ci: CiStatus = {
    state: "pending",
    checks: [
      {
        name: "test",
        state: "in_progress",
        required: true,
        description: "Tests are running",
      },
    ],
    requiredChecks: [
      {
        name: "test",
        state: "in_progress",
        required: true,
      },
    ],
  };
  const status: PullRequestStatus = {
    state: "open",
    ci,
    reviewState: "changes_requested",
    headSha: "abc123",
    mergeable: false,
  };

  assert.equal(status.state, "open");
  assert.equal(status.reviewState, "changes_requested");
  assert.equal(status.headSha, "abc123");
  assert.equal(status.ci.requiredChecks[0]?.required, true);
});
