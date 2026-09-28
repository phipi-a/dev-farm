import { LinearClient } from "./client";
import { LINEAR_STATUS_BY_INTENT } from "./mapping";
import type { LinearTransport } from "./transport";
import type {
  LinearComment,
  LinearIssue,
  LinearIssueUpdateInput,
} from "./types";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class MemoryTransport implements LinearTransport {
  readonly updates: LinearIssueUpdateInput[] = [];
  readonly comments: string[] = [];
  issue: LinearIssue = {
    id: "issue-id",
    identifier: "DEV-4",
    title: "Implement Linear seam",
    status: { id: "status-id", name: "Todo" },
  };

  async getIssue(identifier: string): Promise<LinearIssue | null> {
    return identifier === this.issue.identifier ? this.issue : null;
  }

  async updateIssue(input: LinearIssueUpdateInput): Promise<LinearIssue> {
    this.updates.push(input);
    this.issue = {
      ...this.issue,
      status: { ...this.issue.status, name: input.status },
    };
    return this.issue;
  }

  async createComment(input: {
    identifier: string;
    body: string;
  }): Promise<LinearComment> {
    this.comments.push(input.body);
    return {
      id: `comment-${this.comments.length}`,
      issueIdentifier: input.identifier,
      body: input.body,
    };
  }
}

/** Dependency-free executable fixture for the seam's key invariants. */
export async function runLinearTests(): Promise<void> {
  assert(LINEAR_STATUS_BY_INTENT.todo === "Todo", "todo mapping");
  assert(
    LINEAR_STATUS_BY_INTENT["in-progress"] === "In Progress",
    "in-progress mapping",
  );
  assert(
    LINEAR_STATUS_BY_INTENT["in-review"] === "In Review",
    "in-review mapping",
  );
  assert(LINEAR_STATUS_BY_INTENT.done === "Done", "done mapping");
  assert(
    LINEAR_STATUS_BY_INTENT["changes-requested"] === "In Progress",
    "changes-requested mapping",
  );

  const transport = new MemoryTransport();
  const client = new LinearClient(transport);

  await client.applyUpdate({ identifier: "DEV-4", status: "in-review" });
  await client.applyUpdate({ identifier: "DEV-4", status: "in-review" });
  assert(transport.updates.length === 1, "same update intent must be idempotent");
  assert(transport.updates[0].identifier === "DEV-4", "update uses identifier");
  assert(transport.updates[0].status === "In Review", "update uses mapped status");

  const comment = await client.addComment({
    identifier: "DEV-4",
    body: "Review requested",
  });
  assert(comment.issueIdentifier === "DEV-4", "comment uses identifier");
  assert(transport.comments.length === 1, "comment is sent through transport");
}

void runLinearTests();
