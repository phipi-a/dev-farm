import { statusForIntent, statusNeedsUpdate } from "./mapping";
import { LinearIssueNotFoundError } from "./transport";
import type { LinearTransport } from "./transport";
import type {
  LinearComment,
  LinearCommentInput,
  LinearIssue,
  LinearIssueIdentifier,
  LinearUpdateIntent,
} from "./types";

/** A small, transport-agnostic Linear integration seam. */
export class LinearClient {
  private readonly transport: LinearTransport;

  constructor(transport: LinearTransport) {
    this.transport = transport;
  }

  getIssue(identifier: LinearIssueIdentifier): Promise<LinearIssue | null> {
    return this.transport.getIssue(identifier);
  }

  /**
   * Applies a desired workflow state and skips an already-satisfied mutation.
   * This makes retries safe for both callers and queue workers.
   */
  async applyUpdate(intent: LinearUpdateIntent): Promise<LinearIssue> {
    const issue = await this.requireIssue(intent.identifier);
    const status = statusForIntent(intent.status);

    if (!statusNeedsUpdate(issue.status.name, intent.status)) {
      return issue;
    }

    return this.transport.updateIssue({
      identifier: issue.identifier,
      issueId: issue.id,
      status,
    });
  }

  /** Alias named after the operation represented by the intent. */
  updateIssue(intent: LinearUpdateIntent): Promise<LinearIssue> {
    return this.applyUpdate(intent);
  }

  async addComment(input: LinearCommentInput): Promise<LinearComment> {
    const issue = await this.requireIssue(input.identifier);
    return this.transport.createComment({
      identifier: issue.identifier,
      body: input.body,
    });
  }

  private async requireIssue(
    identifier: LinearIssueIdentifier,
  ): Promise<LinearIssue> {
    const issue = await this.transport.getIssue(identifier);
    if (issue === null) {
      throw new LinearIssueNotFoundError(identifier);
    }
    return issue;
  }
}

export function createLinearClient(transport: LinearTransport): LinearClient {
  return new LinearClient(transport);
}
