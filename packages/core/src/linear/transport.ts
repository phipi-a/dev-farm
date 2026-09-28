import type {
  LinearComment,
  LinearCommentInput,
  LinearIssue,
  LinearIssueUpdateInput,
} from "./types";

/**
 * The only I/O boundary used by the Linear client.
 *
 * This deliberately contains no GraphQL or HTTP types. Production code can
 * adapt the Linear API, while tests can provide an in-memory implementation.
 */
export interface LinearTransport {
  getIssue(identifier: string): Promise<LinearIssue | null>;
  updateIssue(input: LinearIssueUpdateInput): Promise<LinearIssue>;
  createComment(input: LinearCommentInput): Promise<LinearComment>;
}

export class LinearIssueNotFoundError extends Error {
  readonly identifier: string;

  constructor(identifier: string) {
    super(`Linear issue not found: ${identifier}`);
    this.name = "LinearIssueNotFoundError";
    this.identifier = identifier;
  }
}
