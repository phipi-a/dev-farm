import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CiStatus, PullRequestStatus } from "./models";

test("represents pending CI alongside pull-request state", () => {
  const ci: CiStatus = {
    state: "pending",
    checks: [
      {
        name: "test",
        state: "in_progress",
        description: "Tests are running",
      },
    ],
  };
  const status: PullRequestStatus = { state: "open", ci, mergeable: true };

  assert.equal(status.state, "open");
  assert.equal(status.ci.checks[0]?.state, "in_progress");
});
