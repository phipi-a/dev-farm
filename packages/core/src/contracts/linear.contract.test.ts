import test from "node:test";

import { LinearClient } from "../linear/client";
import { LinearIssueNotFoundError } from "../linear/transport";
import { FakeLinearTransport } from "./fakes";
import { assert, rejectsWith } from "./harness";

test("Linear contract: status mutation is idempotent", async () => {
  const transport = new FakeLinearTransport();
  const client = new LinearClient(transport);

  const first = await client.applyUpdate({ identifier: "DEV-25", status: "in-review" });
  const second = await client.applyUpdate({ identifier: "DEV-25", status: "in-review" });

  assert.equal(first.status.name, "In Review");
  assert.equal(second.status.name, "In Review");
  assert.equal(transport.updates.length, 1);
  assert.deepEqual(transport.updates[0], {
    identifier: "DEV-25",
    issueId: "issue-1",
    status: "In Review",
  });
});

test("Linear contract: missing issues are a typed, non-secret error", async () => {
  const client = new LinearClient(new FakeLinearTransport());
  const error = await rejectsWith(
    client.applyUpdate({ identifier: "DEV-404", status: "done" }),
    LinearIssueNotFoundError,
  );

  assert.equal(error.identifier, "DEV-404");
  assert.match(error.message, /^Linear issue not found: DEV-404$/);
});

test("Linear contract: adapter failures propagate without an implicit retry", async () => {
  const transport = new FakeLinearTransport();
  transport.failNextUpdate = new Error("request timed out");
  const client = new LinearClient(transport);

  await assert.rejects(
    client.applyUpdate({ identifier: "DEV-25", status: "done" }),
    /request timed out/,
  );
  assert.equal(transport.updates.length, 0);
});

test("Linear contract: comments use the issue identifier and preserve body", async () => {
  const transport = new FakeLinearTransport();
  const client = new LinearClient(transport);
  const body = "A review note that must not be rewritten";

  await client.addComment({ identifier: "DEV-25", body });

  assert.deepEqual(transport.comments, [{ identifier: "DEV-25", body }]);
});
